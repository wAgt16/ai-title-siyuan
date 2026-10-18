/**
 * 各生成协议的请求构造与响应解析。
 *
 * 插件只做一件事：发一次非流式请求，取回一段纯文本。所以这里不做完整协议建模，
 * 每个协议只写四件必须各写一份的事 —— 请求地址、鉴权头、请求体、响应取文本。
 * 传输（forwardProxy、重试、错误归类）与协议无关，留在 client.ts。
 *
 * 参数不适用于当前协议时一律**不发**：一是严格校验的端点会直接 400，
 * 二是被静默忽略的字段会让用户以为设置生效了（旧版的「思考开关」就是这么失效的）。
 */
import {
    PROTOCOL_ANTHROPIC_MESSAGES,
    PROTOCOL_GEMINI_INTERACTIONS,
    PROTOCOL_RESPONSES,
    REASONING_DEFAULT,
    REASONING_EFFORT_FIELD,
    REASONING_EFFORT_OFF,
    THINKING_CUSTOM,
    THINKING_DISABLED,
    type AdapterProtocol,
    type ApiSettings,
    type ReasoningEffort,
} from "../config";

/** 一次请求用的两条提示词。各协议把它们放在不同位置（messages / instructions / system）。 */
export interface ChatParams {
    system: string;
    user: string;
}

/** 一次响应里模型仍然产生的推理痕迹。 */
export interface ReasoningTrace {
    /** 思维链文本，供应商把它放在回复结构里时取到；只报数不返文本时为空串。 */
    text: string;
    /** 供应商自报的推理 token 数，只有带 usage 明细的响应才给得出。 */
    tokens: number | undefined;
}

export interface ChatResult {
    text: string;
    /** 本次响应里仍带有推理内容时的痕迹，没有则为 undefined。 */
    reasoning?: ReasoningTrace;
}

export class ApiError extends Error {
    constructor(
        message: string,
        /** 是否值得重试。全部 4xx（除 408/409/429）都不可重试。 */
        readonly retryable: boolean,
        readonly retryAfterMs?: number,
    ) {
        super(message);
        this.name = "ApiError";
    }
}

/** 响应合法但没有文本内容时的哨兵错误，UI 据此给出「推理耗尽预算」的提示。 */
export const EMPTY_CONTENT = "EMPTY_CONTENT";

/**
 * 构造请求体时可以偏离默认写法的一处开关。
 *
 * 只有 Chat Completions 用得上：输出上限字段历史上有两个名字，
 * 而供应商支持哪个只能靠试（见 client.ts 的回退逻辑）。
 */
export interface PayloadOptions {
    /** 上限字段发 max_completion_tokens 还是 max_tokens。 */
    useMaxCompletionTokens: boolean;
}

export interface ProtocolAdapter {
    /** 补全请求的地址。 */
    completionURL(baseURL: string): string;
    /** 模型列表的地址，用于设置页的「获取模型列表」。 */
    modelsURL(baseURL: string): string;
    /** 本次请求要带的全部请求头，含鉴权。 */
    headers(api: ApiSettings): Record<string, string>;
    /** 请求体。 */
    payload(params: ChatParams, api: ApiSettings, options: PayloadOptions): Record<string, unknown>;
    /** 响应体 → 补全文本与推理痕迹。文本为空串表示响应合法但没有内容。 */
    parse(body: string): ChatResult;
    /** 模型列表响应 → 模型名列表。各协议的包装层不一样，只有字段名不同。 */
    parseModels(body: string): string[];
}

/** 去掉结尾斜杠，避免拼出 `//chat/completions`。 */
function trimBase(baseURL: string): string {
    return baseURL.trim().replace(/\/+$/, "");
}

/**
 * 取主机名，用于少数需要按端点决定请求体的字段。
 * 导出去是因为自定义请求头也要按目标主机决定密钥是否插值（见 headers.ts）。
 */
export function hostOf(baseURL: string): string {
    try {
        return new URL(baseURL.trim()).hostname.toLowerCase();
    } catch {
        // 地址还没填全时不是错误：请求本身会在接下来的校验里失败
        return "";
    }
}

