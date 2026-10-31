import {afterEach, describe, expect, it} from "vitest";
import {applyTitles} from "../src/apply";
import {setFetchSyncPost} from "./stubs/siyuan";

/** 记下一次内核请求的 URL 与请求体。 */
interface KernelCall {
    url: string;
    data?: any;
}

/** 测试用的 Lute：只实现这里用到的行内解析与取文，行为与真实实现对齐到够用。 */
interface LuteEngine {
    InlineMd2BlockDOM?: (markdown: string) => string;
    Md2BlockDOM?: (markdown: string) => string;
    BlockDOM2Content: (dom: string) => string;
    seen: string[];
}

const scope = globalThis as unknown as {window?: {Lute: {New: () => LuteEngine}}};

function useLute(engine: LuteEngine | undefined): void {
    scope.window = engine === undefined ? undefined : {Lute: {New: () => engine}};
}

/** 把 **粗体** 变成行内标签；取文时标签和标记都消失，模拟 Lute 的解析结果。 */
function fakeLute(options: {inline?: boolean} = {}): LuteEngine {
    const seen: string[] = [];
    const toDOM = (markdown: string): string => {
        seen.push(markdown);
        const html = markdown.replace(/\*\*(.+?)\*\*/g, '<span data-type="strong">$1</span>');
        return `<div data-node-id="fake" data-type="NodeParagraph"><div contenteditable="true">${html}</div></div>`;
    };
    const engine: LuteEngine = {
        seen,
        Md2BlockDOM: toDOM,
        BlockDOM2Content: (dom) => dom.replace(/<[^>]+>/g, "").trim(),
    };
    if (options.inline !== false) {
        engine.InlineMd2BlockDOM = toDOM;
    }
    return engine;
}

let calls: KernelCall[] = [];

/** 按 URL 返回准备好的响应（Error 表示请求失败），并把请求记下来。 */
function stubKernel(replies: {[url: string]: unknown}): void {
    calls = [];
    setFetchSyncPost((url, data) => {
        calls.push({url, data});
        if (!(url in replies)) {
            return Promise.reject(new Error(`unexpected request to ${url}`));
        }
        const reply = replies[url];
        return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    });
}

const PLAIN_TITLE = {code: 0, msg: "", data: {format: "plain", text: "旧标题", revision: "r1"}};
const RICH_TITLE = {code: 0, msg: "", data: {format: "inline-ast", text: "旧标题", revision: "r1"}};
const OK = {code: 0, msg: ""};

afterEach(() => useLute(undefined));

