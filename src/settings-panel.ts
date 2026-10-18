/**
 * 设置面板。
 *
 * 用 Dialog 而不是 Setting：Setting.addItem 只能把一个控件塞进一行，表达不了分组，
 * 分组标题会长得和普通设置项一模一样。这里按思源设置页自己的标记结构产出内容
 * （`.config` > `.config-title` + `.config-items`），直接复用那套样式规则；
 * 保存/取消按钮的搭法照抄 Setting 的实现，所以外观与行为一致。
 *
 * 控件只绑事件、不写初值：初值统一由各组返回的 sync 写入，
 * 与「导入后重刷」共用同一条路径。漏掉开头那次 sync 会让面板一律显示空白——
 * 存进去的配置看上去就像根本没保存成功。
 */
import {Dialog, Menu, showMessage} from "siyuan";
import {listModels, testConnection} from "./api/client";
import {
    activeModelName,
    followDefaultTarget,
    providerModelNames,
    providerProtocol,
    readSiyuanProviders,
} from "./api/siyuan-provider";
import {
    AUTO_APPLY_ALWAYS,
    AUTO_APPLY_NEVER,
    AUTO_APPLY_OPTIONS,
    AUTO_APPLY_SINGLE,
    DEFAULT_SETTINGS,
    hasProviderConfig,
    hasProviderEndpoint,
    isAdapterProtocol,
    isFollowDefaultProvider,
    MEDIA_DROP,
    MEDIA_OPTIONS,
    MEDIA_PLACEHOLDER,
    MEDIA_RAW,
    PROTOCOL_ANTHROPIC_MESSAGES,
    PROTOCOL_CHAT_COMPLETIONS,
    PROTOCOL_GEMINI_INTERACTIONS,
    PROTOCOL_RESPONSES,
    PROTOCOL_SIYUAN_PROVIDER,
    PROTOCOLS,
    PROVIDER_FOLLOW_AGENT,
    PROVIDER_FOLLOW_EDITOR,
    REASONING_DEFAULT,
    REASONING_EFFORT_OFF,
    REASONING_OPTIONS,
    TOC_ALWAYS,
    TOC_NEVER,
    TOC_OPTIONS,
    TOC_TRUNCATED,
    TRUNCATE_BOTH,
    TRUNCATE_FULL,
    TRUNCATE_HEAD,
    TRUNCATE_OPTIONS,
    TRUNCATE_TAIL,
    type AutoApply,
    type MediaMode,
    type PluginSettings,
    type ReasoningEffort,
    type TocMode,
    type TruncateMode,
} from "./config";
import {setDebug} from "./debug";
import type {T} from "./i18n";
import {canEncrypt} from "./secret";

/**
 * 供应商是否靠自己配的请求头鉴权（与思源自己的判定一致：
 * app/src/config/tabs/ai/aiProviderHeaders.ts 的 hasProviderHeaderAuth）。
 * 这类供应商的 API Key 本来就是空的，导入时不能因为它们「没填 key」就把它们筛掉。
 */
function hasHeaderAuth(headers: Record<string, string> | undefined): boolean {
    return Object.entries(headers ?? {}).some(([name, value]) =>
        ["authorization", "x-api-key", "api-key"].includes(name.toLowerCase()) && value.trim() !== "");
}

/** 请求头按 JSON 对象写进设置页的文本框；没有请求头时留空。 */
function formatHeaders(headers: Record<string, string> | undefined): string {
    return headers && Object.keys(headers).length > 0 ? JSON.stringify(headers, null, 2) : "";
}

/** 把配置写回本组各控件。导入会整体替换接口配置，届时需要重跑。 */
type Sync = () => void;

/**
 * 分组容器：与思源设置页同构（.config > .config-title + .config-items）。
 * 必须挂在 .config 之下，否则这些规则不生效。
 */
function createGroup(root: HTMLElement, title: string): HTMLElement {
    const heading = document.createElement("div");
    heading.className = "config-title";
    heading.textContent = title;

    const items = document.createElement("div");
    items.className = "config-items";

    root.append(heading, items);
    return items;
}

/** 设置项的标题与说明，两种布局共用。 */
function labelBlock(title: string, description: string): HTMLElement {
    const box = document.createElement("div");
    const name = document.createElement("div");
    name.className = "config-name";
    name.textContent = title;
    box.append(name);
    if (description !== "") {
        const text = document.createElement("div");
        text.className = "b3-label__text";
        text.textContent = description;
        box.append(text);
    }
    return box;
}

/**
 * 左标题右控件。
 * 开关交给思源自己渲染：Setting 见到含 b3-switch 的行会把它变成 label，
 * 整行可点即可切换；其余控件补 fn__size200 保持设置页统一的控件宽度。
 * 返回整行，便于调用方按条件隐藏（如「保留开头和末尾」才需要比例输入）。
 */
function rowItem(items: HTMLElement, title: string, description: string, field: HTMLElement): HTMLElement {
    const isSwitch = field.classList.contains("b3-switch");
    const row = document.createElement(isSwitch ? "label" : "div");
    row.className = "fn__flex b3-label config-item";

    const main = labelBlock(title, description);
    main.classList.add("fn__flex-1");

    const space = document.createElement("span");
    space.className = "fn__space";

    field.classList.add("fn__flex-center");
    if (!isSwitch) {
        field.classList.add("fn__size200");
    }

    row.append(main, space, field);
    items.append(row);
    return row;
}