function bearerHeaders(api: ApiSettings): Record<string, string> {
    const apiKey = api.apiKey.trim();
    return apiKey === "" ? {} : {Authorization: `Bearer ${apiKey}`};
}

/** 取第一条非空文本。候选按优先级排好：content 空时供应商常把输出放在推理字段里。 */
function firstText(candidates: (string | null | undefined)[]): string {
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim() !== "") {
            return candidate.trim();
        }
    }
    return "";
}

function parseBody<T>(body: string): T {
    try {
        return JSON.parse(body) as T;
    } catch {
        throw new ApiError(`Response is not valid JSON: ${body.trim().slice(0, 300)}`, false);
    }
}

function positiveNumber(value: unknown): number | undefined {
    return typeof value === "number" && value > 0 ? value : undefined;
}

/** 响应带了推理痕迹就返回，否则 undefined。 */
function trace(text: string, tokens: number | undefined): ReasoningTrace | undefined {
    return text === "" && tokens === undefined ? undefined : {text, tokens};
}

/* ---------------------------------- Chat Completions ---------------------------------- */

/**
 * 思考强度的请求体字段。
 *
 * 这是唯一一处写 reasoning_effort 的地方，理由见 config.ts 的 REASONING_EFFORT_FIELD。
 * 副作用是：供应商若不认这个参数且不容忍未知字段，会直接 400。
 * 那种情况用户是能看见的（报错原文会原样展示），比下面 thinkingFields 那种
 * 「发出去、被静默忽略、看起来一切正常」的失败好得多。
 */
function reasoningFields(api: ApiSettings): Record<string, unknown> {
    return api.reasoningEffort === REASONING_DEFAULT ? {} : {[REASONING_EFFORT_FIELD]: api.reasoningEffort};
}

/**
 * @deprecated 旧版「从 JSON 片段里挑一条」的取值解析。已撤出界面，且**不再调用**。
 *
 * 单独留在这里而不是删掉：恢复旧下拉时把它加回下面 payload 里 Object.assign 那一行即可。
 * 之所以要摘掉调用，是因为这两条路径并存时，请求体里发什么取决于两个地方
 * （mergeSettings 负责清旧值、payload 负责拼字段），而 extra_body 那个
 * 静默失效的 bug 正是这样活下来的。现在只有 reasoningFields 一个出口。
 *
 * 导出是为了让它不被 noUnusedLocals 判成死代码。
 */
export function thinkingFields(api: ApiSettings): Record<string, unknown> {
    const raw = api.disableThinking === THINKING_CUSTOM ? api.customThinking : api.disableThinking;
    if (!raw || raw === THINKING_DISABLED) {
        return {};
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new ApiError(
            `Invalid "disable thinking" JSON: ${raw} (${error instanceof Error ? error.message : String(error)})`,
            false,
        );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ApiError(`"disable thinking" must be a JSON object, got: ${raw}`, false);
    }
    return parsed as Record<string, unknown>;
}

function chatPayload(params: ChatParams, api: ApiSettings, options: PayloadOptions): Record<string, unknown> {
    const payload: Record<string, unknown> = {
        model: api.model.trim(),
        messages: [
            {role: "system", content: params.system},
            {role: "user", content: params.user},
        ],
        temperature: api.temperature,
        stream: false,
    };
    if (api.topP !== null && api.topP !== undefined) {
        payload.top_p = api.topP;
    }
    // top_k 留空就不发送：OpenAI 官方接口对未识别参数直接返回 400。
    if (api.topK !== null && api.topK !== undefined) {
        payload.top_k = api.topK;
    }
    if (api.maxTokens > 0) {
        // max_tokens 已被 OpenAI 标记废弃，但大量兼容服务只认它，所以留好回退路径。
        payload[options.useMaxCompletionTokens ? "max_completion_tokens" : "max_tokens"] = api.maxTokens;
    }
    return Object.assign(payload, reasoningFields(api));
}

