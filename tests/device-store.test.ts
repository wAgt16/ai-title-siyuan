import {beforeEach, describe, expect, it} from "vitest";
import {DEFAULT_SETTINGS, mergeSettings, PROTOCOL_SIYUAN_PROVIDER, type PluginSettings} from "../src/config";
import {loadDeviceSelection, saveDeviceSelection, withoutDeviceState} from "../src/device-store";
import {setFetchSyncPost} from "./stubs/siyuan";

/** 记录每次内核调用，便于断言用的是哪个端点、发了什么。 */
interface Call {
    url: string;
    data: Record<string, unknown>;
}

let calls: Call[] = [];

function stub(response: unknown): void {
    setFetchSyncPost((url, data) => {
        calls.push({url, data: (data ?? {}) as Record<string, unknown>});
        return Promise.resolve(response);
    });
}

/** 一份带「本设备接口来源」的配置。 */
function settings(overrides: Partial<PluginSettings["api"]> = {}): PluginSettings {
    return {
        ...structuredClone(DEFAULT_SETTINGS),
        api: {
            ...DEFAULT_SETTINGS.api,
            protocol: PROTOCOL_SIYUAN_PROVIDER,
            siyuanProvider: "20260913135841-1u2j84c",
            siyuanModel: "gpt-5.2",
            ...overrides,
        },
    };
}

beforeEach(() => {
    calls = [];
    setFetchSyncPost(() => Promise.reject(new Error("fetchSyncPost was not stubbed for this test")));
});

describe("每设备的接口来源（#27 #31 不参与数据同步）", () => {
    it("读的是内核 local storage，键名带插件名前缀", async () => {
        stub({code: 0, msg: "", data: {protocol: "openai-responses", provider: "p1", model: "gpt-5.1"}});
        await expect(loadDeviceSelection()).resolves.toEqual({
            protocol: "openai-responses",
            provider: "p1",
            model: "gpt-5.1",
        });
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe("/api/storage/getLocalStorageVal");
        expect(calls[0].data.key).toBe("ai-title-siyuan-provider");
    });

    it("写的是内核 local storage，值就是这三项", async () => {
        stub({code: 0, msg: "", data: null});
        await saveDeviceSelection({protocol: "anthropic-messages", provider: "p1", model: "gpt-5.1"});
        expect(calls[0].url).toBe("/api/storage/setLocalStorageVal");
        expect(calls[0].data).toEqual({
            key: "ai-title-siyuan-provider",
            val: {protocol: "anthropic-messages", provider: "p1", model: "gpt-5.1"},
        });
    });

    it("没存过（data 为 null）时返回 undefined，而不是一份空值", async () => {
        stub({code: 0, msg: "", data: null});
        await expect(loadDeviceSelection()).resolves.toBeUndefined();
    });

    it("旧版本存下的选择里没有协议，读成空串由调用方接手同步数据里那份", async () => {
        stub({code: 0, msg: "", data: {provider: "p1", model: "gpt-5.1"}});
        await expect(loadDeviceSelection()).resolves.toEqual({protocol: "", provider: "p1", model: "gpt-5.1"});
    });

    it("值被手改坏时按缺字段处理，不抛错", async () => {
        stub({code: 0, msg: "", data: {protocol: 42, provider: 42, model: "gpt-5.1"}});
        await expect(loadDeviceSelection()).resolves.toEqual({protocol: "", provider: "", model: "gpt-5.1"});
        // 认不出来的协议不能留着：它会被当成「这台设备选过协议」而挡住同步数据里那份
        stub({code: 0, msg: "", data: {protocol: "gemini", provider: "p1", model: "m"}});
        await expect(loadDeviceSelection()).resolves.toEqual({protocol: "", provider: "p1", model: "m"});
        stub({code: 0, msg: "", data: "not an object"});
        await expect(loadDeviceSelection()).resolves.toBeUndefined();
    });

    it("内核报错或调用失败时返回 undefined，不拦住插件加载", async () => {
        stub({code: -1, msg: "nope"});
        await expect(loadDeviceSelection()).resolves.toBeUndefined();
        setFetchSyncPost(() => Promise.reject(new Error("boom")));
        await expect(loadDeviceSelection()).resolves.toBeUndefined();
        // 写失败同样只记日志
        await expect(saveDeviceSelection({protocol: "openai", provider: "p1", model: "m"})).resolves.toBeUndefined();
    });

    it("落盘用的配置里这三项都不在，其余原样", () => {
        const synced = withoutDeviceState(settings());
        expect(synced.api.siyuanProvider).toBe("");
        expect(synced.api.siyuanModel).toBe("");
        // 协议整个字段删掉：留空串会落进 mergeSettings 的「认不出来」分支退回 Chat Completions，
        // 删掉才能走回默认值
        expect("protocol" in synced.api).toBe(false);
        // 其余字段一个都不能动：它们仍然要同步
        expect(synced.api.baseURL).toBe(DEFAULT_SETTINGS.api.baseURL);
        expect(synced.api.temperature).toBe(DEFAULT_SETTINGS.api.temperature);
        expect(synced.behavior.batchSize).toBe(DEFAULT_SETTINGS.behavior.batchSize);
        // 原对象不能被改：调用方还在用它
        expect(settings().api.siyuanProvider).toBe("20260913135841-1u2j84c");
        expect(settings().api.protocol).toBe(PROTOCOL_SIYUAN_PROVIDER);
    });

    it("落盘的那份读回来是默认协议，而不是 Chat Completions（#31）", () => {
        // 这条盯的是「删字段」与「留空串」的区别：留空串会被 mergeSettings 判成认不出来的取值、
        // 退回 Chat Completions，于是别的设备会拿着同步过去的地址与密钥按错误格式发请求
        const stored = JSON.parse(JSON.stringify(withoutDeviceState(settings()))) as unknown;
        const revived = mergeSettings(stored);
        expect(revived.api.protocol).toBe(DEFAULT_SETTINGS.api.protocol);
        expect(revived.api.siyuanProvider).toBe("");
        expect(revived.api.siyuanModel).toBe("");
    });
});
