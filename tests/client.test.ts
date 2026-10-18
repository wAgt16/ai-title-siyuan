import {beforeEach, describe, expect, it} from "vitest";
import {
    DEFAULT_SETTINGS,
    PROTOCOL_ANTHROPIC_MESSAGES,
    PROTOCOL_CHAT_COMPLETIONS,
    PROTOCOL_GEMINI_INTERACTIONS,
    PROTOCOL_RESPONSES,
    type ApiSettings,
    type BehaviorSettings,
} from "../src/config";
import {ApiError, chat, EMPTY_CONTENT, listModels, testConnection} from "../src/api/client";
import {setFetchSyncPost} from "./stubs/siyuan";

/** 一次 forwardProxy 调用里插件真正发出去的东西。 */
interface ProxyCall {
    url: string;
    method: string;
    headers: {[name: string]: string}[];
    payload?: Record<string, unknown>;
}

let calls: ProxyCall[] = [];

function reply(status: number, body: string, headers: Record<string, string> = {}): unknown {
    return {code: 0, msg: "", data: {status, body, headers}};
}

/** 按顺序返回准备好的响应，并记下每次实际发出去的请求。 */
function stubReplies(...replies: unknown[]): void {
    let index = 0;
    setFetchSyncPost((_url, data) => {
        calls.push(data as ProxyCall);
        return Promise.resolve(replies[Math.min(index++, replies.length - 1)]);
    });
}

// 协议必须写死：默认值是「使用思源设置中供应商」，那条路要宿主里真的有供应商才能解析
const API: ApiSettings = {
    ...DEFAULT_SETTINGS.api,
    protocol: PROTOCOL_CHAT_COMPLETIONS,
    baseURL: "https://api.openai.com/v1",
    apiKey: "sk-test",
    model: "gpt-5.1",
};
const NO_RETRY: BehaviorSettings = {...DEFAULT_SETTINGS.behavior, retries: 0};
const PARAMS = {system: "SYS", user: "USER"};
const OK_BODY = '{"choices":[{"message":{"content":"Title"}}]}';

beforeEach(() => {
    calls = [];
    setFetchSyncPost(() => Promise.reject(new Error("fetchSyncPost was not stubbed for this test")));
});

describe("chat 的请求与响应（#8 #20 的三种协议都走同一条传输路径）", () => {
    it("Chat Completions：发到 /chat/completions，取回文本", async () => {
        stubReplies(reply(200, OK_BODY));
        const result = await chat(PARAMS, API, NO_RETRY);
        expect(result.text).toBe("Title");
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
        expect(calls[0].method).toBe("POST");
        expect(calls[0].headers).toEqual([{Authorization: "Bearer sk-test"}]);
        expect(calls[0].payload?.messages).toEqual([
            {role: "system", content: "SYS"},
            {role: "user", content: "USER"},
        ]);
    });

    it("Responses：发到 /responses 并解析 output（#8）", async () => {
        stubReplies(reply(200, JSON.stringify({
            output: [{type: "message", content: [{type: "output_text", text: "Title"}]}],
        })));
        const result = await chat(PARAMS, {...API, protocol: PROTOCOL_RESPONSES}, NO_RETRY);
        expect(result.text).toBe("Title");
        expect(calls[0].url).toBe("https://api.openai.com/v1/responses");
        expect(calls[0].payload).toHaveProperty("instructions", "SYS");
    });

    it("Messages：发到 /v1/messages 并带上 x-api-key（#20）", async () => {
        stubReplies(reply(200, JSON.stringify({content: [{type: "text", text: "Title"}]})));
        const target: ApiSettings = {...API, protocol: PROTOCOL_ANTHROPIC_MESSAGES, baseURL: "https://api.anthropic.com/v1"};
        const result = await chat(PARAMS, target, NO_RETRY);
        expect(result.text).toBe("Title");
        expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
        expect(calls[0].headers).toEqual([{"anthropic-version": "2023-06-01"}, {"x-api-key": "sk-test"}]);
        expect(calls[0].payload).toHaveProperty("max_tokens");
    });

    it("Interactions：发到 /v1beta/interactions 并带上 x-goog-api-key（#30）", async () => {
        stubReplies(reply(200, JSON.stringify({
            steps: [{type: "model_output", content: [{type: "text", text: "Title"}]}],
        })));
        const target: ApiSettings = {
            ...API,
            protocol: PROTOCOL_GEMINI_INTERACTIONS,
            baseURL: "https://generativelanguage.googleapis.com/v1beta",
        };
        const result = await chat(PARAMS, target, NO_RETRY);
        expect(result.text).toBe("Title");
        expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
        expect(calls[0].headers).toEqual([{"x-goog-api-key": "sk-test"}]);
        expect(calls[0].payload).toHaveProperty("store", false);
    });

    it("供应商拒绝 max_completion_tokens 时自动改名重发，且不消耗重试预算", async () => {
        stubReplies(
            reply(400, '{"error":{"message":"Unsupported parameter: max_completion_tokens"}}'),
            reply(200, OK_BODY),
        );
        const result = await chat(PARAMS, {...API, maxTokens: 256}, NO_RETRY);
        expect(result.text).toBe("Title");
        expect(calls).toHaveLength(2);
        expect(calls[0].payload).toHaveProperty("max_completion_tokens", 256);
        expect(calls[1].payload).toHaveProperty("max_tokens", 256);
    });

    it("限流按响应里的 retry-after 重试", async () => {
        stubReplies(reply(429, "slow down", {"Retry-After": "0"}), reply(200, OK_BODY));
        const result = await chat(PARAMS, API, {...NO_RETRY, retries: 1});
        expect(result.text).toBe("Title");
        expect(calls).toHaveLength(2);
    });

    it("配置类错误立即抛出，不做无意义的重发", async () => {
        stubReplies(reply(400, '{"error":{"message":"bad model"}}'));
        await expect(chat(PARAMS, API, {...NO_RETRY, retries: 3})).rejects.toThrow(/HTTP 400: bad model/);
        expect(calls).toHaveLength(1);
    });

    it("响应合法但没有文本时给出 EMPTY_CONTENT 哨兵", async () => {
        stubReplies(reply(200, '{"choices":[{"message":{"content":""}}]}'));
        await expect(chat(PARAMS, API, NO_RETRY)).rejects.toThrow(EMPTY_CONTENT);
    });

    it("代理自身失败（地址非法、连接被拒）直接抛出", async () => {
        setFetchSyncPost(() => Promise.resolve({code: 1, msg: "connect: connection refused"}));
        await expect(chat(PARAMS, API, NO_RETRY)).rejects.toThrow(/connection refused/);
    });

    it("错误响应里的原文与状态码都带上", async () => {
        stubReplies(reply(500, "<html>bad gateway</html>"));
        const failure = await chat(PARAMS, API, NO_RETRY).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ApiError);
        expect((failure as Error).message).toContain("HTTP 500");
        expect((failure as Error).message).toContain("bad gateway");
    });

    it("响应体为空时只报一次状态码（网关对不存在的路径常这么回）", async () => {
        stubReplies(reply(404, ""));
        const failure = await chat(PARAMS, API, NO_RETRY).catch((error: unknown) => error);
        expect((failure as Error).message).toBe("HTTP 404");
    });

    it("测试连接按当前协议发一次请求并回报耗时", async () => {
        stubReplies(reply(200, '{"choices":[{"message":{"content":"hi"}}]}'));
        const result = await testConnection(API, NO_RETRY);
        expect(result.reply).toBe("hi");
        expect(result.elapsed).toBeGreaterThanOrEqual(0);
    });
});