interface ChatCompletionResponse {
    choices?: {
        message?: {
            content?: string | null;
            reasoning_content?: string | null;
            reasoning?: string | null;
        };
    }[];
    usage?: {
        completion_tokens_details?: {reasoning_tokens?: number};
    };
}

function chatParse(body: string): ChatResult {
    const parsed = parseBody<ChatCompletionResponse>(body);
    const message = parsed.choices?.[0]?.message;
    if (!message) {
        throw new ApiError("Response contains no choices", false);
    }
    // content 为空时回退到推理字段：部分推理模型的全部输出会落在
    // reasoning_content / reasoning 里，content 保持为空。
    const text = firstText([message.content, message.reasoning_content, message.reasoning]);
    const reasoning = firstText([message.reasoning_content, message.reasoning]);
    return {
        text,
        reasoning: trace(reasoning, positiveNumber(parsed.usage?.completion_tokens_details?.reasoning_tokens)),
    };
}

/* ------------------------------------ Responses API ------------------------------------ */

/**
 * 明确要求不留存响应的端点。
 *
 * Responses 的 store 默认是 true（响应在服务端留 30 天），而插件发出去的是用户笔记正文。
 * 名单取自思源自己的实现（kernel/util/openai_completion.go），只对已知默认开启留存的主机发
 * store:false —— 其余端点不带这个字段，免得被严格校验的网关当成未知参数拒掉。
 */
const STORE_FALSE_HOSTS = new Set([
    "api.openai.com",
    "openrouter.ai",
    "dashscope.aliyuncs.com",
    "dashscope-intl.aliyuncs.com",
    "ark.cn-beijing.volces.com",
]);

function responsesPayload(params: ChatParams, api: ApiSettings): Record<string, unknown> {
    const payload: Record<string, unknown> = {
        model: api.model.trim(),
        // 系统提示词走顶层 instructions，input 里只放对话轮次
        instructions: params.system,
        input: [{role: "user", content: [{type: "input_text", text: params.user}]}],
        temperature: api.temperature,
        stream: false,
    };
    if (api.topP !== null && api.topP !== undefined) {
        payload.top_p = api.topP;
    }
    // top_k 不发：Responses 没有这个字段
    if (api.maxTokens > 0) {
        payload.max_output_tokens = api.maxTokens;
    }
    if (api.reasoningEffort !== REASONING_DEFAULT) {
        // 档位与 Chat Completions 的 reasoning_effort 是同一套，只是换成了嵌套字段
        payload.reasoning = {effort: api.reasoningEffort};
    }
    if (STORE_FALSE_HOSTS.has(hostOf(api.baseURL))) {
        payload.store = false;
    }
    return payload;
}

interface ResponsesResponse {
    status?: string;
    error?: {message?: string};
    output?: {
        type?: string;
        content?: {type?: string; text?: string; refusal?: string}[];
        summary?: {text?: string}[];
    }[];
    usage?: {
        output_tokens_details?: {reasoning_tokens?: number};
    };
}

/**
 * 从 output 数组里取文本。
 *
 * 一次响应可能同时有条目类型为 reasoning、message 甚至 function_call 的元素，
 * 只有 message 里的 output_text 才是回答；拒答则落在 content 的 refusal 上。
 * 推理摘要单独收集：它不算回答，但要能报出「禁用思考没生效」。
 */
function responsesParse(body: string): ChatResult {
    const parsed = parseBody<ResponsesResponse>(body);
    if (parsed.error?.message) {
        // HTTP 200 也可能带回失败的响应体
        throw new ApiError(parsed.error.message, false);
    }

    let text = "";
    let refusal = "";
    let reasoning = "";
    for (const item of parsed.output ?? []) {
        if (item.type === "reasoning") {
            for (const part of item.summary ?? []) {
                reasoning += part.text ?? "";
            }
            continue;
        }
        if (item.type !== "message") {
            continue;
        }
        for (const part of item.content ?? []) {
            if (part.type === "output_text") {
                text += part.text ?? "";
            } else if (part.type === "refusal") {
                refusal += part.refusal ?? "";
            }
        }
    }

    // 拒答时返回的是模型原话，比「模型没有返回文本」这种猜测更有用；
    // 两者都没有才回退到推理摘要，与 Chat Completions 的处理一致。
    const traceText = reasoning.trim();
    const answer = firstText([text, refusal, traceText]);
    return {
        text: answer,
        reasoning: trace(traceText, positiveNumber(parsed.usage?.output_tokens_details?.reasoning_tokens)),
    };
}

