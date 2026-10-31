/**
 * 把生成的标题写回笔记。
 *
 * 普通标题用 /api/filetree/renameDocByID 而不是直接写块属性：
 * 前者会同步更新 .sy 路径、HPath、子文档 HPath、索引与引用锚文本，
 * 直接改 IAL 的 title 会让文件树与索引不同步。
 *
 * 富文本标题（思源 v3.8.10 起）不能走重命名接口：内核只接受原样回传的纯文本摘要，
 * 传别的摘要会报「请通过标题编辑器修改此富文本标题」。这类标题按标题源事务写：
 * 先读 /api/block/getDocTitle 拿到格式、摘要与源版本，再向 /api/transactions
 * 提交单独的 setDocTitle 操作，用 BlockDOM 携带行级内容。
 *
 * 标题允许行内 Markdown：富文本标题交给 Lute 解析成行级内容（粗体、斜体、代码、
 * 链接等）；普通标题在生成结果确实带行内 Markdown 时才升级成富文本标题，否则
 * 按纯文本重命名。没有标题源接口的旧内核只能存纯文本，先把标记去掉。
 * 旧内核探测不到 getDocTitle 后，同一批里剩下的直接按普通标题处理。
 *
 * 注意思源的普通重命名没有撤销栈（内核 RenameDoc 不提供 undo），
 * 所以调用方必须在写入前把不可撤销这一点明确告诉用户。
 */
import {fetchSyncPost, type Lute} from "siyuan";

export interface TitleEdit {
    id: string;
    title: string;
}

export interface ApplyOutcome {
    applied: TitleEdit[];
    /** 写入失败的条目及原因。 */
    failed: {edit: TitleEdit; message: string}[];
}

/** /api/block/getDocTitle 的返回，只取这里用得到的字段。 */
interface DocTitleState {
    format: string;
    text: string;
    revision: string;
}

interface KernelResponse<T> {
    code: number;
    msg: string;
    data?: T;
}

/** 取一个 Lute 实例；拿不到时退回纯文本处理，不让标题写不进去。 */
function lute(): Lute | undefined {
    if (typeof window === "undefined" || !window.Lute) {
        return undefined;
    }
    try {
        return window.Lute.New();
    } catch {
        return undefined;
    }
}

/**
 * 标题只允许行级内容，先把 `<` 变成实体。
 * 原始 HTML 交给 Lute 会解析成块级结构，标题源会拒绝写入；按字面显示也更符合标题语义。
 */
function literalAngles(title: string): string {
    return title.replaceAll("<", "&lt;");
}

/** 把行内 Markdown 解析成单段落 BlockDOM；旧版 Lute 没有这个能力时返回 undefined。 */
function titleBlockDOM(title: string): string | undefined {
    const engine = lute();
    if (!engine || typeof engine.InlineMd2BlockDOM !== "function") {
        return undefined;
    }
    try {
        return engine.InlineMd2BlockDOM(literalAngles(title));
    } catch {
        return undefined;
    }
}

/** 去掉行内 Markdown 标记，得到纯文本标题。 */
function plainTitle(title: string): string {
    const engine = lute();
    if (!engine) {
        return title;
    }
    try {
        const markdown = literalAngles(title);
        const dom = typeof engine.InlineMd2BlockDOM === "function"
            ? engine.InlineMd2BlockDOM(markdown)
            : engine.Md2BlockDOM(markdown);
        // 代码、标签和键盘样式旁有用于放置光标的零宽空格，摘要里不显示它们
        const text = engine.BlockDOM2Content(dom).replaceAll("\u200b", "").trim();
        return text === "" ? title.trim() : text;
    } catch {
        return title;
    }
}

/**
 * 生成结果里是否有行内 Markdown。
 *
 * 普通标题在思源里按纯文本存，标记不会被解析；只有升级成富文本标题才能保留样式。
 * 用 Lute 解析后的文字与原标题对比：不同就说明有需要标题源的内容。
 */
function hasInlineMarkdown(title: string): boolean {
    return plainTitle(title) !== title.trim();
}

/**
 * 读取标题源状态。
 *
 * 返回 undefined 表示内核没有这个接口（旧版本），调用方本批不再探测；
 * 返回 null 表示这一篇读不到（文档已删、索引未就绪等），照旧走重命名，
 * 由重命名给出最终错误。
 */
async function readTitleState(id: string): Promise<DocTitleState | null | undefined> {
    try {
        const response = (await fetchSyncPost("/api/block/getDocTitle", {id})) as KernelResponse<DocTitleState>;
        return response.code === 0 ? response.data ?? null : null;
    } catch {
        return undefined;
    }
}

/** 用标题源事务写入富文本标题，成功返回 undefined，失败返回内核给的原因。 */
async function applyRichTitle(edit: TitleEdit, revision: string): Promise<string | undefined> {
    const blockDOM = titleBlockDOM(edit.title);
    // 拿不到 Lute 时退回完整源的纯文本形式，至少把标题写进去
    const data = blockDOM === undefined
        ? {
            expectedRevision: revision,
            source: {
                spec: 1,
                format: "inline-ast",
                content: JSON.stringify([{Type: "NodeText", Data: plainTitle(edit.title)}]),
            },
        }
        : {expectedRevision: revision, blockDOM};

    const response = (await fetchSyncPost("/api/transactions", {
        reqId: Date.now(),
        transactions: [{
            doOperations: [{action: "setDocTitle", id: edit.id, data}],
        }],
    })) as KernelResponse<unknown>;

    return response.code === 0 ? undefined : response.msg || `code ${response.code}`;
}

/**
 * 逐条应用标题，单条失败不中断后续。
 * 标题超长、笔记本被锁定、文档已被删除等都会在这里体现为单条失败。
 */
export async function applyTitles(edits: TitleEdit[]): Promise<ApplyOutcome> {
    const applied: TitleEdit[] = [];
    const failed: {edit: TitleEdit; message: string}[] = [];
    let hasTitleSource = true;

    for (const edit of edits) {
        try {
            if (hasTitleSource) {
                const current = await readTitleState(edit.id);
                if (current === undefined) {
                    // 旧内核没有标题源接口，同一批剩下的直接按普通标题处理
                    hasTitleSource = false;
                } else if (current !== null &&
                    (current.format === "inline-ast" || hasInlineMarkdown(edit.title))) {
                    // 富文本标题始终按标题源写；普通标题只有生成结果确实带行内 Markdown
                    // 时才升级，否则思源按纯文本存，标记会被直接丢掉
                    if (current.format === "inline-ast" && current.text === edit.title &&
                        !hasInlineMarkdown(edit.title)) {
                        // 摘要没变且没有 Markdown 要应用时不动源，避免把图片、链接、样式拍平
                        applied.push(edit);
                        continue;
                    }
                    const message = await applyRichTitle(edit, current.revision);
                    if (message === undefined) {
                        applied.push(edit);
                    } else {
                        failed.push({edit, message});
                    }
                    continue;
                }
            }

            const response = (await fetchSyncPost("/api/filetree/renameDocByID", {
                id: edit.id,
                title: plainTitle(edit.title),
            })) as KernelResponse<unknown>;
            if (response.code !== 0) {
                failed.push({edit, message: response.msg || `code ${response.code}`});
            } else {
                applied.push(edit);
            }
        } catch (error) {
            failed.push({edit, message: error instanceof Error ? error.message : String(error)});
        }
    }

    return {applied, failed};
}