/** 标题在上、控件占满整行。文本域和「下拉 + 附加输入」这类组合控件用这个。 */
function stackItem(items: HTMLElement, title: string, description: string, field: HTMLElement): HTMLElement {
    const row = document.createElement("div");
    row.className = "b3-label config-item";

    const block = document.createElement("div");
    block.className = "fn__block";

    const space = document.createElement("div");
    space.className = "fn__hr";

    field.classList.add("fn__block");
    block.append(labelBlock(title, description), space, field);
    row.append(block);
    items.append(row);
    return row;
}

function input(className = "b3-text-field"): HTMLInputElement {
    const node = document.createElement("input");
    node.className = className;
    return node;
}

function select(): HTMLSelectElement {
    const node = document.createElement("select");
    node.className = "b3-select";
    return node;
}

function textarea(rows: number): HTMLTextAreaElement {
    const node = document.createElement("textarea");
    node.className = "b3-text-field fn__block";
    node.rows = rows;
    return node;
}

/** 官方开关：b3-switch 必须落在 input 上，包一层 label 会同时画出原生复选框和畸形胶囊。 */
function switchControl(): HTMLInputElement {
    const node = document.createElement("input");
    node.type = "checkbox";
    node.className = "b3-switch fn__flex-center";
    return node;
}

function numberInput(step: number | "any" = "any"): HTMLInputElement {
    const node = input();
    node.type = "number";
    node.step = String(step);
    return node;
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    })[char] as string);
}

/** 上下键在可见条目间移动高亮，跳过被搜索过滤掉的。 */
function moveFocus(list: HTMLElement, event: KeyboardEvent): void {
    const items = Array.from(list.querySelectorAll<HTMLElement>(".b3-list-item"))
        .filter((item) => !item.classList.contains("fn__none"));
    if (items.length === 0) {
        return;
    }
    const current = items.findIndex((item) => item.classList.contains("b3-list-item--focus"));
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = items[(current + step + items.length) % items.length];
    items.forEach((item) => item.classList.remove("b3-list-item--focus"));
    next.classList.add("b3-list-item--focus");
    next.scrollIntoView({block: "nearest"});
    event.preventDefault();
    event.stopPropagation();
}

/**
 * 模型选择器：点输入框弹出可搜索的下拉。
 *
 * 取自思源 AI 设置里选模型的实现（config/tabs/ai/aiProviderUi.ts 的 openAvailableModelMenu），
 * 那里用到的 upDownHint 与 escapeHTML 是应用内部工具，未随 SDK 导出，这里各写一份等价的。
 * 用 Menu 而不是 <select>：模型名允许任意填写，下拉只是省去手打的入口。
 */
function openModelMenu(anchor: HTMLInputElement, models: string[], t: T, onPick: (id: string) => void): void {
    const menu = new Menu();
    menu.addItem({
        iconHTML: "",
        type: "empty",
        label: `<div class="fn__flex-column b3-menu__filter ai-title__model-filter">
    <input class="b3-text-field fn__block" placeholder="${escapeHtml(t("modelSearch"))}">
    <div class="fn__hr"></div>
    <div class="b3-list fn__flex-1 b3-list--background">
        ${models.map((model) => `<div class="b3-list-item b3-list-item--narrow" data-model="${escapeHtml(model)}">
    <span class="b3-list-item__text">${escapeHtml(model)}</span>
    ${model === anchor.value ? '<svg class="b3-menu__checked"><use xlink:href="#iconSelect"></use></svg>' : ""}
</div>`).join("")}
        <div class="b3-list--empty fn__none" data-type="empty">${escapeHtml(t("modelEmpty"))}</div>
    </div>
</div>`,
        bind(element) {
            const list = element.querySelector<HTMLElement>(".b3-list");
            const search = element.querySelector<HTMLInputElement>("input");
            const empty = element.querySelector<HTMLElement>("[data-type='empty']");
            if (!list || !search || !empty) {
                return;
            }
            const select = (item: HTMLElement) => {
                const id = item.dataset.model ?? "";
                onPick(id);
                menu.close();
                anchor.focus();
            };
            const filter = () => {
                const keyword = search.value.toLowerCase().trim();
                let first: HTMLElement | undefined;
                list.querySelectorAll<HTMLElement>(".b3-list-item").forEach((item) => {
                    item.classList.remove("b3-list-item--focus");
                    const hidden = !(item.dataset.model ?? "").toLowerCase().includes(keyword);
                    item.classList.toggle("fn__none", hidden);
                    if (!hidden && !first) {
                        first = item;
                    }
                });
                first?.classList.add("b3-list-item--focus");
                empty.classList.toggle("fn__none", first !== undefined);
            };
            filter();
            search.addEventListener("keydown", (event: KeyboardEvent) => {
                event.stopPropagation();
                if (event.isComposing) {
                    return;
                }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    moveFocus(list, event);
                } else if (event.key === "Enter") {
                    const item = list.querySelector<HTMLElement>(".b3-list-item--focus");
                    if (item) {
                        select(item);
                    }
                    event.preventDefault();
                } else if (event.key === "Escape") {
                    menu.close();
                    anchor.focus();
                    event.preventDefault();
                }
            });
            search.addEventListener("input", () => {
                filter();
            });
            list.addEventListener("click", (event) => {
                const item = (event.target as HTMLElement).closest<HTMLElement>(".b3-list-item");
                if (item) {
                    select(item);
                }
            });
        },
    });
    const rect = anchor.getBoundingClientRect();
    menu.open({x: rect.left, y: rect.bottom, h: rect.height, w: rect.width});
    // Menu.open 的 w 只参与水平溢出修正，宽度实际由内容决定。思源那边的模型输入框只有
    // 二百来像素，窄面板不显眼；这里是整行铺满的输入框，菜单必须跟着同宽才不显得脱节。
    // border-box：.b3-menu 默认 content-box，直接给 width 会再叠上内边距
    menu.element.style.boxSizing = "border-box";
    menu.element.style.width = `${rect.width}px`;
}