/* --------------------------------- Anthropic Messages --------------------------------- */

const ANTHROPIC_VERSION = "2023-06-01";

/** Messages 必须指定输出上限，用户把它留空时用这个保守值（与思源取的一致）。 */
const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

/** 思考预算的下限，接口硬性要求。 */
const ANTHROPIC_MIN_THINKING_BUDGET = 1024;

/**
 * 仍然使用「手动思考预算」的 Claude 型号。
 *
 * Anthropic 的思考配置换过两次，两套互不认识：4.6 之前是
 * thinking:{type:"enabled",budget_tokens}，4.7 起改成 thinking:{type:"adaptive"}
 * 加 output_config.effort —— 旧型号遇到 adaptive 报 400，新型号遇到 enabled 也报 400。
 * 名单照搬思源自己维护的那份（kernel/util/anthropic.go 的 anthropicLegacyThinking）。
 */
const ANTHROPIC_MANUAL_THINKING_MODELS = [
    "claude-3-7",
    "claude-sonnet-4-5",
    "claude-opus-4-5",
    "claude-haiku-4-5",
    "claude-opus-4-1",
    "claude-sonnet-4-202",
    "claude-opus-4-202",
];

function anthropicManualThinking(model: string): boolean {
    const lower = model.toLowerCase();
    return ANTHROPIC_MANUAL_THINKING_MODELS.some((prefix) => lower.includes(prefix)) ||
        lower === "claude-sonnet-4" || lower === "claude-opus-4";
}

/**
 * 该型号是否还接受 temperature / top_p / top_k。
 *
 * 4.7 起这些参数要么被忽略，要么直接让请求 400（Sonnet 5 就明确拒绝），
 * 所以只对旧型号与第三方 Messages 兼容端点发送。判定取自思源
 * （kernel/util/anthropic.go 的 anthropicFixedSampling 的反面），认不出来的
 * 新名字一律按「不接受」处理 —— 少发一个参数只会让标题更稳定。
 */
function anthropicAcceptsSampling(model: string): boolean {
    const lower = model.toLowerCase();
    if (!lower.includes("claude-")) {
        return true;
    }
    return lower.includes("claude-3") || lower.includes("-4-6") || anthropicManualThinking(lower);
}

/** 思考强度 → 手动预算。最低一档就是接口下限，最高一档与思源取同一个值。 */
const ANTHROPIC_THINKING_BUDGETS: Record<string, number> = {
    low: 1024,
    medium: 4096,
    high: 8192,
    xhigh: 16384,
    max: 32768,
};

interface AnthropicReasoning {
    /** thinking 字段。「默认」档不产出，整个字段都不发。 */
    thinking?: Record<string, unknown>;
    /** adaptive 模式下控制思考深度的 effort。 */
    effort?: string;
    /** 模型是否真的会思考：开启思考与采样参数互斥，一起发会被直接拒绝。 */
    active: boolean;
}

