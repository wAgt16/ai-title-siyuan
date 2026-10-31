/**
 * AI 标题生成插件入口。
 *
 * 四个入口最终都汇聚到 runGeneration：
 * 顶栏按钮、编辑器面包屑按钮、文档树右键菜单、命令面板。
 */
import {getActiveEditor, Plugin, showMessage, hideMessage} from "siyuan";
import type {ICommandContext, IMenu, IProtyle, TEventBus} from "siyuan";
import {parseCustomHeaders} from "./api/headers";
import {findSiyuanProvider} from "./api/siyuan-provider";
import {applyGeneratedSilently, openGenerateDialog, type NoteInfo} from "./dialog";
import {
    DEFAULT_SETTINGS,
    defaultTitleLanguage,
    hasProviderConfig,
    mergeSettings,
    PROTOCOL_SIYUAN_PROVIDER,
    STORAGE_NAME,
    type PluginSettings,
} from "./config";
import {getDocTitle} from "./content";
import {debug, debugJson, setDebug} from "./debug";
import {loadDeviceSelection, saveDeviceSelection, withoutDeviceState} from "./device-store";
import {makeT, type T} from "./i18n";
import {generateTitles, type GenerateOutcome, type NoteResult} from "./pipeline";
import {sealSettings, unsealSettings} from "./secret";
import {openSettingsPanel} from "./settings-panel";
import {ICON_ID, ICON_SVG} from "./icons";
import "./index.scss";

const TOP_BAR_ID = "ai-title-topbar";
const BREADCRUMB_ID = "ai-title-breadcrumb";
const PROGRESS_ID = "ai-title-progress";
/** 重复点击的回执共用这个 id：连点几次也只留一条，不刷屏。 */
const BUSY_ID = "ai-title-busy";

/** 文档树右键菜单事件的 detail，SDK 未导出该事件的具名类型。 */
interface DocTreeMenuDetail {
    menu: {addItem: (item: IMenu) => HTMLElement};
    elements: NodeListOf<HTMLElement>;
    type: string;
}

export default class AiTitlePlugin extends Plugin {
    private settings: PluginSettings = structuredClone(DEFAULT_SETTINGS);
    private t: T = makeT({});
    private topBarElement?: HTMLElement;
    private breadcrumbRegistered = false;
    /**
     * 生成流程是否正在进行（#40）。
     *
     * 四个入口共用这一道闸：一次生成没跑完就再点一次，不应该再发一轮请求 ——
     * 那既重复花钱，又会在最后弹出第二个确认窗口。
     */
    private generating = false;

    async onload(): Promise<void> {
        this.t = makeT(this.i18n);
        await this.loadSettings();
        this.addIcons(ICON_SVG);
        this.registerCommand();
        this.registerDocTreeMenu();
    }

    async onLayoutReady(): Promise<void> {
        this.syncUiEntries();
    }

    /** 配置被同步或覆盖后重新读取，避免内存里的旧值被写回。 */
    async onDataChanged(): Promise<void> {
        debug("Data changed, reloading settings");
        await this.loadSettings();
        this.syncUiEntries();
    }

    async onunload(): Promise<void> {
        debug("Plugin unloaded");
        this.removeTopBarEntry();
        this.removeBreadcrumbEntry();
    }

    openSetting(): void {
        openSettingsPanel({
            t: this.t,
            settings: this.settings,
            onSave: async (next) => {
                // 自定义请求头是手写的 JSON：在这里先解析一遍，写错时保存就会失败并说明原因，
                // 而不是等到第一次生成才报错（那时用户多半已经忘了自己填过什么）
                parseCustomHeaders(next.api.customHeaders);
                this.settings = next;
                setDebug(next.ui.debug);
                await this.persist(next);
                debugJson("Settings saved", this.redactedSettings(next));
                this.syncUiEntries();
            },
        });
    }

    /** 调试日志要能对账「这次到底用了什么」，但密钥不进日志。 */
    private redactedSettings(settings: PluginSettings): PluginSettings {
        return {
            ...settings,
            api: {
                ...settings.api,
                apiKey: settings.api.apiKey === "" ? "" : "(redacted)",
                apiKeyEncrypted: settings.api.apiKeyEncrypted === "" ? "" : "(redacted)",
                // 取值里常直接写着密钥（不只是 {{secrets.…}} 引用），整段都不进日志
                customHeaders: settings.api.customHeaders === "" ? "" : "(redacted)",
            },
        };
    }

