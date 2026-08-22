import { describe, expect, it } from "vitest";
import { buildShareMarkdown, shareFileName } from "./share";
import { InterpretationSession } from "./sessions";
import { StashItem } from "./stash";

function makeStash(id: string, text: string, page = 3): StashItem {
  return {
    id,
    source: {
      tabId: "tab-1",
      fileName: "IEC 61010-1.pdf",
      filePath: "/std/IEC 61010-1.pdf",
      fileHash: "hash-1",
      page,
      pdfX: 0,
      pdfY: 0,
    },
    text,
    createdAt: 1,
  };
}

function makeSession(
  overrides: Partial<InterpretationSession> = {}
): InterpretationSession {
  return {
    id: "s-1",
    sources: [makeStash("st-1", "4.2.1 The specimen shall be conditioned.")],
    messages: [
      {
        id: "m-1",
        role: "user",
        content: "【模板 prompt】请解读",
        createdAt: 1,
      },
      { id: "m-2", role: "assistant", content: "这是解读结果。", createdAt: 2 },
    ],
    isStreaming: false,
    action: "explain",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe("buildShareMarkdown", () => {
  it("标题使用会话摘要，原文以引用块展示并标注来源", () => {
    const md = buildShareMarkdown(makeSession({ summary: "温升试验条件" }));
    expect(md.startsWith("# 温升试验条件\n")).toBe(true);
    expect(md).toContain(
      "> 4.2.1 The specimen shall be conditioned.\n>\n> —— IEC 61010-1.pdf · P.3"
    );
    expect(md).toContain("这是解读结果。");
  });

  it("无摘要时回退默认标题", () => {
    const md = buildShareMarkdown(makeSession());
    expect(md.startsWith("# 标准解读\n")).toBe(true);
  });

  it("跳过首条模板 user 消息，手写追问以加粗标签开头", () => {
    const md = buildShareMarkdown(
      makeSession({
        messages: [
          { id: "m-1", role: "user", content: "【模板 prompt】", createdAt: 1 },
          { id: "m-2", role: "assistant", content: "首轮回答", createdAt: 2 },
          {
            id: "m-3",
            role: "user",
            content: "橡胶材料也适用吗？",
            createdAt: 3,
          },
          { id: "m-4", role: "assistant", content: "追问回答", createdAt: 4 },
        ],
      })
    );
    expect(md).not.toContain("【模板 prompt】");
    expect(md).toContain("**追问**：橡胶材料也适用吗？");
    expect(md).toContain("追问回答");
  });

  it("自由提问会话（空 sources）保留首条 user 消息作为提问", () => {
    const md = buildShareMarkdown(
      makeSession({
        sources: [],
        anchorFileHash: "hash-1",
        anchorFileName: "IEC 61010-1.pdf",
        summary: "爬电距离要求",
        messages: [
          {
            id: "m-1",
            role: "user",
            content: "爬电距离的要求是什么？",
            createdAt: 1,
          },
          { id: "m-2", role: "assistant", content: "回答正文", createdAt: 2 },
          { id: "m-3", role: "user", content: "再追问一句", createdAt: 3 },
          { id: "m-4", role: "assistant", content: "追问回答", createdAt: 4 },
        ],
      })
    );
    expect(md).toContain("**提问**：爬电距离的要求是什么？");
    expect(md).toContain("**追问**：再追问一句");
    expect(md).toContain("回答正文");
  });

  it("过滤 tool 消息与空内容消息", () => {
    const md = buildShareMarkdown(
      makeSession({
        messages: [
          { id: "m-1", role: "user", content: "模板", createdAt: 1 },
          {
            id: "m-2",
            role: "assistant",
            content: "",
            createdAt: 2,
            toolCalls: [
              {
                id: "tc-1",
                type: "function",
                function: { name: "read_pdf_page", arguments: "{}" },
              },
            ],
          },
          {
            id: "m-3",
            role: "tool",
            toolCallId: "tc-1",
            content: "第 23 页原文……",
            createdAt: 3,
          },
          { id: "m-4", role: "assistant", content: "最终结论", createdAt: 4 },
        ],
      })
    );
    expect(md).not.toContain("第 23 页原文");
    expect(md).toContain("最终结论");
  });

  it("多片段按顺序生成多个引用块，多行文本逐行加引用前缀", () => {
    const md = buildShareMarkdown(
      makeSession({
        sources: [
          makeStash("st-1", "第一行\n第二行", 3),
          makeStash("st-2", "另一片段", 7),
        ],
      })
    );
    expect(md).toContain("> 第一行\n> 第二行");
    expect(md).toContain("> —— IEC 61010-1.pdf · P.3");
    expect(md).toContain("> 另一片段");
    expect(md).toContain("> —— IEC 61010-1.pdf · P.7");
  });
});

describe("shareFileName", () => {
  it("使用摘要并剔除非法字符", () => {
    expect(
      shareFileName(makeSession({ summary: 'a/b\\c:d*e?f"g<h>i|j' }))
    ).toBe("abcdefghij.md");
  });

  it("无摘要或清理后为空时回退默认标题", () => {
    expect(shareFileName(makeSession())).toBe("标准解读.md");
    expect(shareFileName(makeSession({ summary: "///" }))).toBe("标准解读.md");
  });

  it("超长摘要截断到 50 字符", () => {
    const name = shareFileName(makeSession({ summary: "长".repeat(80) }));
    expect(name).toBe(`${"长".repeat(50)}.md`);
  });
});