describe("自定义请求头（#24）", () => {
    it("随请求发出、覆盖同名的鉴权头，获取模型列表也带上", async () => {
        stubReplies(reply(200, OK_BODY), reply(200, '{"data":[{"id":"m1"}]}'));
        const target: ApiSettings = {
            ...API,
            customHeaders: '{"Authorization": "Bearer from-header", "X-Route": "a"}',
        };
        await chat(PARAMS, target, NO_RETRY);
        // 只有一项 Authorization：自定义头覆盖插件自己那份，而不是并存
        expect(calls[0].headers).toEqual([{Authorization: "Bearer from-header"}, {"X-Route": "a"}]);
        await listModels(target, 1000);
        expect(calls[1].headers).toContainEqual({"X-Route": "a"});
    });

    it("请求头写坏时当场报错，不做无意义的重发", async () => {
        stubReplies(reply(200, OK_BODY));
        const target: ApiSettings = {...API, customHeaders: '{"X-Route": '};
        await expect(chat(PARAMS, target, {...NO_RETRY, retries: 3})).rejects.toThrow(/not valid JSON/);
        expect(calls).toHaveLength(0);
    });
});

describe("listModels（#9 获取模型列表）", () => {
    it("取 data 里的 id，跳过没有 id 的条目", async () => {
        stubReplies(reply(200, '{"data":[{"id":"m1"},{"id":""},{"name":"没有 id"},{"id":"m2"}]}'));
        await expect(listModels(API, 1000)).resolves.toEqual(["m1", "m2"]);
        expect(calls[0].url).toBe("https://api.openai.com/v1/models");
        expect(calls[0].method).toBe("GET");
    });

    it("Messages 协议走同一个端点并带 x-api-key", async () => {
        stubReplies(reply(200, '{"data":[{"id":"claude-sonnet-5"}]}'));
        const target: ApiSettings = {...API, protocol: PROTOCOL_ANTHROPIC_MESSAGES, baseURL: "https://api.anthropic.com/v1"};
        await expect(listModels(target, 1000)).resolves.toEqual(["claude-sonnet-5"]);
        expect(calls[0].url).toBe("https://api.anthropic.com/v1/models?limit=1000");
        expect(calls[0].headers).toContainEqual({"x-api-key": "sk-test"});
    });

    it("Interactions 走 models 端点，名字取 name 并去掉 models/ 前缀（#30）", async () => {
        stubReplies(reply(200, '{"models":[{"name":"models/gemini-3.8-flash"},{"name":"models/gemini-3.1-pro"}]}'));
        const target: ApiSettings = {
            ...API,
            protocol: PROTOCOL_GEMINI_INTERACTIONS,
            baseURL: "https://generativelanguage.googleapis.com/v1beta",
        };
        await expect(listModels(target, 1000)).resolves.toEqual(["gemini-3.8-flash", "gemini-3.1-pro"]);
        expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
        expect(calls[0].headers).toContainEqual({"x-goog-api-key": "sk-test"});
    });

    it("失败时带上状态码与原文，原文为空时只留状态码", async () => {
        stubReplies(reply(401, ""));
        await expect(listModels(API, 1000)).rejects.toThrow("HTTP 401");
        stubReplies(reply(403, '{"error":{"message":"forbidden"}}'));
        await expect(listModels(API, 1000)).rejects.toThrow("HTTP 403: forbidden");
    });
});