describe("applyTitles", () => {
    it("旧内核没有标题源接口时按普通标题重命名，且整批只探测一次", async () => {
        stubKernel({
            "/api/block/getDocTitle": new Error("not found"),
            "/api/filetree/renameDocByID": OK,
        });

        const outcome = await applyTitles([{id: "doc1", title: "甲"}, {id: "doc2", title: "乙"}]);

        expect(outcome.applied).toHaveLength(2);
        expect(outcome.failed).toEqual([]);
        expect(calls.map((call) => call.url)).toEqual([
            "/api/block/getDocTitle",
            "/api/filetree/renameDocByID",
            "/api/filetree/renameDocByID",
        ]);
    });

    it("普通标题且生成结果没有行内 Markdown 时继续走 renameDocByID", async () => {
        useLute(fakeLute());
        stubKernel({
            "/api/block/getDocTitle": PLAIN_TITLE,
            "/api/filetree/renameDocByID": OK,
        });

        const outcome = await applyTitles([{id: "doc1", title: "新标题"}]);

        expect(outcome.applied).toEqual([{id: "doc1", title: "新标题"}]);
        expect(outcome.failed).toEqual([]);
        expect(calls.map((call) => call.url))
            .toEqual(["/api/block/getDocTitle", "/api/filetree/renameDocByID"]);
        expect(calls[1].data).toEqual({id: "doc1", title: "新标题"});
    });

    it("普通标题遇到行内 Markdown 时升级为富文本标题", async () => {
        useLute(fakeLute());
        stubKernel({
            "/api/block/getDocTitle": PLAIN_TITLE,
            "/api/transactions": OK,
        });

        const outcome = await applyTitles([{id: "doc1", title: "**新标题**"}]);

        expect(outcome.applied).toEqual([{id: "doc1", title: "**新标题**"}]);
        expect(outcome.failed).toEqual([]);
        expect(calls.map((call) => call.url)).toEqual(["/api/block/getDocTitle", "/api/transactions"]);
        const operation = calls[1].data.transactions[0].doOperations[0];
        expect(operation.action).toBe("setDocTitle");
        expect(operation.id).toBe("doc1");
        expect(operation.data.expectedRevision).toBe("r1");
        expect(operation.data.blockDOM).toContain('<span data-type="strong">新标题</span>');
    });

    it("旧内核上带行内 Markdown 的标题按纯文本写回", async () => {
        useLute(fakeLute());
        stubKernel({
            "/api/block/getDocTitle": new Error("not found"),
            "/api/filetree/renameDocByID": OK,
        });

        await applyTitles([{id: "doc1", title: "**新标题**"}]);

        expect(calls.map((call) => call.url))
            .toEqual(["/api/block/getDocTitle", "/api/filetree/renameDocByID"]);
        expect(calls[1].data).toEqual({id: "doc1", title: "新标题"});
    });

    it("富文本标题用 setDocTitle 事务提交 BlockDOM", async () => {
        const lute = fakeLute();
        useLute(lute);
        stubKernel({
            "/api/block/getDocTitle": RICH_TITLE,
            "/api/transactions": OK,
        });

        const outcome = await applyTitles([{id: "doc1", title: "**新标题**"}]);

        expect(outcome.applied).toEqual([{id: "doc1", title: "**新标题**"}]);
        expect(outcome.failed).toEqual([]);
        expect(calls.map((call) => call.url)).toEqual(["/api/block/getDocTitle", "/api/transactions"]);
        const operation = calls[1].data.transactions[0].doOperations[0];
        expect(operation).toEqual({
            action: "setDocTitle",
            id: "doc1",
            data: {
                expectedRevision: "r1",
                blockDOM: '<div data-node-id="fake" data-type="NodeParagraph"><div contenteditable="true">'
                    + '<span data-type="strong">新标题</span></div></div>',
            },
        });
    });

    it("标题里的原始 HTML 按字面交给 Lute，不变成块级结构", async () => {
        const lute = fakeLute();
        useLute(lute);
        stubKernel({
            "/api/block/getDocTitle": RICH_TITLE,
            "/api/transactions": OK,
        });

        await applyTitles([{id: "doc1", title: "C++ <algorithm> 笔记"}]);

        expect(lute.seen).toEqual(["C++ &lt;algorithm> 笔记"]);
    });

    it("没有行内解析能力时退回完整源的纯文本形式", async () => {
        useLute(fakeLute({inline: false}));
        stubKernel({
            "/api/block/getDocTitle": RICH_TITLE,
            "/api/transactions": OK,
        });

        await applyTitles([{id: "doc1", title: "**新标题**"}]);

        const data = calls[1].data.transactions[0].doOperations[0].data;
        expect(data.blockDOM).toBeUndefined();
        expect(data.expectedRevision).toBe("r1");
        expect(JSON.parse(data.source.content)).toEqual([{Type: "NodeText", Data: "新标题"}]);
    });

    it("摘要没变时不写源，避免拍平已有的行级内容", async () => {
        useLute(fakeLute());
        stubKernel({"/api/block/getDocTitle": RICH_TITLE});

        const outcome = await applyTitles([{id: "doc1", title: "旧标题"}]);

        expect(outcome.applied).toEqual([{id: "doc1", title: "旧标题"}]);
        expect(outcome.failed).toEqual([]);
        expect(calls.map((call) => call.url)).toEqual(["/api/block/getDocTitle"]);
    });

    it("标题源版本冲突时把内核原因报给用户", async () => {
        useLute(fakeLute());
        stubKernel({
            "/api/block/getDocTitle": RICH_TITLE,
            "/api/transactions": {code: -409, msg: "标题已在其他编辑器中修改，当前输入已保留"},
        });

        const outcome = await applyTitles([{id: "doc1", title: "新标题"}]);

        expect(outcome.applied).toEqual([]);
        expect(outcome.failed).toEqual([{
            edit: {id: "doc1", title: "新标题"},
            message: "标题已在其他编辑器中修改，当前输入已保留",
        }]);
    });
});