function parseNumber(raw: string, fallback: number): number {
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

function parsePositive(raw: string, fallback: number): number {
    return Math.max(1, parseNumber(raw, fallback));
}

/** 比例一律夹到 0 到 1，手滑输入 5 或 -1 时不该把额度算飞。 */
function parseRatio(raw: string, fallback: number): number {
    return Math.min(1, Math.max(0, parseNumber(raw, fallback)));
}

/** 空字符串代表「不发送该参数」，必须与数字 0 区分开。 */
function parseOptionalNumber(raw: string): number | null {
    if (raw.trim() === "") {
        return null;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

export interface SettingsPanelOptions {
    t: T;
    settings: PluginSettings;
    /** 确认后写回配置并重建界面入口。 */
    onSave: (next: PluginSettings) => Promise<void>;
}

export function openSettingsPanel(options: SettingsPanelOptions): void {
    const {t} = options;
    // 复制一份，取消时不影响已保存的配置
    const settings: PluginSettings = structuredClone(options.settings);

    const dialog = new Dialog({
        title: t("pluginName"),
        // min() 让它在窄屏上自动收窄；桌面端就是 Setting 用的那个 768px
        width: "min(768px, 92vw)",
        // Setting 的默认高度，内容超出时由 .b3-dialog__content 滚动
        height: "80vh",
        content: '<div class="b3-dialog__content"><div class="config ai-title-settings"></div></div>' +
            '<div class="b3-dialog__action"></div>',
    });
    const root = dialog.element.querySelector<HTMLElement>(".ai-title-settings");
    const action = dialog.element.querySelector<HTMLElement>(".b3-dialog__action");
    if (!root || !action) {
        dialog.destroy();
        return;
    }

    const cancelButton = document.createElement("button");
    cancelButton.className = "b3-button b3-button--cancel";
    cancelButton.textContent = t("cancel");
    cancelButton.addEventListener("click", () => dialog.destroy());

    const space = document.createElement("div");
    space.className = "fn__space";

    const saveButton = document.createElement("button");
    saveButton.className = "b3-button b3-button--text";
    saveButton.textContent = t("save");
    saveButton.addEventListener("click", async () => {
        try {
            await options.onSave(settings);
        } catch (error) {
            // 保存失败就不关窗，否则用户刚改的内容会跟着对话框一起消失
            showMessage(
                t("saveFailed", {message: error instanceof Error ? error.message : String(error)}),
                12000,
                "error",
            );
            return;
        }
        dialog.destroy();
    });
    action.append(cancelButton, space, saveButton);

    const syncs = [
        buildApiGroup(root, t, settings),
        buildBehaviorGroup(root, t, settings),
        buildUiGroup(root, t, settings),
    ];
    // 初值：与导入后的重刷走同一条路径，避免两处逻辑漂移
    syncs.forEach((sync) => sync());

    // 自己搭对话框就得自己补上 Setting.addItem 会替我们做的那个 Ctrl+S
    dialog.element.addEventListener("keydown", (event: KeyboardEvent) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            saveButton.click();
        }
    });
}

function buildApiGroup(root: HTMLElement, t: T, settings: PluginSettings): Sync {
    const items = createGroup(root, t("groupApi"));
    const {api} = settings;
    const syncs: Sync[] = [];

    /** 当前是不是「使用思源设置中供应商」模式（#27）。 */
    const siyuanMode = (): boolean => api.protocol === PROTOCOL_SIYUAN_PROVIDER;

    /**
     * 当前是不是「跟随编辑器默认」或「跟随智能体默认」（#28）。这两档下模型名由思源决定：
     * 插件这边既不能填、也不能从列表里挑。
     */
    const following = (): boolean => siyuanMode() && isFollowDefaultProvider(api.siyuanProvider);

    /**
     * 模型输入框该显示的名字。
     * 跟随默认时显示思源实际会用的那个模型，其余情况显示存下来的值。
     */
    const displayedModel = (): string => {
        if (!siyuanMode()) {
            return api.model;
        }
        return following() ? followDefaultTarget(api.siyuanProvider)?.model ?? "" : api.siyuanModel;
    };

    /** 跟随默认却解析不出模型时的占位文案：编辑器与智能体在思源里是两处设置，分开说。 */
    const followPlaceholder = (): string =>
        api.siyuanProvider.trim() === PROVIDER_FOLLOW_AGENT ? t("modelFollowEmptyAgent") : t("modelFollowEmptyEditor");

    /** 配置不全时的提示：两种模式缺的东西不是一回事。 */
    const missingConfigMessage = (): string => siyuanMode() ? t("testNoConfigProvider") : t("testNoConfig");

    const protocol = select();
    for (const value of PROTOCOLS) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = protocolName(value, t);
        protocol.append(option);
    }
    protocol.addEventListener("change", () => {
        api.protocol = protocol.value as typeof api.protocol;
        // 模式换了：该显示的整行换一批，供应商下拉也要按思源当前的配置重建
        refresh();
    });
    syncs.push(() => {
        protocol.value = api.protocol;
    });
    rowItem(items, t("protocol"), t("protocolDesc"), protocol);

    // 模型输入框先建出来：供应商下拉要往里填默认模型，而它那一行要排在自定义请求头之后
    let availableModels: string[] = [];
    const modelInput = input();
    modelInput.placeholder = t("modelPlaceholder");
    // 两种模式各有一个模型名字段：模型名只属于某一个供应商，共用一个字段会让切换模式时
    // 把一边的模型名带到另一边（见 config.ts 的 siyuanModel）
    const setModel = (id: string) => {
        if (siyuanMode()) {
            api.siyuanModel = id;
        } else {
            api.model = id;
        }
        modelInput.value = id;
    };
    modelInput.addEventListener("input", () => {
        setModel(modelInput.value);
    });
    // 点输入框即可从已拉取的列表里挑；模型名本身仍允许直接手打
    modelInput.addEventListener("click", () => {
        if (availableModels.length > 0) {
            openModelMenu(modelInput, availableModels, t, setModel);
        }
    });
    syncs.push(() => {
        modelInput.value = displayedModel();
    });

    // 「使用思源设置中供应商」下唯一要在这里选的东西：插件只存这个 id，
    // 地址、密钥与请求头每次请求前从思源现取（#27）
    const provider = select();
    provider.addEventListener("change", () => {
        api.siyuanProvider = provider.value;
        // 跟随默认时模型名也由思源决定，这里不写 siyuanModel（#28）。
        // 具体供应商则要跟着换模型：模型名只属于某个供应商，留着上一个的名字请求必然 404
        if (!following()) {
            const chosen = readSiyuanProviders().find((item) => item.id === provider.value);
            if (chosen) {
                setModel(activeModelName(chosen));
                availableModels = providerModelNames(chosen);
            }
        }
        // 整行该显示的换一批：跟随默认时模型名要变成只读
        refresh();
    });
    const providerRow = rowItem(items, t("provider"), t("providerDesc"), provider);

    const baseURL = input();
    baseURL.placeholder = "https://api.openai.com/v1";
    baseURL.addEventListener("input", () => {
        api.baseURL = baseURL.value;
    });
    syncs.push(() => {
        baseURL.value = api.baseURL;
    });
    const baseURLRow = rowItem(items, t("baseUrl"), t("baseUrlDesc"), baseURL);

    const apiKey = input();
    apiKey.type = "password";
    apiKey.autocomplete = "off";
    apiKey.addEventListener("input", () => {
        api.apiKey = apiKey.value;
    });
    syncs.push(() => {
        apiKey.value = api.apiKey;
    });
    // 拿不到思源数据仓库密钥时，这个 Key 只能明文落盘，必须当场说明（#26）：
    // 换成密码框之后用户没有任何办法从界面上看出它到底有没有被加密
    const apiKeyRow = rowItem(
        items,
        t("apiKey"),
        canEncrypt() ? t("apiKeyDesc") : `${t("apiKeyDesc")} ${t("apiKeyDescInsecure")}`,
        apiKey,
    );

    // 与思源自己的供应商页面一样用一个 JSON 文本框：两边可以整段对拷，
    // 而「自定义请求头」这种名字与取值都不固定的东西列成表单反而更难看
    const customHeaders = textarea(3);
    customHeaders.spellcheck = false;
    customHeaders.placeholder = t("customHeadersPlaceholder");
    customHeaders.addEventListener("input", () => {
        api.customHeaders = customHeaders.value;
    });
    syncs.push(() => {
        customHeaders.value = api.customHeaders;
    });
    const customHeadersRow = stackItem(items, t("customHeaders"), t("customHeadersDesc"), customHeaders);

    const fetchButton = document.createElement("button");
    fetchButton.className = "b3-button b3-button--outline fn__flex-shrink";
    fetchButton.textContent = t("fetchModels");
    fetchButton.addEventListener("click", async () => {
        // 只要求端点：模型名是这次要拉的东西，不能反过来要求它已经填好
        if (!hasProviderEndpoint(api)) {
            showMessage(missingConfigMessage(), 6000, "error");
            return;
        }
        fetchButton.disabled = true;
        fetchButton.textContent = t("fetchModelsLoading");
        try {
            const models = await listModels(api, settings.behavior.timeout);
            if (models.length === 0) {
                showMessage(t("testFailed", {message: "no models returned"}), 8000, "error");
                return;
            }
            availableModels = models;
            // 拉完直接摊开，省得再点一次输入框
            openModelMenu(modelInput, availableModels, t, setModel);
        } catch (error) {
            showMessage(t("testFailed", {message: error instanceof Error ? error.message : String(error)}), 12000, "error");
        } finally {
            fetchButton.disabled = false;
            fetchButton.textContent = t("fetchModels");
        }
    });

    // 与「获取模型列表」同一行：两个按钮都在改/验同一个模型名，
    // 分开两行时用户点完测试还要回头找输入框在哪（#18）
    const testButton = document.createElement("button");
    testButton.className = "b3-button b3-button--outline fn__flex-shrink";
    testButton.textContent = t("testConnection");
    testButton.addEventListener("click", async () => {
        if (!hasProviderConfig(api)) {
            showMessage(missingConfigMessage(), 6000, "error");
            return;
        }
        testButton.disabled = true;
        testButton.textContent = t("testRunning");
        try {
            const {reply, elapsed} = await testConnection(api, settings.behavior);
            showMessage(t("testOk", {reply, elapsed}), 6000);
        } catch (error) {
            showMessage(
                t("testFailed", {message: error instanceof Error ? error.message : String(error)}),
                12000,
                "error",
            );
        } finally {
            testButton.disabled = false;
            testButton.textContent = t("testConnection");
        }
    });

    const modelBox = document.createElement("div");
    modelBox.className = "ai-title-settings__field-row";
    modelBox.append(modelInput, fetchButton, testButton);
    stackItem(items, t("modelName"), t("modelNameDesc"), modelBox);

    const importButton = document.createElement("button");
    importButton.className = "b3-button b3-button--outline";
    importButton.textContent = t("importFromSiyuan");
    importButton.addEventListener("click", () => {
        openImportDialog(t, settings, () => syncs.forEach((sync) => sync()));
    });
    const importRow = rowItem(items, t("importFromSiyuan"), t("importFromSiyuanDesc"), importButton);

    /**
     * 模式切换后重刷可见性，并重建供应商下拉。
     *
     * 「使用思源设置中供应商」下 Base URL、API Key、自定义请求头与「从思源设置获取」
     * 都由思源那边接管了：在这里填只会让人以为生效了，导入更是会当场把模式切成自定义，
     * 所以整行隐藏；供应商下拉反过来只在该模式下出现。
     *
     * 「跟随编辑器/智能体默认」（#28）再多收两处：模型名由思源决定，
     * 输入框改成只读并显示思源实际会用的那个；「获取模型列表」也就没有意义了。
     */
    function refresh(): void {
        fillProviderOptions(provider, api.siyuanProvider, t);
        const siyuan = siyuanMode();
        const follow = following();
        baseURLRow.classList.toggle("fn__none", siyuan);
        apiKeyRow.classList.toggle("fn__none", siyuan);
        customHeadersRow.classList.toggle("fn__none", siyuan);
        importRow.classList.toggle("fn__none", siyuan);
        providerRow.classList.toggle("fn__none", !siyuan);
        modelInput.disabled = follow;
        modelInput.placeholder = follow ? followPlaceholder() : t("modelPlaceholder");
        // 这一档没有可挑的模型，拉一份列表出来只会让人以为能改
        fetchButton.classList.toggle("fn__none", follow);
        // 模型名跟着模式换：两种模式各存各的，切换时输入框要显示对应那一个
        modelInput.value = displayedModel();
        if (follow) {
            availableModels = [];
        } else if (siyuan) {
            // 模型清单直接取思源里配好的那份：这个模式下模型本来就属于某个供应商
            const chosen = readSiyuanProviders().find((item) => item.id === api.siyuanProvider);
            availableModels = chosen ? providerModelNames(chosen) : [];
        } else {
            availableModels = [];
        }
    }
    syncs.push(refresh);

    // 旧版这里是「从一串 JSON 片段里挑一条」的下拉，已撤出界面并弃用：
    // 其中 {"extra_body": ...} 在原始 HTTP 下永远不生效（extra_body 只是 Python SDK 的
    // 包装，SDK 发送前会把它拆开），其余几条各只对一个供应商有效，选错时还没有任何反馈。
    // 现在只发 OpenAI 官方的 reasoning_effort，取值与思源自己的 AI 设置一致。
    const reasoning = select();
    const reasoningLabels: Record<ReasoningEffort, string> = {
        [REASONING_EFFORT_OFF]: t("reasoningNone"),
        [REASONING_DEFAULT]: t("reasoningDefault"),
        low: t("reasoningLow"),
        medium: t("reasoningMedium"),
        high: t("reasoningHigh"),
        xhigh: t("reasoningXHigh"),
        max: t("reasoningMax"),
    };
    for (const value of REASONING_OPTIONS) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = reasoningLabels[value];
        reasoning.append(option);
    }
    reasoning.addEventListener("change", () => {
        api.reasoningEffort = reasoning.value as ReasoningEffort;
    });
    syncs.push(() => {
        reasoning.value = api.reasoningEffort;
    });
    rowItem(items, t("reasoningEffort"), t("reasoningEffortDesc"), reasoning);

    const temperature = numberInput(0.1);
    temperature.addEventListener("input", () => {
        api.temperature = parseNumber(temperature.value, DEFAULT_SETTINGS.api.temperature);
    });
    syncs.push(() => {
        temperature.value = String(api.temperature);
    });
    rowItem(items, t("temperature"), t("temperatureDesc"), temperature);

    const topP = numberInput(0.05);
    topP.addEventListener("input", () => {
        api.topP = parseOptionalNumber(topP.value);
    });
    syncs.push(() => {
        topP.value = api.topP === null ? "" : String(api.topP);
    });
    rowItem(items, t("topP"), t("topPDesc"), topP);

    const topK = numberInput();
    topK.addEventListener("input", () => {
        api.topK = parseOptionalNumber(topK.value);
    });
    syncs.push(() => {
        topK.value = api.topK === null ? "" : String(api.topK);
    });
    rowItem(items, t("topK"), t("topKDesc"), topK);

    const maxTokens = numberInput();
    maxTokens.addEventListener("input", () => {
        api.maxTokens = parseNumber(maxTokens.value, DEFAULT_SETTINGS.api.maxTokens);
    });
    syncs.push(() => {
        maxTokens.value = String(api.maxTokens);
    });
    rowItem(items, t("maxTokens"), t("maxTokensDesc"), maxTokens);

    return () => syncs.forEach((sync) => sync());
}