function anthropicReasoning(api: ApiSettings, model: string, maxTokens: number): AnthropicReasoning {
    const effort = api.reasoningEffort;
    if (effort === REASONING_DEFAULT) {
        return {active: false};
    }
    if (effort === REASONING_EFFORT_OFF) {
        // 「禁用」是明确要求不推理。新型号可能已经不允许关闭，
        // 那种情况由接口原样报错，比这里猜一个折中值更好查
        return {thinking: {type: "disabled"}, active: false};
    }
    if (anthropicManualThinking(model)) {
        // 思考预算算在输出上限里，为可见的那段回答留一半
        const budget = Math.min(ANTHROPIC_THINKING_BUDGETS[effort], Math.floor(maxTokens / 2));
        if (budget < ANTHROPIC_MIN_THINKING_BUDGET) {
            throw new ApiError(
                `Anthropic thinking needs an output token limit of at least ${ANTHROPIC_MIN_THINKING_BUDGET * 2} ` +
                `(currently ${maxTokens}). Raise "max output tokens" or pick the default thinking effort.`,
                false,
            );
        }
        return {thinking: {type: "enabled", budget_tokens: budget}, active: true};
    }
    // 4.7 起思考深度由 effort 控制，budget_tokens 已废弃
    return {thinking: {type: "adaptive"}, effort, active: true};
}

/**
 * Messages 的资源地址。
 *
 * 与 Anthropic SDK 一致：地址已经带 /v1 时只追加资源名，否则补一个 /v1 ——
 * 两种写法在供应商文档里都能见到（api.anthropic.com/v1、api.deepseek.com/anthropic）。
 */
function anthropicURL(baseURL: string, resource: string): string {
    const base = trimBase(baseURL);
    return /\/v1$/i.test(base) ? `${base}/${resource}` : `${base}/v1/${resource}`;
}

function anthropicHeaders(api: ApiSettings): Record<string, string> {
    const headers: Record<string, string> = {"anthropic-version": ANTHROPIC_VERSION};
    const apiKey = api.apiKey.trim();
    if (apiKey !== "") {
        // 与思源一致：OpenRouter 的 Messages 入口只认 Authorization，
        // Anthropic 自家与其余兼容端点都用 x-api-key
        if (hostOf(api.baseURL) === "openrouter.ai") {
            headers.Authorization = `Bearer ${apiKey}`;
        } else {
            headers["x-api-key"] = apiKey;
        }
    }
    return headers;
}

function anthropicPayload(params: ChatParams, api: ApiSettings): Record<string, unknown> {
    const model = api.model.trim();
    const maxTokens = api.maxTokens > 0 ? api.maxTokens : ANTHROPIC_DEFAULT_MAX_TOKENS;
    const payload: Record<string, unknown> = {
        model,
        // 与其他两个协议不同，这个字段是必填的
        max_tokens: maxTokens,
        system: params.system,
        messages: [{role: "user", content: [{type: "text", text: params.user}]}],
        stream: false,
    };

    const reasoning = anthropicReasoning(api, model, maxTokens);
    if (reasoning.thinking) {
        payload.thinking = reasoning.thinking;
    }
    if (reasoning.effort) {
        payload.output_config = {effort: reasoning.effort};
    }
    // 开启思考时 temperature 只能为 1、top_p 与 top_k 同样受限，所以整组都不发；
    // 关了思考（或本来就没开）时，再按型号决定发不发
    if (!reasoning.active && anthropicAcceptsSampling(model)) {
        // Messages 只接受 0 到 1，而设置页为了 OpenAI 允许填到 2
        payload.temperature = Math.min(1, Math.max(0, api.temperature));
        if (api.topP !== null && api.topP !== undefined) {
            payload.top_p = api.topP;
        }
        if (api.topK !== null && api.topK !== undefined) {
            payload.top_k = Math.round(api.topK);
        }
    }
    return payload;
}

interface AnthropicResponse {
    content?: {type?: string; text?: string; thinking?: string}[];
    usage?: {
        output_tokens_details?: {thinking_tokens?: number};
    };
}

function anthropicParse(body: string): ChatResult {
    const parsed = parseBody<AnthropicResponse>(body);
    if (!Array.isArray(parsed.content)) {
        throw new ApiError("Response contains no content blocks", false);
    }
    let text = "";
    let reasoning = "";
    for (const block of parsed.content) {
        if (block.type === "text") {
            text += block.text ?? "";
        } else if (block.type === "thinking") {
            reasoning += block.thinking ?? "";
        }
    }
    // 与 Chat Completions 一致：content 为空时回退到思考块，
    // 有些型号会把全部输出都留在思考里
    const traceText = reasoning.trim();
    return {
        text: firstText([text, traceText]),
        reasoning: trace(traceText, positiveNumber(parsed.usage?.output_tokens_details?.thinking_tokens)),
    };
}