    /**
     * 落盘。两件事在这里发生：
     * 1. API Key 换成密文（取不到思源数据仓库密钥时才退回明文，见 secret.ts）；
     * 2. 协议、思源供应商 id 与模型名改存本设备的 local storage，
     *    petal 那份（参与同步）里不写它们：它们都取决于本机思源自己的配置，
     *    同步到别的设备只会指向不存在的东西（#27、#31）。
     */
    private async persist(settings: PluginSettings): Promise<void> {
        await saveDeviceSelection({
            protocol: settings.api.protocol,
            provider: settings.api.siyuanProvider,
            model: settings.api.siyuanModel,
        });
        await this.saveData(STORAGE_NAME, await sealSettings(withoutDeviceState(settings)));
    }

    private async loadSettings(): Promise<void> {
        const stored = await this.loadData(STORAGE_NAME);
        const merged = mergeSettings(stored);
        const {settings, needsWrite, unreadable} = await unsealSettings(merged);
        this.settings = settings;
        setDebug(this.settings.ui.debug);

        // 首次运行时标题语言跟随思源界面语言，之后以用户设置为准。
        // 这里刻意不回写：loadData 读失败时返回空值，与真正的首次运行无法区分，
        // 一旦把它当成首次运行写回默认值，用户已存的配置就被覆盖掉了。
        // 代价只是在用户第一次保存之前，每次加载都要重新推导一次，结果相同。
        if (!stored) {
            this.settings.behavior.titleLanguage = defaultTitleLanguage(
                (window as unknown as {siyuan?: {config?: {lang?: string}}}).siyuan?.config?.lang ?? "en",
            );
        }

        await this.applyDeviceState(merged);

        // 解不开时按「清空 Key」处理，并且必须说一声：Key 无声消失只会让人以为插件坏了。
        // 用 info 而不是 error —— 这不是故障，是数据仓库密钥换了之后必然的结果。
        if (unreadable) {
            debug("Stored API key could not be decrypted, cleared it");
            showMessage(this.t("apiKeyUnreadable"), 12000);
        }
        // 旧版存下的明文 Key：当场迁移成密文，别等用户下次打开设置页才换
        if (needsWrite) {
            debug("Rewriting stored settings (plaintext API key or undecryptable ciphertext)");
            await this.persist(this.settings);
        }

        debug(`Settings loaded (debug mode on)`);
        debugJson("Settings loaded", this.redactedSettings(this.settings));
    }

    /**
     * 协议、供应商与模型名只在本设备成立，取本设备存下的那一份（#27、#31）。
     *
     * 思源自己的 AI 供应商配置不参与同步：协议跟着供应商走，同一条供应商 id 在别的设备上也不存在。
     * 1.1.0 只把供应商与模型名挪了出来，协议仍然同步；现在三项一起按设备存（#31），
     * 换设备就是换一套接口设置，不必在一台机器上替另一台机器背配置。
     *
     * 本设备还没存过时接手同步数据里的那一份（老配置升级上来的情况），随后回写一次把三项挪到本机。
     *
     * 无论当前是哪个模式都读：用户随时可能在设置页里切到该模式。
     */
    private async applyDeviceState(merged: PluginSettings): Promise<void> {
        const state = await loadDeviceSelection();
        if (state) {
            // 旧版本存下的选择里没有协议（那时它还在同步数据里）：接手当前这份，并回写补齐
            this.settings.api.protocol = state.protocol === "" ? merged.api.protocol : state.protocol;
            this.settings.api.siyuanProvider = state.provider;
            this.settings.api.siyuanModel = state.model;
            if (state.protocol === "") {
                debug("Adopting the synced protocol on this device");
                await this.persist(this.settings);
            }
            return;
        }
        // 本设备第一次跑这个版本：协议原样接手，供应商沿用 #27 的迁移规则
        // （只有本设备确实存在那个供应商时才接手，否则丢掉 —— 留着只会让设置页显示一个必然失败的供应商）
        const legacyProvider = merged.api.siyuanProvider;
        if (merged.api.protocol === PROTOCOL_SIYUAN_PROVIDER && legacyProvider !== "" &&
            findSiyuanProvider(legacyProvider)) {
            debug(`Adopting the synced provider selection "${legacyProvider}" on this device`);
            this.settings.api.siyuanProvider = legacyProvider;
            this.settings.api.siyuanModel = merged.api.model;
        } else {
            this.settings.api.siyuanProvider = "";
            this.settings.api.siyuanModel = "";
        }
        // 顺手回写一次：把这三项从同步用的那份数据里挪到本设备，落盘路径见 persist
        await this.persist(this.settings);
    }

    /** 三个界面开关的当前状态同步到实际注册的入口上。 */
    private syncUiEntries(): void {
        if (this.settings.ui.showTopBar) {
            this.addTopBarEntry();
        } else {
            this.removeTopBarEntry();
        }
        if (this.settings.ui.showBreadcrumb) {
            this.addBreadcrumbEntry();
        } else {
            this.removeBreadcrumbEntry();
        }
    }