/** 协议标识 -> 展示名。认不出来的原样显示，至少让用户看到思源里存的是什么。 */
function protocolName(protocol: string, t: T): string {
    switch (protocol) {
        case PROTOCOL_SIYUAN_PROVIDER:
            return t("protocolSiyuanProvider");
        case PROTOCOL_CHAT_COMPLETIONS:
            return t("protocolChatCompletions");
        case PROTOCOL_RESPONSES:
            return t("protocolResponses");
        case PROTOCOL_ANTHROPIC_MESSAGES:
            return t("protocolAnthropicMessages");
        case PROTOCOL_GEMINI_INTERACTIONS:
            return t("protocolGeminiInteractions");
        default:
            return protocol;
    }
}

/**
 * 重建供应商下拉的选项。
 *
 * 每次重刷都整体重建：思源那边刚加了或删了供应商时，面板里留着上一次的列表，
 * 只会让人选到一个已经不存在的 id。
 *
 * 紧接着占位项的是两条「跟随默认」（#28）：「跟随编辑器默认」用思源里编辑器 AI 的
 * 默认模型，「跟随智能体默认」用智能体的。两者都不是供应商 id，所以排在具体供应商之前。
 */
function fillProviderOptions(node: HTMLSelectElement, selected: string, t: T): void {
    node.textContent = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = t("providerPlaceholder");
    node.append(placeholder);

    for (const [value, label] of [
        [PROVIDER_FOLLOW_EDITOR, t("providerFollowEditor")],
        [PROVIDER_FOLLOW_AGENT, t("providerFollowAgent")],
    ] as const) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        node.append(option);
    }

    const providers = readSiyuanProviders();
    for (const provider of providers) {
        const id = provider.id ?? "";
        if (id === "") {
            continue;
        }
        const option = document.createElement("option");
        option.value = id;
        option.textContent = provider.displayName || id;
        node.append(option);
    }
    // 思源那边删掉的供应商原样留在下拉里：否则界面显示成没选，配置里却还留着旧 id，
    // 报错时用户看到的名字在界面上根本找不到
    if (selected !== "" && !isFollowDefaultProvider(selected) &&
        !providers.some((provider) => provider.id === selected)) {
        const missing = document.createElement("option");
        missing.value = selected;
        missing.textContent = selected;
        node.append(missing);
    }
    node.value = selected;
}