/* ---------------------------------- Gemini Interactions ---------------------------------- */

/**
 * Interactions 的资源地址。
 *
 * 与 Messages 的处理一致：地址已经带版本段（/v1beta 或 /v1）时只追加资源名，
 * 否则补一个 /v1beta —— 官方地址是
 * https://generativelanguage.googleapis.com/v1beta/interactions，
 * 自建网关也常要求填到 /v1beta 为止。
 */
function geminiURL(baseURL: string, resource: string): string {
    const base = trimBase(baseURL);
    return /\/v1(beta)?$/i.test(base) ? `${base}/${resource}` : `${base}/v1beta/${resource}`;
}

function geminiHeaders(api: ApiSettings): Record<string, string> {
    const apiKey = api.apiKey.trim();
    // Gemini 只认这个头；它同时也支持 ?key= 查询参数，但把密钥写进 URL 会进日志
    return apiKey === "" ? {} : {"x-goog-api-key": apiKey};
}

/** 思考强度档位远多于 Interactions 的四档，多出来的并入相邻档。 */
function geminiThinkingLevel(effort: ReasoningEffort): "minimal" | "low" | "medium" | "high" {
    switch (effort) {
        case "low":
            return "low";
        case "medium":
            return "medium";
        case REASONING_EFFORT_OFF:
            // 这个接口没有「关闭」档：minimal 是「几乎不思考」，也是最接近的一档。
            // 真的还在推理时，生成结束后的「禁用思考未生效」提示会把它报出来。
            return "minimal";
        default:
            // high / xhigh / max 都并入最高档
            return "high";
    }
}

function geminiPayload(params: ChatParams, api: ApiSettings): Record<string, unknown> {
    // 采样参数与输出上限都收在 generation_config 里，不再平铺在顶层
    const generationConfig: Record<string, unknown> = {temperature: api.temperature};
    if (api.topP !== null && api.topP !== undefined) {
        generationConfig.top_p = api.topP;
    }
    // top_k 不发：Interactions 的 generation_config 里没有这个字段
    if (api.maxTokens > 0) {
        generationConfig.max_output_tokens = api.maxTokens;
    }
    if (api.reasoningEffort !== REASONING_DEFAULT) {
        generationConfig.thinking_level = geminiThinkingLevel(api.reasoningEffort);
    }
    return {
        model: api.model.trim(),
        // 文本输入允许直接给字符串，不必包成 content 数组
        input: params.user,
        // 系统提示词是单独的顶层字段，不在 input 里
        system_instruction: params.system,
        // 默认会留存请求与响应（供 previous_interaction_id 使用），而这里发出去的是笔记正文。
        // 插件每次都是独立的一次调用，用不上服务端状态，所以显式关掉。
        store: false,
        generation_config: generationConfig,
    };
}

interface GeminiInteractionResponse {
    status?: string;
    error?: {message?: string};
    steps?: {
        type?: string;
        content?: {type?: string; text?: string}[];
        /** 思考步骤把摘要放在这里，没有 content 数组。 */
        summary?: {type?: string; text?: string};
    }[];
    usage?: {total_thought_tokens?: number};
}

/**
 * 从 steps 里取文本。
 *
 * 一次响应可能同时有 thought、model_output 甚至 function_call 步骤，
 * 只有 model_output 里的 text 块才是回答。思考摘要单独收集：它不算回答，
 * 但要能报出「禁用思考没生效」。
 */
