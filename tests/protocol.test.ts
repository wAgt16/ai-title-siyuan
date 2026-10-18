import {describe, expect, it} from "vitest";
import {
    DEFAULT_SETTINGS,
    PROTOCOL_ANTHROPIC_MESSAGES,
    PROTOCOL_CHAT_COMPLETIONS,
    PROTOCOL_GEMINI_INTERACTIONS,
    PROTOCOL_RESPONSES,
    REASONING_DEFAULT,
    type ApiSettings,
} from "../src/config";
import {adapterFor, ApiError, type ChatParams, type ProtocolAdapter} from "../src/api/protocol";

const PARAMS: ChatParams = {system: "SYS", user: "USER"};
const OPTIONS = {useMaxCompletionTokens: true};

/** 三个协议的 payload 都接受同一组参数，测试里统一从这个入口构造请求体。 */
function build(adapter: ProtocolAdapter, target: ApiSettings, options = OPTIONS): Record<string, unknown> {
    return adapter.payload(PARAMS, target, options);
}

function api(overrides: Partial<ApiSettings> = {}): ApiSettings {
    return {
        ...DEFAULT_SETTINGS.api,
        baseURL: "https://api.openai.com/v1",
        apiKey: "sk-test",
        model: "gpt-5.1",
        ...overrides,
    };
}

const chat = adapterFor(PROTOCOL_CHAT_COMPLETIONS);
const responses = adapterFor(PROTOCOL_RESPONSES);
const anthropic = adapterFor(PROTOCOL_ANTHROPIC_MESSAGES);
const gemini = adapterFor(PROTOCOL_GEMINI_INTERACTIONS);