/** 从思源自身的 AI 供应商配置里一次性复制 Base URL / API Key / 请求头 / 模型。 */
function openImportDialog(t: T, settings: PluginSettings, onImported: () => void): void {
    const providers = readSiyuanProviders().filter((provider) =>
        (provider.baseURL ?? "") !== "" &&
        ((provider.apiKey ?? "") !== "" || hasHeaderAuth(provider.headers)));

    if (providers.length === 0) {
        showMessage(t("importEmpty"), 8000, "error");
        return;
    }

    const dialog = new Dialog({
        title: t("importDialogTitle"),
        width: "640px",
        content: '<div class="b3-dialog__content"><div class="ai-title__importing"></div></div>',
    });
    const body = dialog.element.querySelector<HTMLElement>(".ai-title__importing");
    if (!body) {
        return;
    }

    for (const provider of providers) {
        const protocol = providerProtocol(provider);
        // 只接受插件实现了的协议：请求地址与请求体结构都按协议选，
        // 协议对不上时请求必然失败，不如在这里就把按钮禁掉
        const target = isAdapterProtocol(protocol) ? protocol : undefined;

        const item = document.createElement("div");
        item.className = "ai-title__import-item";

        const name = document.createElement("div");
        name.className = "ai-title__import-provider";
        name.textContent = provider.displayName || provider.id || "provider";

        const meta = document.createElement("div");
        meta.className = "ai-title__import-meta";
        // 协议类型必须显示出来：同一个供应商的 Anthropic 与 OpenAI 兼容端点
        // 是两个不同的 Base URL，光看地址分不出哪个是哪个
        meta.textContent = `${provider.baseURL} · ${activeModelName(provider) || "-"} · ${protocolName(protocol, t)}`;

        const choose = document.createElement("button");
        choose.className = "b3-button b3-button--outline";
        // 与打开本对话框的那个按钮区分开：这里点下去是把这一条配置导进来
        choose.textContent = target ? t("importApply") : t("importUnsupported");
        choose.disabled = target === undefined;
        if (!target) {
            // 禁用按钮点不出提示，把原因挂在 title 与 aria-label 上
            choose.title = t("importUnsupportedHint", {protocol: protocolName(protocol, t)});
            choose.setAttribute("aria-label", choose.title);
        }
        choose.addEventListener("click", () => {
            settings.api.baseURL = provider.baseURL ?? "";
            settings.api.apiKey = provider.apiKey ?? "";
            // 请求头一起带过来：靠自定义头鉴权、或要求会话头的供应商全靠它（#24）；
            // 供应商没配请求头时清空，导入是整体替换而不是叠加
            settings.api.customHeaders = formatHeaders(provider.headers);
            // 只取一个模型作为起点，用户仍可在设置页改或重新拉取列表
            settings.api.model = activeModelName(provider);
            // 协议跟着思源里的设置走，不写死：支持列表变了这里不用改
            if (target) {
                settings.api.protocol = target;
            }
            dialog.destroy();
            onImported();
        });

        const text = document.createElement("div");
        text.className = "ai-title__import-text";
        text.append(name, meta);

        item.append(text, choose);
        body.append(item);
    }
}

