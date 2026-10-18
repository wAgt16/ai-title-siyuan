import {describe, expect, it} from "vitest";
import {
    DEFAULT_SETTINGS,
    defaultTitleLanguage,
    hasProviderConfig,
    hasProviderEndpoint,
    isAdapterProtocol,
    isFollowDefaultProvider,
    isProtocol,
    mergeSettings,
    PROTOCOL_ANTHROPIC_MESSAGES,
    PROTOCOL_CHAT_COMPLETIONS,
    PROTOCOL_SIYUAN_PROVIDER,
    PROTOCOLS,
    PROVIDER_FOLLOW_AGENT,
    PROVIDER_FOLLOW_EDITOR,
    REASONING_DEFAULT,
    REASONING_EFFORT_OFF,
    selectedModel,
    type ApiSettings,
} from "../src/config";

describe("mergeSettings（旧配置兼容）", () => {
    it("什么都没存时给出默认值", () => {
        expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
        expect(mergeSettings("not an object")).toEqual(DEFAULT_SETTINGS);
    });

    it("缺字段的旧配置逐项回退默认值", () => {
        const merged = mergeSettings({api: {baseURL: "https://example.com/v1"}});
        expect(merged.api.baseURL).toBe("https://example.com/v1");
        expect(merged.api.model).toBe(DEFAULT_SETTINGS.api.model);
        expect(merged.behavior.batchSize).toBe(DEFAULT_SETTINGS.behavior.batchSize);
        expect(merged.ui.debug).toBe(false);
    });

    it("下拉里的协议取值都保留，认不出来的退回 Chat Completions（#8 #20 #27 #30）", () => {
        for (const protocol of PROTOCOLS) {
            expect(mergeSettings({api: {protocol}}).api.protocol).toBe(protocol);
        }
        expect(mergeSettings({api: {protocol: "gemini"}}).api.protocol).toBe(PROTOCOL_CHAT_COMPLETIONS);
        expect(isProtocol("anthropic-messages")).toBe(true);
        expect(isProtocol("anthropic")).toBe(false);
        // 「使用思源设置中供应商」是一种配置来源，不是能拿去发请求的协议
        expect(isAdapterProtocol("siyuan")).toBe(false);
        expect(isAdapterProtocol("openai-responses")).toBe(true);
        expect(isAdapterProtocol("gemini-interactions")).toBe(true);
    });

    it("新装默认「使用思源设置中供应商」，老配置里的协议原样保留（#27）", () => {
        expect(mergeSettings(undefined).api.protocol).toBe(PROTOCOL_SIYUAN_PROVIDER);
        expect(DEFAULT_SETTINGS.api.protocol).toBe(PROTOCOL_SIYUAN_PROVIDER);
        // 协议字段从 v0.1.0 起就在，所以存过的配置一定带着自己的取值，不会被新默认值切走
        expect(mergeSettings({api: {protocol: PROTOCOL_ANTHROPIC_MESSAGES}}).api.protocol)
            .toBe(PROTOCOL_ANTHROPIC_MESSAGES);
        expect(mergeSettings({api: {}}).api.protocol).toBe(PROTOCOL_SIYUAN_PROVIDER);
    });

    it("供应商 id 默认留空，存的不是文本时按空处理（#27）", () => {
        expect(DEFAULT_SETTINGS.api.siyuanProvider).toBe("");
        expect(mergeSettings({api: {siyuanProvider: "20260913135841-1u2j84c"}}).api.siyuanProvider)
            .toBe("20260913135841-1u2j84c");
        expect(mergeSettings({api: {siyuanProvider: 42}}).api.siyuanProvider).toBe("");
    });

    it("已弃用的「禁用思考」下拉一律清掉，不再拼进请求体（#14）", () => {
        const merged = mergeSettings({
            api: {disableThinking: '{"enable_thinking": false}', customThinking: '{"thinking": {"type": "disabled"}}'},
        });
        expect(merged.api.disableThinking).toBe(DEFAULT_SETTINGS.api.disableThinking);
        expect(merged.api.customThinking).toBe("");
    });

    it("旧开关折算成思考强度的禁用档，之后以新配置为准", () => {
        expect(mergeSettings({api: {suppressReasoning: true}}).api.reasoningEffort).toBe(REASONING_EFFORT_OFF);
        expect(mergeSettings({api: {disableThinking: "disabled"}}).api.reasoningEffort).toBe(REASONING_DEFAULT);
        // 已经存过 reasoningEffort 时不再回头看旧字段
        expect(mergeSettings({api: {reasoningEffort: "high", suppressReasoning: true}}).api.reasoningEffort).toBe("high");
        expect(mergeSettings({api: {}}).api.reasoningEffort).toBe(REASONING_DEFAULT);
    });

    it("自定义请求头默认留空，存的不是文本时按空处理（#24）", () => {
        expect(DEFAULT_SETTINGS.api.customHeaders).toBe("");
        expect(mergeSettings({api: {baseURL: "https://example.com/v1"}}).api.customHeaders).toBe("");
        expect(mergeSettings({api: {customHeaders: '{"X-Route": "a"}'}}).api.customHeaders).toBe('{"X-Route": "a"}');
        // 手改成对象/数组时不留着：留着只会在第一次解析时炸成看不懂的报错
        expect(mergeSettings({api: {customHeaders: {"X-Route": "a"}}}).api.customHeaders).toBe("");
    });

    it("注入防护默认开启，旧配置缺这个字段时也按开启处理（#23）", () => {
        expect(DEFAULT_SETTINGS.behavior.ignoreInjection).toBe(true);
        expect(mergeSettings(undefined).behavior.ignoreInjection).toBe(true);
        expect(mergeSettings({behavior: {batchSize: 5}}).behavior.ignoreInjection).toBe(true);
        expect(mergeSettings({behavior: {ignoreInjection: false}}).behavior.ignoreInjection).toBe(false);
    });

    it("旧版可改写的完整提示词被删掉，只留追加位（#5）", () => {
        const merged = mergeSettings({
            behavior: {systemPrompt: "被改坏的提示词", userPrompt: "同样被改坏"},
        });
        const behavior = merged.behavior as unknown as Record<string, unknown>;
        expect(behavior.systemPrompt).toBeUndefined();
        expect(behavior.userPrompt).toBeUndefined();
        expect(merged.behavior.systemExtra).toBe("");
    });
});

