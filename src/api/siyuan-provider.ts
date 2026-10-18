/**
 * 从思源自己的 AI 供应商配置里取接口参数（#27）。
 *
 * 「使用思源设置中供应商」模式下，协议、Base URL、API Key 与请求头都不进插件的数据目录：
 * 每次发请求前现读 `window.siyuan.config.ai.providers`，思源那边改了什么立刻跟着变，
 * 卸载插件也不会留下一份副本。插件只存供应商 id 与模型名。
 *
 * 同一模式下还有「跟随编辑器默认」与「跟随智能体默认」（#28）：它们连供应商与模型名
 * 也不存，分别取思源里编辑器 AI / 智能体选中的默认模型 —— 见 followDefaultTarget。
 *
 * 两点与插件自己的实现对齐：
 * - 供应商配的请求头走和插件自定义请求头**完全相同**的解析路径（api/headers.ts），
 *   所以里面的 `{{vars.名字}}` / `{{secrets.名字}}` 一样会在每次请求前替换；
 * - 供应商的协议缺省时按 `"openai"` 处理，与思源自己的默认值一致
 *   （app/src/config/tabs/ai/aiProviderUi.ts 的 `draft.protocol ||= "openai"`）。
 *
 * 非管理员角色下内核会把整个 AI 配置清空（kernel/api/system.go 的 HideConfSecret），
 * 这时读到的供应商列表是空的，于是这里报「供应商不存在」而不是发一个没有鉴权的请求。
 */
import {ApiError} from "./protocol";
import {
    type AdapterProtocol,
    type ApiSettings,
    isAdapterProtocol,
    isFollowDefaultProvider,
    PROTOCOL_CHAT_COMPLETIONS,
    PROTOCOL_SIYUAN_PROVIDER,
    PROVIDER_FOLLOW_AGENT,
    PROVIDER_FOLLOW_EDITOR,
} from "../config";

export interface SiyuanProviderModel {
    id?: string;
    /** 发到接口上的模型名。思源给每个模型另生成一个内部 id，那个不能当模型名用。 */
    name?: string;
    displayName?: string;
    enabled?: boolean;
}

/** 思源「设置 → AI → 供应商」里的一条供应商，只声明插件用得到的字段。 */
export interface SiyuanProvider {
    id?: string;
    displayName?: string;
    enabled?: boolean;
    baseURL?: string;
    apiKey?: string;
    protocol?: string;
    /** 供应商自定义请求头，形如 {"x-opencode-session": "{{vars.SESSION}}"}。 */
    headers?: Record<string, string>;
    models?: SiyuanProviderModel[];
}

interface SiyuanConfig {
    ai?: {
        providers?: SiyuanProvider[];
        /** 编辑器 AI 的默认模型（#28）。存的是思源内部的模型 id。 */
        editing?: {modelId?: string};
        /** 智能体的默认模型（#28）。 */
        agent?: {modelId?: string};
    };
}

/**
 * 思源自己的 AI 配置。
 *
 * 桌面端管理员角色下 apiKey 是明文；非管理员或发布访客读不到（内核整体清空），
 * 这时返回空列表，调用方给出一致的「供应商不存在」提示。
 */
function siyuanConfig(): SiyuanConfig | undefined {
    if (typeof window === "undefined") {
        // 单元测试没有宿主，也没有「用思源供应商」这条路可走
        return undefined;
    }
    return (window as unknown as {siyuan?: {config?: SiyuanConfig}}).siyuan?.config;
}

export function readSiyuanProviders(): SiyuanProvider[] {
    return siyuanConfig()?.ai?.providers ?? [];
}

/** 供应商实际使用的协议。字段缺失时按思源自己的默认值处理。 */
export function providerProtocol(provider: SiyuanProvider): string {
    return (provider.protocol ?? "").trim() || PROTOCOL_CHAT_COMPLETIONS;
}

/** 供应商实际在用的模型名。一个供应商可以配多个模型，优先取启用中的那个。 */
export function activeModelName(provider: SiyuanProvider): string {
    const models = provider.models ?? [];
    const active = models.find((model) => model.enabled) ?? models[0];
    return active?.name ?? "";
}

/** 供应商登记的全部模型名，启用中的排在前面。设置页的模型下拉用它。 */
export function providerModelNames(provider: SiyuanProvider): string[] {
    const enabled: string[] = [];
    const rest: string[] = [];
    for (const model of provider.models ?? []) {
        const name = (model.name ?? "").trim();
        if (name === "" || enabled.includes(name) || rest.includes(name)) {
            continue;
        }
        (model.enabled ? enabled : rest).push(name);
    }
    return [...enabled, ...rest];
}

export function findSiyuanProvider(id: string): SiyuanProvider | undefined {
    return readSiyuanProviders().find((provider) => provider.id === id);
}

/** 一条供应商配置，外加发请求时该用的模型名。 */
export interface ProviderTarget {
    provider: SiyuanProvider;
    /** 发到接口上的模型名（供应商的 name，不是思源内部的模型 id）。 */
    model: string;
}

/**
 * 按思源内部的模型 id 找到它所属的供应商与模型名。
 *
 * 与思源自己的找法一致（app/src/ai/editor.ts 的 getEditingModelName、
 * app/src/layout/dock/agent/agentModel.ts）：只认启用中的供应商与启用中的模型，
 * id 与 name 都允许匹配。停用的条目再手动选一次模型也不算数 —— 那种模型思源自己也不会用。
 */
