/**
 * 传输层：把一次请求经内核的 /api/network/forwardProxy 发出去，并按需要重试。
 *
 * 全部请求经 forwardProxy 发出：该端点在服务端用 Go 发起请求，
 * 因此不受浏览器同源策略限制，桌面端、移动端与浏览器端行为一致。
 * 代价是它要求管理员角色（发布服务访客为只读角色，必然 403）。
 *
 * 只实现非流式请求：插件一次只取一小段 JSON，流式带来的复杂度没有收益。
 * 各协议发什么、怎么读响应都在 protocol.ts，这里不认协议。
 */
import {fetchSyncPost} from "siyuan";
import {type ApiSettings, type BehaviorSettings} from "../config";
import {debug, debugError, debugModelText, debugRequest, debugResponse} from "../debug";
import {withCustomHeaders} from "./headers";
import {
    adapterFor,
    ApiError,
    EMPTY_CONTENT,
    type ChatParams,
    type ChatResult,
    type ProtocolAdapter,
} from "./protocol";
import {resolveApiSettings} from "./siyuan-provider";

// 错误类型、哨兵与结果类型由 api 层对外暴露：调用方只认 client.ts 这一个入口
export {ApiError, EMPTY_CONTENT} from "./protocol";
export type {ChatParams, ChatResult, ReasoningTrace} from "./protocol";

const PROXY_URL = "/api/network/forwardProxy";

/** 该错误是否表示「不认识 max_completion_tokens」，需要改用 max_tokens 重发。 */
function needsMaxTokensFallback(message: string): boolean {
    return message.includes("max_completion_tokens");
}

function parseRetryAfter(value: string | undefined): number | undefined {
    if (!value) {
        return undefined;
    }
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.round(seconds * 1000);
    }
    const date = Date.parse(value);
    if (!Number.isNaN(date)) {
        return Math.max(0, date - Date.now());
    }
    return undefined;
}

/**
 * 从任意形态的错误响应体里尽力取出可读信息。
 *
 * OpenAI 兼容端点与 Anthropic 都把可读信息放在 error.message 里，
 * 网关则常直接返回纯文本或 HTML，所以最后还有一层原文兜底。
 * 响应体为空时返回空串：状态码由 describeHttpError 统一拼上，
 * 在这里回填一遍只会拼出「HTTP 404: HTTP 404」这种什么都没多说的报错
 * （网关对不存在的路径常常就是空响应体加 404）。
 */
function extractErrorMessage(body: string): string {
    try {
        const parsed = JSON.parse(body) as {
            error?: {message?: string};
            message?: string;
            msg?: string;
        };
        const message = parsed.error?.message ?? parsed.message ?? parsed.msg;
        if (message) {
            return message;
        }
    } catch {
        // 网关返回 HTML 或纯文本时走下面的兜底
    }
    return body.trim().slice(0, 300);
}

/** HTTP 错误的一句话描述：有原文就附上，没有就只留状态码。 */
function describeHttpError(status: number, detail: string): string {
    return detail === "" ? `HTTP ${status}` : `HTTP ${status}: ${detail}`;
}

interface ProxyData {
    status?: number;
    body?: string;
    headers?: Record<string, string>;
}

interface ProxyResponse {
    status: number;
    body: string;
    headers: Record<string, string>;
}

function parseProxyData(response: {code: number; msg: string; data?: unknown}, url: string): ProxyResponse {
    if (response.code !== 0) {
        // 代理自身失败：地址非法、连接被拒、响应超过 32MiB 等
        throw new ApiError(`${response.msg || `forwardProxy failed with code ${response.code}`} (${url})`, false);
    }
    const data = (response.data ?? {}) as ProxyData;
    return {
        status: data.status ?? 0,
        body: typeof data.body === "string" ? data.body : JSON.stringify(data.body ?? ""),
        headers: data.headers ?? {},
    };
}

function buildProxyRequest(headers: Record<string, string>, timeout: number, extra: Record<string, unknown>) {
    return {
        ...extra,
        timeout,
        contentType: "application/json",
        // forwardProxy 要求 headers 是「单键对象数组」，不是普通 map
        headers: Object.entries(headers).map(([name, value]) => ({[name]: value})),
        responseEncoding: "text",
    };
}

/**
 * 本次请求实际发出的请求头：协议自带的鉴权头，加上配置里的自定义头（后者覆盖同名项）。
 *
 * 自定义头在这里才解析占位符 —— 变量可能刚被别的插件按会话改写，
 * 而且获取模型列表、测试连接与生成走的是同一条路径，不该有一处漏带（#24）。
 */
function requestHeaders(adapter: ProtocolAdapter, api: ApiSettings): Record<string, string> {
    return withCustomHeaders(adapter.headers(api), api);
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === wanted) {
            return value;
        }
    }
    return undefined;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 429 等 1s 起指数退避并加抖动；其余可重试错误立即重发。 */
function backoffMs(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) {
        return Math.min(retryAfterMs, 5000);
    }
    const base = Math.min(1000 * 2 ** attempt, 8000);
    return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * 按接口配置里的协议发一次请求并返回补全文本。
 *
 * 重试与 max_tokens 回退都在本次调用内消化完毕，不跨批次累积。
 * 注意 max_tokens 回退不消耗重试预算，否则等于白白丢掉一次重试机会。
 */
