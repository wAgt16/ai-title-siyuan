import {afterEach, describe, expect, it} from "vitest";
import {ApiError} from "../src/api/protocol";
import {
    activeModelName,
    followDefaultTarget,
    providerModelNames,
    providerProtocol,
    readSiyuanProviders,
    resolveApiSettings,
} from "../src/api/siyuan-provider";
import {
    type ApiSettings,
    DEFAULT_SETTINGS,
    PROTOCOL_CHAT_COMPLETIONS,
    PROTOCOL_SIYUAN_PROVIDER,
    PROVIDER_FOLLOW_AGENT,
    PROVIDER_FOLLOW_EDITOR,
} from "../src/config";

/** 思源「设置 → AI → 供应商」里的一条配置，字段取自内核的 conf.Provider。 */
const PROVIDER = {
    id: "20260913135841-1u2j84c",
    displayName: "Example",
    enabled: true,
    baseURL: "https://api.example.com/v1",
    apiKey: "sk-from-siyuan",
    protocol: "openai-responses",
    headers: {"x-opencode-session": "{{vars.SESSION}}"},
    models: [
        {id: "20260913135841-m1", name: "gpt-5.1", enabled: false},
        {id: "20260913135841-m2", name: "gpt-5.2", enabled: true},
    ],
};

/** 第二条供应商：用来证明「跟随默认」认的是模型 id 指向的那一条，而不是第一条。 */
const OTHER_PROVIDER = {
    id: "20260913135841-9k8l7m6",
    displayName: "Other",
    enabled: true,
    baseURL: "https://other.example.com/v1",
    apiKey: "sk-other",
    protocol: "anthropic-messages",
    models: [{id: "20260913135841-o1", name: "claude-x", enabled: true}],
};

/** 装一份假的宿主配置：真实环境里就是 window.siyuan.config。 */
function setAi(
    providers: unknown[],
    ai: {editing?: {modelId?: string}; agent?: {modelId?: string}} = {},
): void {
    (globalThis as unknown as {window?: unknown}).window = {siyuan: {config: {ai: {providers, ...ai}}}};
}

function setProviders(providers: unknown[]): void {
    setAi(providers);
}

/** 「使用思源设置中供应商」模式下的一份插件配置。 */
function siyuanApi(overrides: Partial<ApiSettings> = {}): ApiSettings {
    return {
        ...DEFAULT_SETTINGS.api,
        protocol: PROTOCOL_SIYUAN_PROVIDER,
        siyuanProvider: PROVIDER.id,
        // 自定义模式的模型名留着不动：这个模式下用的必须是 siyuanModel（#27）
        model: "gpt-4o-mini",
        siyuanModel: "",
        ...overrides,
    };
}

afterEach(() => {
    delete (globalThis as unknown as {window?: unknown}).window;
});