describe("defaultTitleLanguage（#21 标题语言跟随界面）", () => {
    it("中文变体给中文，其余给英文", () => {
        expect(defaultTitleLanguage("zh-CN")).toBe("中文");
        expect(defaultTitleLanguage("zh-TW")).toBe("中文");
        expect(defaultTitleLanguage("en-US")).toBe("English");
        expect(defaultTitleLanguage("ja-JP")).toBe("English");
    });
});

describe("hasProviderConfig（#27 两种模式要填的东西不同）", () => {
    it("自定义配置看 Base URL 和模型", () => {
        const api: ApiSettings = {
            ...DEFAULT_SETTINGS.api,
            protocol: PROTOCOL_CHAT_COMPLETIONS,
            baseURL: "https://example.com/v1",
            model: "gpt-5.1",
        };
        expect(hasProviderConfig(api)).toBe(true);
        expect(hasProviderEndpoint(api)).toBe(true);
        expect(hasProviderConfig({...api, model: "  "})).toBe(false);
        expect(hasProviderConfig({...api, baseURL: ""})).toBe(false);
        expect(hasProviderEndpoint({...api, baseURL: ""})).toBe(false);
    });

    it("思源供应商模式看供应商和 siyuanModel，不看 Base URL", () => {
        const api: ApiSettings = {
            ...DEFAULT_SETTINGS.api,
            protocol: PROTOCOL_SIYUAN_PROVIDER,
            siyuanProvider: "20260913135841-1u2j84c",
            // 自定义模式的模型名留着：它不属于这个模式
            model: "gpt-4o-mini",
            siyuanModel: "gpt-5.1",
        };
        expect(hasProviderConfig(api)).toBe(true);
        expect(hasProviderEndpoint(api)).toBe(true);
        expect(selectedModel(api)).toBe("gpt-5.1");
        expect(hasProviderConfig({...api, siyuanProvider: " "})).toBe(false);
        expect(hasProviderEndpoint({...api, siyuanProvider: ""})).toBe(false);
        // 模型没选时「获取模型列表」仍然可用：它要的只是端点
        expect(hasProviderEndpoint({...api, siyuanModel: ""})).toBe(true);
        expect(hasProviderConfig({...api, siyuanModel: ""})).toBe(false);
        // 另一个模式的模型名填得再满也不算数
        expect(hasProviderConfig({...api, siyuanModel: ""})).toBe(false);
    });

    it("自定义模式看的是 model，两种模式的模型名互不影响（#27）", () => {
        const api: ApiSettings = {
            ...DEFAULT_SETTINGS.api,
            protocol: PROTOCOL_CHAT_COMPLETIONS,
            baseURL: "https://example.com/v1",
            model: "gpt-5.1",
            siyuanModel: "gpt-5.2",
        };
        expect(selectedModel(api)).toBe("gpt-5.1");
        expect(hasProviderConfig({...api, model: ""})).toBe(false);
    });

    it("两条「跟随默认」都没有可填的模型名，选了就算配置齐全（#28）", () => {
        for (const provider of [PROVIDER_FOLLOW_EDITOR, PROVIDER_FOLLOW_AGENT]) {
            const api: ApiSettings = {
                ...DEFAULT_SETTINGS.api,
                protocol: PROTOCOL_SIYUAN_PROVIDER,
                siyuanProvider: provider,
            };
            expect(hasProviderConfig(api)).toBe(true);
            expect(hasProviderEndpoint(api)).toBe(true);
            // 这一档不写模型名：真正用哪个由思源决定，插件这边没有值可显示
            expect(selectedModel(api)).toBe("");
            // 手改的配置里带空格同样认得
            expect(hasProviderConfig({...api, siyuanProvider: ` ${provider} `})).toBe(true);
        }
        // 空值与具体供应商仍然要求模型名
        expect(hasProviderConfig({...DEFAULT_SETTINGS.api, protocol: PROTOCOL_SIYUAN_PROVIDER})).toBe(false);
        // 只认这两个确切取值，其余一律按供应商 id 处理
        expect(isFollowDefaultProvider("follow")).toBe(false);
        expect(isFollowDefaultProvider("")).toBe(false);
        expect(isFollowDefaultProvider("20260913135841-1u2j84c")).toBe(false);
    });
});