    private addTopBarEntry(): void {
        if (this.topBarElement?.isConnected) {
            return;
        }
        this.topBarElement = this.addTopBar({
            id: TOP_BAR_ID,
            icon: ICON_ID,
            title: this.t("actionTopBar"),
            position: "right",
            callback: () => {
                const id = getActiveEditor()?.protyle?.block?.rootID;
                if (!id) {
                    showMessage(this.t("noActiveNote"), 6000, "error");
                    return;
                }
                void this.runGeneration([id], "topbar");
            },
        });
    }

    /** 基类已有同名的 removeTopBar/removeBreadcrumb，所以这里用 Entry 后缀区分。 */
    private removeTopBarEntry(): void {
        try {
            this.removeTopBar(TOP_BAR_ID);
        } catch {
            // 未注册时移除会抛错，忽略即可
        }
        this.topBarElement = undefined;
    }

    private addBreadcrumbEntry(): void {
        if (this.breadcrumbRegistered) {
            return;
        }
        this.addBreadcrumbButton({
            id: BREADCRUMB_ID,
            icon: ICON_ID,
            title: this.t("actionBreadcrumb"),
            callback: (_event, protyle: IProtyle) => {
                const id = protyle?.block?.rootID;
                if (!id) {
                    showMessage(this.t("noActiveNote"), 6000, "error");
                    return;
                }
                void this.runGeneration([id], "breadcrumb");
            },
        });
        this.breadcrumbRegistered = true;
    }

    private removeBreadcrumbEntry(): void {
        if (!this.breadcrumbRegistered) {
            return;
        }
        try {
            this.removeBreadcrumbButton(BREADCRUMB_ID);
        } catch {
            // 未注册时移除会抛错，忽略即可
        }
        this.breadcrumbRegistered = false;
    }

    private registerCommand(): void {
        this.addCommand({
            langKey: "commandGenerate",
            langText: this.t("commandGenerate"),
            execute: (context: ICommandContext) => {
                const id = context.protyle?.block?.rootID ?? getActiveEditor()?.protyle?.block?.rootID;
                if (!id) {
                    showMessage(this.t("noActiveNote"), 6000, "error");
                    return;
                }
                void this.runGeneration([id], "command");
            },
        });
    }

    /**
     * 文档树右键菜单。只处理单篇与多篇文档选中：
     * 笔记本和混合选中不显示入口，因为插件处理的是笔记而不是笔记本。
     * 菜单项会被思源自动收进「插件」子菜单。
     */
    private registerDocTreeMenu(): void {
        const handler = (event: CustomEvent<DocTreeMenuDetail>): void => {
            // 开关在注册之后才可能被改动，所以在这里读实时配置
            if (!this.settings.ui.showDocTreeMenu) {
                return;
            }
            const {menu, elements, type} = event.detail;
            if (type !== "doc" && type !== "docs") {
                return;
            }
            const ids = Array.from(elements)
                .filter((element) => element.getAttribute("data-type") === "navigation-file")
                .map((element) => element.getAttribute("data-node-id"))
                .filter((id): id is string => !!id);
            if (ids.length === 0) {
                return;
            }
            menu.addItem({
                icon: ICON_ID,
                label: ids.length === 1 ? this.t("actionSingle") : this.t("actionMultiple", {count: ids.length}),
                click: () => void this.runGeneration(ids, "doc-tree"),
            });
        };

        this.eventBus.on("open-menu-doctree" as TEventBus, handler as (event: CustomEvent<unknown>) => void);
    }

    /** 四个入口共用的执行路径：取正文 → 并发请求 → 弹窗或直接应用。 */
    private async runGeneration(ids: string[], source: string): Promise<void> {
        const {api, behavior} = this.settings;
        // 闸在第一个 await 之前落下：慢的是网络，重复点击往往正发生在这一段
        if (this.generating) {
            debug(`Ignored a repeated generation request from "${source}"`);
            showMessage(this.t("alreadyGenerating"), 3000, "info", BUSY_ID);
            return;
        }
        debug(`Generation requested from "${source}" for ${ids.length} note(s): ${ids.join(", ")}`);
        if (!hasProviderConfig(api)) {
            showMessage(this.t("noProvider"), 6000, "error");
            return;
        }
        // 记下这次真正生效的参数：配置项多了以后，「我明明改了」和「实际发出去的是什么」
        // 是两件事
        debugJson("Settings in effect", this.redactedSettings(this.settings));

        this.generating = true;
        try {
            const outcome = await generateTitles({
                ids,
                api,
                behavior,
                onProgress: (done, total) => {
                    // 只有确实分批时才值得显示进度
                    if (total > 1) {
                        showMessage(this.t("progressMessage", {done, total}), -1, "info", PROGRESS_ID);
                    }
                },
            });
            hideMessage(PROGRESS_ID);
            this.reportIneffectiveReasoning(outcome.reasoning);
            await this.handleOutcome(ids, outcome.results, outcome.batchErrors);
        } catch (error) {
            hideMessage(PROGRESS_ID);
            const message = error instanceof Error ? error.message : String(error);
            debug(`Generation aborted: ${message}`);
            showMessage(message, 12000, "error");
        } finally {
            // 出错也要放开，否则一次异常会让插件此后一直「正在生成」
            this.generating = false;
        }
    }