describe("请求地址（#8 #20）", () => {
    it("按协议追加各自的资源名", () => {
        expect(chat.completionURL("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/chat/completions");
        expect(responses.completionURL("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/responses");
        expect(anthropic.completionURL("https://api.anthropic.com/v1")).toBe("https://api.anthropic.com/v1/messages");
    });

    it("地址末尾多写的斜杠不会拼出双斜杠", () => {
        expect(chat.completionURL("https://api.openai.com/v1///")).toBe("https://api.openai.com/v1/chat/completions");
    });

    it("Messages 的地址没带 /v1 时自己补一个（供应商文档两种写法都有）", () => {
        expect(anthropic.completionURL("https://api.deepseek.com/anthropic"))
            .toBe("https://api.deepseek.com/anthropic/v1/messages");
        expect(anthropic.completionURL("https://api.anthropic.com")).toBe("https://api.anthropic.com/v1/messages");
        expect(anthropic.completionURL("https://api.anthropic.com/V1")).toBe("https://api.anthropic.com/V1/messages");
    });

    it("模型列表地址同样按协议走，Messages 与 Interactions 一次列全", () => {
        expect(chat.modelsURL("https://example.com/v1")).toBe("https://example.com/v1/models");
        expect(responses.modelsURL("https://example.com/v1")).toBe("https://example.com/v1/models");
        expect(anthropic.modelsURL("https://api.anthropic.com/v1"))
            .toBe("https://api.anthropic.com/v1/models?limit=1000");
        expect(gemini.modelsURL("https://generativelanguage.googleapis.com/v1beta"))
            .toBe("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
    });

    it("Interactions 的地址带了版本段就直接追加，没带才补 /v1beta（#30）", () => {
        expect(gemini.completionURL("https://generativelanguage.googleapis.com/v1beta"))
            .toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
        expect(gemini.completionURL("https://generativelanguage.googleapis.com/v1beta/"))
            .toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
        expect(gemini.completionURL("https://generativelanguage.googleapis.com/v1"))
            .toBe("https://generativelanguage.googleapis.com/v1/interactions");
        expect(gemini.completionURL("https://generativelanguage.googleapis.com"))
            .toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
        expect(gemini.completionURL("https://example.com/gemini"))
            .toBe("https://example.com/gemini/v1beta/interactions");
    });
});

describe("鉴权头（#20）", () => {
    it("Chat Completions 与 Responses 走 Bearer", () => {
        expect(chat.headers(api())).toEqual({Authorization: "Bearer sk-test"});
        expect(responses.headers(api())).toEqual({Authorization: "Bearer sk-test"});
    });

    it("Messages 走 x-api-key 并带协议版本", () => {
        expect(anthropic.headers(api())).toEqual({"anthropic-version": "2023-06-01", "x-api-key": "sk-test"});
    });

    it("OpenRouter 的 Messages 入口只认 Bearer", () => {
        expect(anthropic.headers(api({baseURL: "https://openrouter.ai/api/v1"})))
            .toEqual({"anthropic-version": "2023-06-01", Authorization: "Bearer sk-test"});
    });

    it("接口不需要密钥时不带鉴权头", () => {
        expect(chat.headers(api({apiKey: "  "}))).toEqual({});
        expect(anthropic.headers(api({apiKey: ""}))).toEqual({"anthropic-version": "2023-06-01"});
        expect(gemini.headers(api({apiKey: ""}))).toEqual({});
    });

    it("Interactions 走 x-goog-api-key（#30）", () => {
        expect(gemini.headers(api())).toEqual({"x-goog-api-key": "sk-test"});
    });
});

describe("Chat Completions 请求体", () => {
    it("两条提示词进 messages，采样参数按需带上", () => {
        const payload = build(chat, api({temperature: 0.3, topP: 0.8, topK: null}), OPTIONS);
        expect(payload.messages).toEqual([
            {role: "system", content: "SYS"},
            {role: "user", content: "USER"},
        ]);
        expect(payload.temperature).toBe(0.3);
        expect(payload.top_p).toBe(0.8);
        expect(payload).not.toHaveProperty("top_k");
        expect(payload.stream).toBe(false);
    });

    it("输出上限字段在回退时改名（#8 的 max_tokens 兼容）", () => {
        const target = api({maxTokens: 512});
        expect(build(chat, target, {useMaxCompletionTokens: true}).max_completion_tokens).toBe(512);
        expect(build(chat, target, {useMaxCompletionTokens: false}).max_tokens).toBe(512);
    });

    it("上限留空则不发送该字段", () => {
        expect(build(chat, api({maxTokens: 0}), OPTIONS)).not.toHaveProperty("max_completion_tokens");
    });

    it("思考强度只在非默认档发送（#14）", () => {
        expect(build(chat, api(), OPTIONS)).not.toHaveProperty("reasoning_effort");
        expect(build(chat, api({reasoningEffort: REASONING_DEFAULT}), OPTIONS))
            .not.toHaveProperty("reasoning_effort");
        expect(build(chat, api({reasoningEffort: "none"}), OPTIONS).reasoning_effort).toBe("none");
        expect(build(chat, api({reasoningEffort: "max"}), OPTIONS).reasoning_effort).toBe("max");
    });
});

describe("Responses 请求体（#8）", () => {
    it("系统提示词走 instructions，用户输入走 input 块", () => {
        const payload = build(responses, api());
        expect(payload.instructions).toBe("SYS");
        expect(payload.input).toEqual([{role: "user", content: [{type: "input_text", text: "USER"}]}]);
        expect(payload).not.toHaveProperty("messages");
    });

    it("输出上限用 max_output_tokens，永远不发 top_k", () => {
        const payload = build(responses, api({maxTokens: 300, topP: 0.5, topK: 20}));
        expect(payload.max_output_tokens).toBe(300);
        expect(payload.top_p).toBe(0.5);
        expect(payload).not.toHaveProperty("top_k");
    });

    it("思考强度换成 reasoning.effort", () => {
        expect(build(responses, api())).not.toHaveProperty("reasoning");
        expect(build(responses, api({reasoningEffort: "none"})).reasoning).toEqual({effort: "none"});
        expect(build(responses, api({reasoningEffort: "high"})).reasoning).toEqual({effort: "high"});
    });

    it("只对已知会留存响应的主机显式关闭留存", () => {
        expect(build(responses, api({baseURL: "https://api.openai.com/v1"})).store).toBe(false);
        expect(build(responses, api({baseURL: "https://openrouter.ai/api/v1"})).store).toBe(false);
        expect(build(responses, api({baseURL: "https://api.deepseek.com/v1"}))).not.toHaveProperty("store");
    });
});

describe("Anthropic Messages 请求体（#20）", () => {
    it("max_tokens 必填，system 与用户输入各就各位", () => {
        const payload = build(anthropic, api({model: "claude-3-7-sonnet", maxTokens: 2048}));
        expect(payload.max_tokens).toBe(2048);
        expect(payload.system).toBe("SYS");
        expect(payload.messages).toEqual([{role: "user", content: [{type: "text", text: "USER"}]}]);
    });

    it("上限留空时给一个保守的默认值，而不是让请求缺字段", () => {
        expect(build(anthropic, api({maxTokens: 0})).max_tokens).toBe(4096);
    });

    it("温度夹到 0 到 1，top_k 取整（Messages 的取值域比 OpenAI 窄）", () => {
        const payload = build(anthropic, api({
            model: "claude-3-7-sonnet",
            temperature: 2,
            topP: 0.7,
            topK: 8.6,
        }));
        expect(payload.temperature).toBe(1);
        expect(payload.top_p).toBe(0.7);
        expect(payload.top_k).toBe(9);
    });

    it("思考强度禁用档发 thinking disabled", () => {
        const payload = build(anthropic, api({reasoningEffort: "none"}));
        expect(payload.thinking).toEqual({type: "disabled"});
        expect(payload).not.toHaveProperty("output_config");
    });

    it("默认档完全不发 thinking", () => {
        expect(build(anthropic, api())).not.toHaveProperty("thinking");
    });

    it("旧型号用手动预算，并给可见回答留一半输出额度", () => {
        const payload = build(anthropic, api({
            model: "claude-3-7-sonnet",
            maxTokens: 8192,
            reasoningEffort: "low",
        }));
        // 低档预算 1024，输出上限的一半是 4096，取小的那个
        expect(payload.thinking).toEqual({type: "enabled", budget_tokens: 1024});
        expect(payload).not.toHaveProperty("output_config");
        const capped = build(anthropic, api({
            model: "claude-3-7-sonnet",
            maxTokens: 3000,
            reasoningEffort: "max",
        }));
        expect(capped.thinking).toEqual({type: "enabled", budget_tokens: 1500});
    });

    it("输出上限装不下思考预算时直接报错，让人去调大上限", () => {
        expect(() => build(anthropic, api({
            model: "claude-3-7-sonnet",
            maxTokens: 512,
            reasoningEffort: "low",
        }))).toThrow(ApiError);
    });

    it("新型号改用 adaptive 与 effort，预算字段已废弃", () => {
        const payload = build(anthropic, api({model: "claude-sonnet-5", reasoningEffort: "medium"}));
        expect(payload.thinking).toEqual({type: "adaptive"});
        expect(payload.output_config).toEqual({effort: "medium"});
    });

    it("开启思考时不发采样参数（temperature 只能为 1），关闭时照发", () => {
        const thinking = build(anthropic, api({model: "claude-3-7-sonnet", maxTokens: 8192, reasoningEffort: "high"}));
        expect(thinking).not.toHaveProperty("temperature");
        expect(thinking).not.toHaveProperty("top_p");
        const plain = build(anthropic, api({model: "claude-3-7-sonnet", reasoningEffort: "none"}));
        expect(plain).toHaveProperty("temperature");
    });

    it("新型号根本不接受采样参数，不发以免 400", () => {
        const payload = build(anthropic, api({model: "claude-opus-5-5", topK: 5}));
        expect(payload).not.toHaveProperty("temperature");
        expect(payload).not.toHaveProperty("top_p");
        expect(payload).not.toHaveProperty("top_k");
    });

    it("第三方 Messages 兼容端点照发采样参数", () => {
        const payload = build(anthropic, api({model: "deepseek-chat", topK: 12}));
        expect(payload).toHaveProperty("temperature");
        expect(payload.top_k).toBe(12);
    });
});

describe("Gemini Interactions 请求体（#30）", () => {
    /** 取出 Interactions 的 generation_config，免得每处都写类型断言。 */
    function generationConfig(payload: Record<string, unknown>): Record<string, unknown> {
        return payload.generation_config as Record<string, unknown>;
    }

    it("系统提示词与用户输入分开放，采样参数收进 generation_config", () => {
        const payload = build(gemini, api({model: "gemini-3.8-flash", temperature: 0.4, topP: 0.9, maxTokens: 600}));
        expect(payload.model).toBe("gemini-3.8-flash");
        expect(payload.input).toBe("USER");
        expect(payload.system_instruction).toBe("SYS");
        expect(generationConfig(payload)).toMatchObject({temperature: 0.4, top_p: 0.9, max_output_tokens: 600});
        // 默认会留存请求与响应，而这里发出去的是笔记正文
        expect(payload.store).toBe(false);
        // 平铺的 OpenAI 字段一个都不发
        expect(payload).not.toHaveProperty("messages");
        expect(payload).not.toHaveProperty("temperature");
    });

    it("top_k 不发：Interactions 的 generation_config 里没有这个字段", () => {
        const payload = build(gemini, api({topK: 20}));
        expect(payload).not.toHaveProperty("top_k");
        expect(generationConfig(payload)).not.toHaveProperty("top_k");
    });

    it("上限留空时不发 max_output_tokens", () => {
        expect(generationConfig(build(gemini, api({maxTokens: 0})))).not.toHaveProperty("max_output_tokens");
    });

    it("思考强度换成 thinking_level，超出的档位并入相邻档", () => {
        expect(generationConfig(build(gemini, api({reasoningEffort: REASONING_DEFAULT}))))
            .not.toHaveProperty("thinking_level");
        expect(generationConfig(build(gemini, api({reasoningEffort: "none"}))).thinking_level).toBe("minimal");
        expect(generationConfig(build(gemini, api({reasoningEffort: "low"}))).thinking_level).toBe("low");
        expect(generationConfig(build(gemini, api({reasoningEffort: "medium"}))).thinking_level).toBe("medium");
        for (const effort of ["high", "xhigh", "max"] as const) {
            expect(generationConfig(build(gemini, api({reasoningEffort: effort}))).thinking_level).toBe("high");
        }
    });
});

describe("响应解析", () => {
    it("Chat Completions：取 content，content 为空时回退推理字段", () => {
        expect(chat.parse('{"choices":[{"message":{"content":"  hello  "}}]}').text).toBe("hello");
        const fallback = chat.parse('{"choices":[{"message":{"content":"","reasoning_content":"thinking"}}]}');
        expect(fallback.text).toBe("thinking");
        expect(fallback.reasoning?.text).toBe("thinking");
    });

    it("Chat Completions：usage 里的推理 token 数进痕迹", () => {
        const result = chat.parse(
            '{"choices":[{"message":{"content":"hi"}}],"usage":{"completion_tokens_details":{"reasoning_tokens":12}}}',
        );
        expect(result.reasoning).toEqual({text: "", tokens: 12});
    });

    it("Chat Completions：没有 choices 或不是 JSON 都报错", () => {
        expect(() => chat.parse('{"id":"x"}')).toThrow(/no choices/);
        expect(() => chat.parse("<html>502</html>")).toThrow(/not valid JSON/);
    });

    it("Responses：拼接 output_text，思考摘要单独进痕迹（#8）", () => {
        const body = JSON.stringify({
            status: "completed",
            output: [
                {type: "reasoning", summary: [{type: "summary_text", text: "think"}]},
                {type: "message", content: [{type: "output_text", text: '{"a":'}, {type: "output_text", text: '"b"}'}]},
            ],
            usage: {output_tokens_details: {reasoning_tokens: 7}},
        });
        const result = responses.parse(body);
        expect(result.text).toBe('{"a":"b"}');
        expect(result.reasoning).toEqual({text: "think", tokens: 7});
    });

    it("Responses：只剩推理摘要时用它当文本，而不是报「没有内容」", () => {
        const body = JSON.stringify({output: [{type: "reasoning", summary: [{text: "only thinking"}]}]});
        expect(responses.parse(body).text).toBe("only thinking");
    });

    it("Responses：拒答取 refusal 原文", () => {
        const body = JSON.stringify({output: [{type: "message", content: [{type: "refusal", refusal: "I cannot"}]}]});
        expect(responses.parse(body).text).toBe("I cannot");
    });

    it("Responses：响应体里的错误按失败处理", () => {
        expect(() => responses.parse('{"error":{"message":"boom"}}')).toThrow(/boom/);
    });

    it("Anthropic：拼接 text 块，思考块进痕迹（#20）", () => {
        const body = JSON.stringify({
            content: [
                {type: "thinking", thinking: "reasoning here"},
                {type: "text", text: '{"a"'},
                {type: "text", text: ': "b"}'},
            ],
            usage: {output_tokens_details: {thinking_tokens: 3}},
        });
        const result = anthropic.parse(body);
        expect(result.text).toBe('{"a": "b"}');
        expect(result.reasoning).toEqual({text: "reasoning here", tokens: 3});
    });

    it("Anthropic：没有 content 数组时报错，而不是当成空响应", () => {
        expect(() => anthropic.parse('{"id":"msg_1"}')).toThrow(/no content blocks/);
    });

    it("Interactions：拼接 model_output 的文本块，思考摘要单独进痕迹（#30）", () => {
        const body = JSON.stringify({
            id: "int_1",
            status: "completed",
            steps: [
                {type: "user_input", content: [{type: "text", text: "USER"}]},
                {type: "thought", summary: {type: "text", text: "think"}},
                {type: "model_output", content: [{type: "text", text: '{"a":'}, {type: "text", text: '"b"}'}]},
            ],
            usage: {total_thought_tokens: 9},
        });
        const result = gemini.parse(body);
        expect(result.text).toBe('{"a":"b"}');
        expect(result.reasoning).toEqual({text: "think", tokens: 9});
    });

    it("Interactions：只剩思考摘要时用它当文本，而不是报「没有内容」", () => {
        const body = JSON.stringify({
            steps: [{type: "thought", summary: {type: "text", text: "only thinking"}}],
        });
        expect(gemini.parse(body).text).toBe("only thinking");
    });

    it("Interactions：没有 thought token 时痕迹里不带计数", () => {
        const body = JSON.stringify({
            steps: [{type: "model_output", content: [{type: "text", text: "Title"}]}],
        });
        expect(gemini.parse(body).reasoning).toBeUndefined();
    });

    it("Interactions：响应体里的错误与失败的 interaction 都按失败处理", () => {
        expect(() => gemini.parse('{"error":{"message":"boom"}}')).toThrow(/boom/);
        expect(() => gemini.parse('{"status":"failed","steps":[]}')).toThrow(/failed/);
    });

    it("四个协议都要求响应是合法 JSON", () => {
        for (const adapter of [chat, responses, anthropic, gemini]) {
            expect(() => adapter.parse("not json")).toThrow(ApiError);
        }
    });
});

describe("模型列表的解析（#9 #30）", () => {
    it("data 包装层跳过没有 id 的条目", () => {
        for (const adapter of [chat, responses, anthropic]) {
            expect(adapter.parseModels('{"data":[{"id":"m1"},{"id":""},{"name":"没有 id"},{"id":"m2"}]}'))
                .toEqual(["m1", "m2"]);
        }
    });

    it("Interactions 取 models 里的 name 并去掉 models/ 前缀", () => {
        expect(gemini.parseModels(
            '{"models":[{"name":"models/gemini-3.8-flash"},{"name":"gemini-3.1-pro"},{"displayName":"没有 name"}]}',
        )).toEqual(["gemini-3.8-flash", "gemini-3.1-pro"]);
    });

    it("不是 JSON 时报错", () => {
        expect(() => gemini.parseModels("<html>502</html>")).toThrow(/not valid JSON/);
    });
});