export async function chat(
    params: ChatParams,
    api: ApiSettings,
    behavior: BehaviorSettings,
): Promise<ChatResult> {
    // 「使用思源设置中供应商」在这里换成供应商的协议、地址、密钥与请求头（#27）：
    // 生成、测试连接与获取模型列表走的都是这条路径，不该有一处漏带
    const target = resolveApiSettings(api);
    const adapter = adapterFor(target.protocol);
    const url = adapter.completionURL(target.baseURL);
    const maxAttempts = Math.max(1, behavior.retries + 1);
    let useMaxCompletionTokens = true;
    let lastError: ApiError = new ApiError("No attempt was made", false);
    let attempt = 0;

    while (attempt < maxAttempts) {
        let response: ProxyResponse;
        try {
            const payload = adapter.payload(params, target, {useMaxCompletionTokens});
            debugRequest(url, payload, [
                {role: "system", content: params.system},
                {role: "user", content: params.user},
            ]);
            const request = buildProxyRequest(requestHeaders(adapter, target), behavior.timeout, {
                url,
                method: "POST",
                payload,
                payloadEncoding: "json",
            });
            response = parseProxyData(await fetchSyncPost(PROXY_URL, request), url);
            debugResponse(url, response.status, response.body);
        } catch (error) {
            const apiError = error instanceof ApiError ? error : new ApiError(String(error), true);
            debugError("Request failed", apiError);
            attempt++;
            if (!apiError.retryable || attempt >= maxAttempts) {
                throw apiError;
            }
            const wait = backoffMs(attempt, apiError.retryAfterMs);
            debug(`Retrying in ${wait}ms (attempt ${attempt + 1}/${maxAttempts})`);
            lastError = apiError;
            await sleep(wait);
            continue;
        }

        if (response.status >= 400) {
            const retryAfter = parseRetryAfter(headerValue(response.headers, "retry-after"));
            const detail = extractErrorMessage(response.body);
            const error = new ApiError(describeHttpError(response.status, detail), false, retryAfter);
            // 408/409/429/5xx 可重试，其余 4xx 是配置或请求本身的问题，重发无意义
            const retryable = response.status === 408 || response.status === 409 ||
                response.status === 429 || response.status >= 500;

            if (useMaxCompletionTokens && response.status === 400 && needsMaxTokensFallback(detail)) {
                // 不消耗重试预算：这是供应商字段名差异，不是一次失败尝试
                debug("Provider rejected max_completion_tokens, retrying with max_tokens");
                useMaxCompletionTokens = false;
                continue;
            }

            attempt++;
            if (!retryable || attempt >= maxAttempts) {
                debugError(`Request failed with HTTP ${response.status}`, error);
                throw error;
            }
            const wait = backoffMs(attempt, retryAfter);
            debug(`HTTP ${response.status}, retrying in ${wait}ms (attempt ${attempt + 1}/${maxAttempts})`);
            lastError = error;
            await sleep(wait);
            continue;
        }

        const {text, reasoning} = adapter.parse(response.body);
        debugModelText(text);
        if (text !== "") {
            return {text, reasoning};
        }
        // 返回体合法但没有文本，多半是推理耗尽了输出预算，重发无意义
        debugError("Response contained no text", response.body);
        throw new ApiError(EMPTY_CONTENT, false);
    }

    throw lastError;
}

/** 拉取供应商的模型列表，用于设置页的「获取模型列表」。 */
export async function listModels(api: ApiSettings, timeout: number): Promise<string[]> {
    const target = resolveApiSettings(api);
    const adapter = adapterFor(target.protocol);
    const url = adapter.modelsURL(target.baseURL);
    const request = buildProxyRequest(requestHeaders(adapter, target), timeout, {url, method: "GET"});
    const response = parseProxyData(await fetchSyncPost(PROXY_URL, request), url);
    if (response.status >= 400) {
        throw new Error(describeHttpError(response.status, extractErrorMessage(response.body)));
    }
    // 列表的包装层各协议不一样（data / models），解析交给适配器
    return adapter.parseModels(response.body);
}

/**
 * 测试连接：让模型回一个 "hi"，只要拿得到文本就算通过。
 *
 * 请求参数原样取自设置页，包括模型、思考强度与采样参数：只测「能不能连上」
 * 而把参数换成一套安全的默认值，结果是连接测通了、真跑生成时照样 400。
 * 唯一不动的是重试次数 —— 测试要的是立刻暴露问题。
 * 返回耗时毫秒数，提示文案由 UI 层拼装。
 */
export async function testConnection(api: ApiSettings, behavior: BehaviorSettings): Promise<{reply: string; elapsed: number}> {
    const started = Date.now();
    const result = await chat(
        {
            system: "You are a connectivity check. Reply with exactly: hi",
            user: "hi",
        },
        api,
        {...behavior, retries: 0},
    );
    return {reply: result.text.slice(0, 40), elapsed: Date.now() - started};
}