function buildBehaviorGroup(root: HTMLElement, t: T, settings: PluginSettings): Sync {
    const items = createGroup(root, t("groupBehavior"));
    const {behavior} = settings;
    const syncs: Sync[] = [];

    const timeout = numberInput();
    timeout.addEventListener("input", () => {
        behavior.timeout = parseNumber(timeout.value, DEFAULT_SETTINGS.behavior.timeout);
    });
    syncs.push(() => {
        timeout.value = String(behavior.timeout);
    });
    rowItem(items, t("timeout"), t("timeoutDesc"), timeout);

    const retries = numberInput();
    retries.addEventListener("input", () => {
        behavior.retries = parseNumber(retries.value, DEFAULT_SETTINGS.behavior.retries);
    });
    syncs.push(() => {
        retries.value = String(behavior.retries);
    });
    rowItem(items, t("retries"), t("retriesDesc"), retries);

    const contentLimit = numberInput();
    contentLimit.addEventListener("input", () => {
        behavior.contentLimit = parseNumber(contentLimit.value, DEFAULT_SETTINGS.behavior.contentLimit);
    });
    syncs.push(() => {
        contentLimit.value = String(behavior.contentLimit);
    });
    rowItem(items, t("contentLimit"), t("contentLimitDesc"), contentLimit);

    const truncateMode = select();
    const truncateLabels: Record<TruncateMode, string> = {
        [TRUNCATE_HEAD]: t("truncateHead"),
        [TRUNCATE_TAIL]: t("truncateTail"),
        [TRUNCATE_BOTH]: t("truncateBoth"),
        [TRUNCATE_FULL]: t("truncateFull"),
    };
    for (const value of TRUNCATE_OPTIONS) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = truncateLabels[value];
        truncateMode.append(option);
    }
    truncateMode.addEventListener("change", () => {
        behavior.truncateMode = truncateMode.value as TruncateMode;
        syncRatio();
    });
    syncs.push(() => {
        truncateMode.value = behavior.truncateMode;
        headRatio.value = String(behavior.truncateHeadRatio);
        syncRatio();
    });
    rowItem(items, t("truncateMode"), t("truncateModeDesc"), truncateMode);

    // 比例必须紧跟在这条下拉下面：它只对「开头 + 末尾」一档有意义，
    // 中间隔着别的设置项时，用户看不出它在描述谁
    const headRatio = numberInput(0.05);
    headRatio.addEventListener("input", () => {
        behavior.truncateHeadRatio = parseRatio(headRatio.value, DEFAULT_SETTINGS.behavior.truncateHeadRatio);
    });
    const ratioRow = rowItem(items, t("truncateHeadRatio"), t("truncateHeadRatioDesc"), headRatio);

    // 只在「开头 + 末尾」下显示，其余档位留着一个不起作用的输入框只会让人猜
    function syncRatio(): void {
        ratioRow.classList.toggle("fn__none", behavior.truncateMode !== TRUNCATE_BOTH);
    }

    const media = select();
    const mediaLabels: Record<MediaMode, string> = {
        [MEDIA_DROP]: t("mediaDrop"),
        [MEDIA_PLACEHOLDER]: t("mediaPlaceholder"),
        [MEDIA_RAW]: t("mediaRaw"),
    };
    for (const value of MEDIA_OPTIONS) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = mediaLabels[value];
        media.append(option);
    }
    media.addEventListener("change", () => {
        behavior.mediaMode = media.value as MediaMode;
    });
    syncs.push(() => {
        media.value = behavior.mediaMode;
    });
    rowItem(items, t("mediaHandling"), t("mediaHandlingDesc"), media);

    const includeTitle = switchControl();
    includeTitle.addEventListener("change", () => {
        behavior.includeTitle = includeTitle.checked;
    });
    syncs.push(() => {
        includeTitle.checked = behavior.includeTitle;
    });
    rowItem(items, t("includeTitle"), t("includeTitleDesc"), includeTitle);

    const tocMode = select();
    const tocLabels: Record<TocMode, string> = {
        [TOC_NEVER]: t("tocNever"),
        [TOC_TRUNCATED]: t("tocTruncated"),
        [TOC_ALWAYS]: t("tocAlways"),
    };
    for (const value of TOC_OPTIONS) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = tocLabels[value];
        tocMode.append(option);
    }
    tocMode.addEventListener("change", () => {
        behavior.tocMode = tocMode.value as TocMode;
    });
    syncs.push(() => {
        tocMode.value = behavior.tocMode;
    });
    rowItem(items, t("tocMode"), t("tocModeDesc"), tocMode);

    const batchSize = numberInput();
    batchSize.addEventListener("input", () => {
        behavior.batchSize = parsePositive(batchSize.value, DEFAULT_SETTINGS.behavior.batchSize);
    });
    syncs.push(() => {
        batchSize.value = String(behavior.batchSize);
    });
    rowItem(items, t("batchSize"), t("batchSizeDesc"), batchSize);

    const concurrency = numberInput();
    concurrency.addEventListener("input", () => {
        behavior.concurrency = parsePositive(concurrency.value, DEFAULT_SETTINGS.behavior.concurrency);
    });
    syncs.push(() => {
        concurrency.value = String(behavior.concurrency);
    });
    rowItem(items, t("concurrency"), t("concurrencyDesc"), concurrency);

    const autoApply = select();
    const autoApplyLabels: Record<AutoApply, string> = {
        [AUTO_APPLY_NEVER]: t("autoApplyNever"),
        [AUTO_APPLY_SINGLE]: t("autoApplySingle"),
        [AUTO_APPLY_ALWAYS]: t("autoApplyAlways"),
    };
    for (const value of AUTO_APPLY_OPTIONS) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = autoApplyLabels[value];
        autoApply.append(option);
    }
    autoApply.addEventListener("change", () => {
        behavior.autoApply = autoApply.value as AutoApply;
    });
    syncs.push(() => {
        autoApply.value = behavior.autoApply;
    });

    rowItem(items, t("autoApply"), t("autoApplyDesc"), autoApply);

    const language = input();
    language.addEventListener("input", () => {
        behavior.titleLanguage = language.value;
    });
    syncs.push(() => {
        language.value = behavior.titleLanguage;
    });
    rowItem(items, t("titleLanguage"), t("titleLanguageDesc"), language);

    const style = input();
    style.addEventListener("input", () => {
        behavior.titleStyle = style.value;
    });
    syncs.push(() => {
        style.value = behavior.titleStyle;
    });
    rowItem(items, t("titleStyle"), t("titleStyleDesc"), style);

    const ignoreInjection = switchControl();
    ignoreInjection.addEventListener("change", () => {
        behavior.ignoreInjection = ignoreInjection.checked;
    });
    syncs.push(() => {
        ignoreInjection.checked = behavior.ignoreInjection;
    });
    rowItem(items, t("ignoreInjection"), t("ignoreInjectionDesc"), ignoreInjection);

    const systemExtra = textarea(3);
    systemExtra.addEventListener("input", () => {
        behavior.systemExtra = systemExtra.value;
    });
    syncs.push(() => {
        systemExtra.value = behavior.systemExtra;
    });
    stackItem(items, t("systemExtra"), t("systemExtraDesc"), systemExtra);

    const userExtra = textarea(3);
    userExtra.addEventListener("input", () => {
        behavior.userExtra = userExtra.value;
    });
    syncs.push(() => {
        userExtra.value = behavior.userExtra;
    });
    stackItem(items, t("userExtra"), t("userExtraDesc"), userExtra);

    return () => syncs.forEach((sync) => sync());
}