describe("resolveApiSettings（#27 使用思源设置中供应商）", () => {
    it("自定义配置原样返回，只做类型收窄", () => {
        setProviders([]);
        const api: ApiSettings = {
            ...DEFAULT_SETTINGS.api,
            protocol: PROTOCOL_CHAT_COMPLETIONS,
            baseURL: "https://api.openai.com/v1",
            apiKey: "sk-mine",
            customHeaders: '{"X-Route": "a"}',
            model: "gpt-5.1",
        };
        expect(resolveApiSettings(api)).toEqual(api);
    });

    it("协议、Base URL、密钥与请求头整条换成供应商那一份，模型留空时用启用中的那个", () => {
        setProviders([PROVIDER]);
        const resolved = resolveApiSettings(siyuanApi());
        expect(resolved.protocol).toBe("openai-responses");
        expect(resolved.baseURL).toBe("https://api.example.com/v1");
        expect(resolved.apiKey).toBe("sk-from-siyuan");
        expect(JSON.parse(resolved.customHeaders)).toEqual({"x-opencode-session": "{{vars.SESSION}}"});
        // 模型名必须取 name：思源给模型另生成的内部 id 发到接口上取不到模型
        expect(resolved.model).toBe("gpt-5.2");
    });

    it("已经选过模型时以插件里的为准，且用的是 siyuanModel 而不是自定义模式的 model", () => {
        setProviders([PROVIDER]);
        expect(resolveApiSettings(siyuanApi({siyuanModel: "gpt-5.1"})).model).toBe("gpt-5.1");
        // 自定义模式那个字段在这个模式下不参与：它是另一套配置的模型名
        expect(resolveApiSettings(siyuanApi({model: "should-not-be-used"})).model).toBe("gpt-5.2");
    });

    it("供应商没配请求头时按「没有自定义请求头」处理", () => {
        setProviders([{...PROVIDER, headers: {}}]);
        expect(resolveApiSettings(siyuanApi()).customHeaders).toBe("");
    });

    it("供应商没标协议时按思源自己的默认值 Chat Completions", () => {
        setProviders([{...PROVIDER, protocol: ""}]);
        expect(resolveApiSettings(siyuanApi()).protocol).toBe(PROTOCOL_CHAT_COMPLETIONS);
    });

    it("没选供应商时当场报错，不发一个没有鉴权的请求", () => {
        setProviders([PROVIDER]);
        expect(() => resolveApiSettings(siyuanApi({siyuanProvider: "  "}))).toThrow(/No SiYuan provider is selected/);
    });

    it("供应商不存在（思源那边删了，或当前角色读不到）时报出它的 id", () => {
        setProviders([]);
        const failure = (() => {
            try {
                resolveApiSettings(siyuanApi());
                return undefined;
            } catch (error) {
                return error;
            }
        })();
        expect(failure).toBeInstanceOf(ApiError);
        expect((failure as Error).message).toContain(PROVIDER.id);
    });

    it("供应商的协议插件没实现时拒绝发请求", () => {
        setProviders([{...PROVIDER, protocol: "gemini"}]);
        expect(() => resolveApiSettings(siyuanApi())).toThrow(/does not implement/);
    });

    it("供应商没填 Base URL 时说清楚去哪儿补", () => {
        setProviders([{...PROVIDER, baseURL: "   "}]);
        expect(() => resolveApiSettings(siyuanApi())).toThrow(/has no base URL/);
    });
});