function findModelTarget(modelID: string): ProviderTarget | undefined {
    if (modelID === "") {
        return undefined;
    }
    for (const provider of readSiyuanProviders()) {
        if (!provider.enabled) {
            continue;
        }
        const model = (provider.models ?? []).find((item) =>
            item.enabled === true && (item.id === modelID || item.name === modelID));
        const name = (model?.name ?? "").trim();
        if (model && name !== "") {
            return {provider, model: name};
        }
    }
    return undefined;
}

/**
 * 「跟随编辑器默认」/「跟随智能体默认」实际会用的模型（#28）。
 *
 * 两条各只看自己那一处默认模型：编辑器取 config.ai.editing.modelId，智能体取
 * config.ai.agent.modelId，互不兜底。两个默认模型在思源里可以不同，交叉兜底会让
 * 其中一个选项在没设默认模型时悄悄改用另一个的模型 —— 那既不是用户选的，也无法从界面上看出来。
 *
 * 没设、指向的模型或供应商已停用、或指向一个已被删除的模型时返回 undefined，
 * 由调用方报错：这时请求参数根本不完整，不能拿一条猜出来的模型顶上去。
 * 传入具体供应商 id 时同样返回 undefined。
 */
export function followDefaultTarget(provider: string): ProviderTarget | undefined {
    const ai = siyuanConfig()?.ai;
    const scope = provider.trim();
    const modelID = scope === PROVIDER_FOLLOW_AGENT
        ? ai?.agent?.modelId
        : scope === PROVIDER_FOLLOW_EDITOR ? ai?.editing?.modelId : "";
    return findModelTarget((modelID ?? "").trim());
}

/**
 * 一条解析完毕、可以直接发出去的接口配置。
 * protocol 收窄成适配器认识的几个：「使用思源设置中供应商」在这里已经换成了供应商的协议。
 */
export type ResolvedApiSettings = Omit<ApiSettings, "protocol"> & {protocol: AdapterProtocol};

/**
 * 把配置解析成实际发请求用的那一份。
 *
 * 自定义配置原样返回（只做类型收窄）；「使用思源设置中供应商」则整条换成供应商的
 * 协议、地址、密钥与请求头，模型留空时用供应商启用中的那个顶上；
 * 两条「跟随默认」（#28）连供应商与模型名也由思源决定。
 *
 * 解析不出来时抛 ApiError：这时请求参数根本不完整，早报比发出去一个必然 401 的请求好。
 * 消息是英文，与协议层其他报错一致（它们都会被原样弹给用户）。
 */
export function resolveApiSettings(api: ApiSettings): ResolvedApiSettings {
    if (api.protocol !== PROTOCOL_SIYUAN_PROVIDER) {
        return {...api, protocol: api.protocol};
    }
    return resolveFromProvider(api, providerTarget(api));
}

/** 当前这一档要用的供应商与模型名，解析不出来时当场报错。 */
function providerTarget(api: ApiSettings): ProviderTarget {
    if (isFollowDefaultProvider(api.siyuanProvider)) {
        const target = followDefaultTarget(api.siyuanProvider);
        if (!target) {
            // 两条分别报，各自指向自己在思源里的位置：编辑器与智能体的默认模型是两处设置
            throw new ApiError(
                api.siyuanProvider.trim() === PROVIDER_FOLLOW_AGENT
                    ? "SiYuan has no default model for the agent. Set one in SiYuan AI settings, " +
                    "or select a provider in the plugin settings."
                    : "SiYuan has no default model for the editor AI. Set one in SiYuan AI settings, " +
                    "or select a provider in the plugin settings.",
                false,
            );
        }
        return target;
    }

    const id = api.siyuanProvider.trim();
    if (id === "") {
        throw new ApiError("No SiYuan provider is selected. Pick one in the plugin settings.", false);
    }
    const provider = findSiyuanProvider(id);
    if (!provider) {
        throw new ApiError(
            `SiYuan provider "${id}" was not found. Add it in SiYuan AI settings, or pick another one in the plugin settings.`,
            false,
        );
    }
    // 模型名是每设备独立选的（见 device-store.ts），没选时用供应商启用中的那个兜底
    return {provider, model: api.siyuanModel.trim() === "" ? activeModelName(provider) : api.siyuanModel};
}

/** 一条供应商配置 → 实际发请求用的接口配置：协议、地址、密钥与请求头都换成它的。 */
function resolveFromProvider(api: ApiSettings, target: ProviderTarget): ResolvedApiSettings {
    const {provider, model} = target;
    const id = provider.id ?? "";
    const protocol = providerProtocol(provider);
    if (!isAdapterProtocol(protocol)) {
        throw new ApiError(
            `SiYuan provider "${id}" uses the protocol "${protocol}", which this plugin does not implement.`,
            false,
        );
    }
    const baseURL = (provider.baseURL ?? "").trim();
    if (baseURL === "") {
        throw new ApiError(`SiYuan provider "${id}" has no base URL. Fill it in under SiYuan AI settings.`, false);
    }

    return {
        ...api,
        protocol,
        baseURL,
        apiKey: provider.apiKey ?? "",
        // 请求头交给 headers.ts 去解析与插值：与插件自己的自定义头是同一条路径
        customHeaders: providerHeadersText(provider),
        model,
    };
}

/** 供应商的请求头转成 headers.ts 认的那段 JSON 文本；没有请求头时返回空串。 */
function providerHeadersText(provider: SiyuanProvider): string {
    const headers = provider.headers ?? {};
    return Object.keys(headers).length === 0 ? "" : JSON.stringify(headers);
}
