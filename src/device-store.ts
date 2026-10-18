/**
 * 只在本设备生效的插件状态（#27、#31）。
 *
 * 走内核的 local storage（`data/storage/local.json`，接口 `/api/storage/*LocalStorageVal`），
 * 而不是插件自己的 petal 数据，原因是两者的同步范围不同：
 * - petal（`plugin.loadData` / `saveData` 写的那份）**参与思源的数据同步** ——
 *   kernel/model/repository.go 对 `/storage/petal/` 的改动会重载插件并进入同步；
 * - `storage/local.json` **不参与同步** —— kernel/model/sync_ignore.go 把它列在忽略名单里。
 *
 * 为什么必须区分：这里的三项全都取决于本机思源自己的配置，而思源的 AI 供应商配置不在同步范围里。
 * - 协议（#31）：它跟着供应商走，同一个协议在别的设备上未必有对应的供应商；
 * - 供应商 id 与模型名（#27）：同一个 id 在别的设备上根本不存在，请求必然以「供应商不存在」失败。
 *
 * 三项一起同步过去，就成了「另一台设备拿着不属于它的配置发请求」——
 * 症状是一堆看不懂的 401/404，而不是设置没配好。
 */
import {fetchSyncPost} from "siyuan";
import {isProtocol, type PluginSettings, type Protocol} from "./config";
import {debug, debugError} from "./debug";

/** 本设备上的接口来源：用哪个协议、哪个思源供应商、哪个模型名。 */
export interface DeviceSelection {
    /** 生成协议；旧版本存下的选择里没有这一项，读出来是空串。 */
    protocol: Protocol | "";
    provider: string;
    model: string;
}

/**
 * local storage 里的键名。带插件名前缀，免得和思源自己的键（layout、local-searchkeys…）撞车。
 *
 * 键名沿用最初只存供应商时的那个：改名会让已经存下的选择凭空消失，
 * 用户下次打开设置页还得重选一遍。
 */
const SELECTION_KEY = "ai-title-siyuan-provider";

/** 只取内核响应里我们认识的那几个字段。 */
interface StorageResponse {
    code?: number;
    msg?: string;
    data?: unknown;
}

/**
 * 读本设备的选择。
 *
 * 没存过、读不到、或内核报错时一律返回 undefined —— 这只是「本设备还没选过」，
 * 不该拦住插件加载，设置页会显示成需要用户选一个。
 */
export async function loadDeviceSelection(): Promise<DeviceSelection | undefined> {
    let response: StorageResponse;
    try {
        response = (await fetchSyncPost("/api/storage/getLocalStorageVal", {key: SELECTION_KEY})) as StorageResponse;
    } catch (error) {
        debugError("Failed to read the local selection", error);
        return undefined;
    }
    if (response?.code !== 0) {
        debugError("Failed to read the local selection", response?.msg ?? response?.code);
        return undefined;
    }
    const data = response.data;
    if (!data || typeof data !== "object") {
        return undefined;
    }
    const {protocol, provider, model} = data as {protocol?: unknown; provider?: unknown; model?: unknown};
    const selection: DeviceSelection = {
        // 手改坏的值按「没存过协议」处理，由调用方退回同步数据里那份
        protocol: isProtocol(protocol) ? protocol : "",
        provider: typeof provider === "string" ? provider : "",
        model: typeof model === "string" ? model : "",
    };
    debug(`Local selection: ${selection.protocol || "-"} / "${selection.provider}" / "${selection.model}"`);
    return selection;
}

/**
 * 写本设备的选择。
 *
 * 写失败只记日志：它只影响「下次打开设置页还记不记得用的是什么」，
 * 不该让一次设置保存整体失败。
 */
export async function saveDeviceSelection(selection: DeviceSelection): Promise<void> {
    try {
        const response = (await fetchSyncPost("/api/storage/setLocalStorageVal", {
            key: SELECTION_KEY,
            val: selection,
        })) as StorageResponse;
        if (response?.code !== 0) {
            debugError("Failed to store the local selection", response?.msg ?? response?.code);
        }
    } catch (error) {
        debugError("Failed to store the local selection", error);
    }
}

/**
 * 落盘（petal，参与同步）用的配置：把只在本设备成立的三项清掉，其余原样。
 *
 * 协议整个字段删掉而不是留个空串：留空串会落进 mergeSettings 的「认不出来」分支、
 * 退回 Chat Completions，而删掉字段才能走回默认值 —— 那才是「这台设备还没选过」该有的样子。
 */
export function withoutDeviceState(settings: PluginSettings): PluginSettings {
    const synced = structuredClone(settings);
    synced.api.siyuanProvider = "";
    synced.api.siyuanModel = "";
    delete (synced.api as {protocol?: Protocol}).protocol;
    return synced;
}