    private async handleOutcome(ids: string[], results: NoteResult[], batchErrors: string[]): Promise<void> {
        const notes = await this.collectNoteInfo(ids);
        const generated = results.filter((result) => result.title !== undefined);
        debug(`Generation finished: ${generated.length}/${ids.length} title(s) produced`);
        if (batchErrors.length > 0) {
            debug(`${batchErrors.length} batch(es) failed`, batchErrors);
        }

        if (generated.length === 0) {
            this.reportFailures(results, notes);
            return;
        }

        // 「总是」是字面意思：单篇还是多篇都直接写回，不再拦一道确认。
        // 「仅单篇笔记」则只在确实是一篇时静默，多篇仍然先给确认窗口。
        // 批次出错时同样会弹窗（见下面的 batchErrors 条件）——
        // 那种情况下有一部分笔记没有拿到标题，值得让人先看一眼再决定。
        const mayApplySilently = this.settings.behavior.autoApply === "always" ||
            (this.settings.behavior.autoApply === "single" && ids.length === 1);

        if (mayApplySilently && batchErrors.length === 0) {
            debug("Auto-apply allows it: writing titles back without the review dialog");
            await applyGeneratedSilently(this.t, results, notes);
            this.reportFailures(results, notes);
            return;
        }

        debug("Opening the review dialog");
        openGenerateDialog({
            t: this.t,
            results,
            batchErrors,
            notes,
            api: this.settings.api,
            behavior: this.settings.behavior,
        });
    }

    /**
     * 开了「禁用思考」、模型却仍在推理时提示一次。
     *
     * 这类失败不会以报错的形式出现 —— 供应商不认那个字段时通常静默忽略，
     * 请求照样成功，只是每次都在为一个用不上的思维链多付 token 和等待。
     * 所以这里必须主动说，否则用户没有任何办法发现开关是空的。
     */
    private reportIneffectiveReasoning(reasoning: GenerateOutcome["reasoning"]): void {
        if (!reasoning) {
            return;
        }
        debug(`Disable thinking had no effect in ${reasoning.batches} batch(es), ${reasoning.tokens ?? "?"} reasoning token(s)`);
        showMessage(
            reasoning.tokens === undefined
                ? this.t("reasoningStillOnNoCount")
                : this.t("reasoningStillOn", {tokens: reasoning.tokens}),
            12000,
            "error",
        );
    }

    /** 取每篇笔记当前的标题，用于确认窗口里的对比展示与提示文案。 */
    private async collectNoteInfo(ids: string[]): Promise<Map<string, NoteInfo>> {
        const notes = new Map<string, NoteInfo>();
        for (const id of ids) {
            let title = id;
            try {
                title = (await getDocTitle(id)) || id;
            } catch {
                // 取不到标题就退回用 id，不影响流程
            }
            notes.set(id, {id, title});
        }
        return notes;
    }

    /** 未生成成功的笔记统一提示，避免逐条弹提示刷屏。 */
    private reportFailures(results: NoteResult[], notes: Map<string, NoteInfo>): void {
        const failed = results.filter((result) => result.title === undefined);
        if (failed.length === 0) {
            return;
        }
        debug(
            `${failed.length} note(s) have no title`,
            failed.map((result) => `${result.id}: ${result.reason ?? "unknown"}`).join(", "),
        );
        const label = (id: string): string => notes.get(id)?.title ?? id;
        const missing = failed.filter((result) =>
            result.reason === "notReturned" || result.reason === "parseFailed");
        const skipped = failed.filter((result) => result.reason === "skippedEmpty");
        const errored = failed.filter((result) =>
            result.reason === "emptyContent" || result.reason === "fetchFailed");

        if (missing.length > 0) {
            showMessage(this.t("summaryNotReturned", {
                count: missing.length,
                list: missing.map((result) => label(result.id)).join("、"),
            }), 10000, "error");
        }
        if (skipped.length > 0) {
            // 空笔记没发过请求，必须说清楚「跳过」不是「失败」，
            // 否则用户会去翻供应商配置找一个根本不存在的故障
            showMessage(this.t("summarySkipped", {
                count: skipped.length,
                list: skipped.map((result) => label(result.id)).join("、"),
            }), 3000);
        }
        for (const result of errored) {
            const message = result.reason === "emptyContent"
                ? this.t("errorEmptyContent")
                : result.message ?? this.t("errorNotFound");
            showMessage(`${label(result.id)}：${message}`, 10000, "error");
        }
    }
}