function buildUiGroup(root: HTMLElement, t: T, settings: PluginSettings): Sync {
    const items = createGroup(root, t("groupUi"));
    const {ui} = settings;
    const syncs: Sync[] = [];

    const topBar = switchControl();
    topBar.addEventListener("change", () => {
        ui.showTopBar = topBar.checked;
    });
    syncs.push(() => {
        topBar.checked = ui.showTopBar;
    });
    rowItem(items, t("showTopBar"), t("showTopBarDesc"), topBar);

    const breadcrumb = switchControl();
    breadcrumb.addEventListener("change", () => {
        ui.showBreadcrumb = breadcrumb.checked;
    });
    syncs.push(() => {
        breadcrumb.checked = ui.showBreadcrumb;
    });
    rowItem(items, t("showBreadcrumb"), t("showBreadcrumbDesc"), breadcrumb);

    const docTree = switchControl();
    docTree.addEventListener("change", () => {
        ui.showDocTreeMenu = docTree.checked;
    });
    syncs.push(() => {
        docTree.checked = ui.showDocTreeMenu;
    });
    rowItem(items, t("showDocTreeMenu"), t("showDocTreeMenuDesc"), docTree);

    const debugSwitch = switchControl();
    debugSwitch.addEventListener("change", () => {
        ui.debug = debugSwitch.checked;
        // 立即生效，不必等保存后才能看到日志
        setDebug(debugSwitch.checked);
    });
    syncs.push(() => {
        debugSwitch.checked = ui.debug;
    });
    rowItem(items, t("debugMode"), t("debugModeDesc"), debugSwitch);

    return () => syncs.forEach((sync) => sync());
}