function geminiParse(body: string): ChatResult {
    const parsed = parseBody<GeminiInteractionResponse>(body);
    if (parsed.error?.message) {
        // HTTP 200 也可能带回失败的 interaction
        throw new ApiError(parsed.error.message, false);
    }
    if (parsed.status === "failed") {
        throw new ApiError("The interaction failed without an error message", false);
    }

    let text = "";
    let reasoning = "";
    for (const step of parsed.steps ?? []) {
        if (step.type === "thought") {
            if (step.summary?.type === "text") {
                reasoning += step.summary.text ?? "";
            }
            continue;
        }
        if (step.type !== "model_output") {
            continue;
        }
        for (const part of step.content ?? []) {
            if (part.type === "text") {
                text += part.text ?? "";
            }
        }
    }

    // 与另外两个协议一致：回答为空时回退到思考摘要，
    // 只有思考模式的模型会把全部输出留在那里
    const traceText = reasoning.trim();
    return {
        text: firstText([text, traceText]),
        reasoning: trace(traceText, positiveNumber(parsed.usage?.total_thought_tokens)),
    };
}

/* -------------------------------------- 模型列表 -------------------------------------- */

function parseModelsJSON<T>(body: string): T {
    try {
        return JSON.parse(body) as T;
    } catch {
        throw new Error(`Response is not valid JSON: ${body.trim().slice(0, 200)}`);
    }
}

/** Chat Completions、Responses 与 Messages 的模型列表都是 `{data: [{id}]}`。 */
function dataModelNames(body: string): string[] {
    const parsed = parseModelsJSON<{data?: {id?: string}[]}>(body);
    // 兼容服务可能不实现 /models，或省略 id 字段
    return (parsed.data ?? [])
        .map((item) => item.id)
        .filter((id): id is string => typeof id === "string" && id !== "");
}

/** Interactions 的模型列表是 `{models: [{name: "models/gemini-…"}]}`，名字带前缀。 */
function geminiModelNames(body: string): string[] {
    const parsed = parseModelsJSON<{models?: {name?: string}[]}>(body);
    return (parsed.models ?? [])
        .map((item) => (item.name ?? "").trim().replace(/^models\//, ""))
        .filter((name) => name !== "");
}

/* ------------------------------------- 协议分发 ------------------------------------- */

const chatCompletions: ProtocolAdapter = {
    completionURL: (baseURL) => `${trimBase(baseURL)}/chat/completions`,
    modelsURL: (baseURL) => `${trimBase(baseURL)}/models`,
    headers: bearerHeaders,
    payload: chatPayload,
    parse: chatParse,
    parseModels: dataModelNames,
};

const responses: ProtocolAdapter = {
    completionURL: (baseURL) => `${trimBase(baseURL)}/responses`,
    modelsURL: (baseURL) => `${trimBase(baseURL)}/models`,
    headers: bearerHeaders,
    payload: responsesPayload,
    parse: responsesParse,
    parseModels: dataModelNames,
};

const anthropic: ProtocolAdapter = {
    completionURL: (baseURL) => anthropicURL(baseURL, "messages"),
    // 模型清单默认一页 20 条，设置页只要一次列全
    modelsURL: (baseURL) => `${anthropicURL(baseURL, "models")}?limit=1000`,
    headers: anthropicHeaders,
    payload: anthropicPayload,
    parse: anthropicParse,
    parseModels: dataModelNames,
};

const gemini: ProtocolAdapter = {
    completionURL: (baseURL) => geminiURL(baseURL, "interactions"),
    // 与 Messages 一样一次列全：默认一页只有 50 条
    modelsURL: (baseURL) => `${geminiURL(baseURL, "models")}?pageSize=1000`,
    headers: geminiHeaders,
    payload: geminiPayload,
    parse: geminiParse,
    parseModels: geminiModelNames,
};

export function adapterFor(protocol: AdapterProtocol): ProtocolAdapter {
    switch (protocol) {
        case PROTOCOL_RESPONSES:
            return responses;
        case PROTOCOL_ANTHROPIC_MESSAGES:
            return anthropic;
        case PROTOCOL_GEMINI_INTERACTIONS:
            return gemini;
        default:
            // 配置里的「使用思源设置中供应商」在 resolveApiSettings 里已经换成了供应商标明的协议，
            // 走不到这里；留着默认分支只是为了覆盖 Chat Completions 这一种合法取值
            return chatCompletions;
    }
}