describe("跟随编辑器默认 / 跟随智能体默认（#28）", () => {
    /** 两条「跟随默认」的配置：没有供应商 id，也没有模型名。 */
    const followEditor = (overrides: Partial<ApiSettings> = {}): ApiSettings =>
        siyuanApi({siyuanProvider: PROVIDER_FOLLOW_EDITOR, siyuanModel: "", ...overrides});
    const followAgent = (overrides: Partial<ApiSettings> = {}): ApiSettings =>
        siyuanApi({siyuanProvider: PROVIDER_FOLLOW_AGENT, siyuanModel: "", ...overrides});
    /** 编辑器与智能体指向不同供应商的两个模型：用来区分两条选项取的是哪一处。 */
    const BOTH = {editing: {modelId: "20260913135841-m2"}, agent: {modelId: "20260913135841-o1"}};

    it("编辑器选项只用编辑器 AI 的默认模型，整条配置换成它所属的供应商", () => {
        setAi([PROVIDER, OTHER_PROVIDER], BOTH);
        expect(followDefaultTarget(PROVIDER_FOLLOW_EDITOR)?.model).toBe("gpt-5.2");
        const resolved = resolveApiSettings(followEditor());
        // 模型名取 name：思源内部的模型 id 发到接口上取不到模型
        expect(resolved.model).toBe("gpt-5.2");
        expect(resolved.protocol).toBe("openai-responses");
        expect(resolved.baseURL).toBe("https://api.example.com/v1");
        expect(resolved.apiKey).toBe("sk-from-siyuan");
        expect(JSON.parse(resolved.customHeaders)).toEqual({"x-opencode-session": "{{vars.SESSION}}"});
    });

    it("智能体选项只用智能体的默认模型，与编辑器那一处无关", () => {
        setAi([PROVIDER, OTHER_PROVIDER], BOTH);
        expect(followDefaultTarget(PROVIDER_FOLLOW_AGENT)?.model).toBe("claude-x");
        const resolved = resolveApiSettings(followAgent());
        expect(resolved.model).toBe("claude-x");
        expect(resolved.protocol).toBe("anthropic-messages");
        expect(resolved.baseURL).toBe("https://other.example.com/v1");
        expect(resolved.apiKey).toBe("sk-other");
        // 供应商没配请求头时按「没有自定义请求头」处理
        expect(resolved.customHeaders).toBe("");
    });

    it("两条互不兜底：编辑器没设时编辑器选项报错，不改用智能体的模型", () => {
        setAi([PROVIDER, OTHER_PROVIDER], {agent: {modelId: "20260913135841-o1"}});
        expect(followDefaultTarget(PROVIDER_FOLLOW_EDITOR)).toBeUndefined();
        expect(() => resolveApiSettings(followEditor())).toThrow(/no default model for the editor AI/i);
    });

    it("两条互不兜底：智能体没设时智能体选项报错，不改用编辑器的模型", () => {
        setAi([PROVIDER, OTHER_PROVIDER], {editing: {modelId: "20260913135841-m2"}});
        expect(followDefaultTarget(PROVIDER_FOLLOW_AGENT)).toBeUndefined();
        expect(() => resolveApiSettings(followAgent())).toThrow(/no default model for the agent/i);
    });

    it("不支持自定义：两条选项都不读 siyuanModel 里残留的名字", () => {
        setAi([PROVIDER, OTHER_PROVIDER], BOTH);
        expect(resolveApiSettings(followEditor({siyuanModel: "typed-by-hand"})).model).toBe("gpt-5.2");
        expect(resolveApiSettings(followAgent({siyuanModel: "typed-by-hand"})).model).toBe("claude-x");
    });

    it("默认模型指向停用的模型、停用的供应商或不存在的 id 时按「没设」处理", () => {
        // m1 是停用的模型
        setAi([PROVIDER], {editing: {modelId: "20260913135841-m1"}});
        expect(followDefaultTarget(PROVIDER_FOLLOW_EDITOR)).toBeUndefined();
        setAi([{...PROVIDER, enabled: false}], {agent: {modelId: "20260913135841-m2"}});
        expect(followDefaultTarget(PROVIDER_FOLLOW_AGENT)).toBeUndefined();
        setAi([PROVIDER], {editing: {modelId: "20200101000000-0000000"}});
        expect(followDefaultTarget(PROVIDER_FOLLOW_EDITOR)).toBeUndefined();
        expect(() => resolveApiSettings(followEditor())).toThrow(ApiError);
    });

    it("模型 id 与模型名都认：思源自己两种都匹配", () => {
        setAi([PROVIDER], {editing: {modelId: "gpt-5.2"}});
        expect(followDefaultTarget(PROVIDER_FOLLOW_EDITOR)?.model).toBe("gpt-5.2");
    });

    it("取值带空格同样认得（手改过的配置）", () => {
        setAi([PROVIDER, OTHER_PROVIDER], BOTH);
        expect(followDefaultTarget(` ${PROVIDER_FOLLOW_EDITOR} `)?.model).toBe("gpt-5.2");
        expect(followDefaultTarget(` ${PROVIDER_FOLLOW_AGENT} `)?.model).toBe("claude-x");
    });

    it("传入具体供应商 id 或空值时不算跟随", () => {
        setAi([PROVIDER], BOTH);
        expect(followDefaultTarget(PROVIDER.id)).toBeUndefined();
        expect(followDefaultTarget("")).toBeUndefined();
        expect(followDefaultTarget("   ")).toBeUndefined();
    });

    it("没有宿主配置时返回 undefined，而不是抛错", () => {
        delete (globalThis as unknown as {window?: unknown}).window;
        expect(followDefaultTarget(PROVIDER_FOLLOW_EDITOR)).toBeUndefined();
        expect(followDefaultTarget(PROVIDER_FOLLOW_AGENT)).toBeUndefined();
    });
});

describe("供应商配置的读法（#27）", () => {
    it("模型名取 name，启用中的排在前面，空名与重名去掉", () => {
        expect(providerModelNames(PROVIDER)).toEqual(["gpt-5.2", "gpt-5.1"]);
        expect(providerModelNames({models: [{name: "b"}, {name: "a", enabled: true}, {name: "a"}, {name: "  "}]}))
            .toEqual(["a", "b"]);
        expect(providerModelNames({})).toEqual([]);
    });

    it("activeModelName 取启用中的模型，都没有时取第一条", () => {
        expect(activeModelName(PROVIDER)).toBe("gpt-5.2");
        expect(activeModelName({models: [{name: "only"}]})).toBe("only");
        expect(activeModelName({models: []})).toBe("");
    });

    it("协议缺省时按思源的默认值处理，多余空白去掉", () => {
        expect(providerProtocol({})).toBe(PROTOCOL_CHAT_COMPLETIONS);
        expect(providerProtocol({protocol: "  "})).toBe(PROTOCOL_CHAT_COMPLETIONS);
        expect(providerProtocol({protocol: " anthropic-messages "})).toBe("anthropic-messages");
    });

    it("没有宿主配置时读到空列表，而不是抛错", () => {
        expect(readSiyuanProviders()).toEqual([]);
    });
});
