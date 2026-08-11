import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import AiChatPanel from "../components/AiChatPanel";
import { StashItem, StashSource } from "../services/stash";
import {
  InterpretationSession,
  InterpretationMessage,
} from "../services/sessions";

vi.mock("../services/llm", async () => {
  const actual =
    await vi.importActual<typeof import("../services/llm")>("../services/llm");
  return {
    ...actual,
    streamChatCompletion: vi.fn(),
  };
});

function makeSource(overrides: Partial<StashSource> = {}): StashSource {
  return {
    tabId: "tab-1",
    fileName: "file.pdf",
    filePath: "/path/to/file.pdf",
    fileHash: "hash-file",
    page: 3,
    pdfX: 100,
    pdfY: 200,
    ...overrides,
  };
}

function makeStash(
  id: string,
  text: string,
  overrides: Partial<StashItem> = {}
): StashItem {
  return {
    id,
    source: makeSource(),
    text,
    createdAt: 1000,
    ...overrides,
  };
}

function makeMessage(
  overrides: Partial<InterpretationMessage> = {}
): InterpretationMessage {
  return {
    id: `msg-${overrides.role ?? "user"}`,
    role: "user",
    content: "hello",
    createdAt: 1000,
    ...overrides,
  };
}

function makeSession(
  overrides: Partial<InterpretationSession> = {}
): InterpretationSession {
  return {
    id: "session-1",
    sources: [makeStash("stash-1", "source text")],
    messages: [makeMessage({ id: "msg-1", role: "user", content: "请解读" })],
    isStreaming: false,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("AiChatPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderPanel = (
    props: Partial<React.ComponentProps<typeof AiChatPanel>> = {}
  ) =>
    render(
      <AiChatPanel
        stashes={[]}
        sessions={[]}
        onRemoveStash={vi.fn()}
        onClearStashes={vi.fn()}
        onOpenCustomInterpret={vi.fn()}
        onFollowUp={vi.fn()}
        {...props}
      />
    );

  it("renders stash and sessions tabs", () => {
    renderPanel();

    expect(screen.getByRole("tab", { name: /暂存区/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /解读记录/i })).toBeInTheDocument();
  });

  it("shows stash placeholder when empty", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("tab", { name: /暂存区/i }));

    expect(screen.getByText(/暂无暂存片段/i)).toBeInTheDocument();
  });

  it("activates the requested tab when tabRequest nonce changes", () => {
    const { rerender } = renderPanel({
      tabRequest: { tab: "sessions", nonce: 1 },
    });
    expect(screen.getByRole("tab", { name: /解读记录/i })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    rerender(
      <AiChatPanel
        stashes={[]}
        sessions={[]}
        onRemoveStash={vi.fn()}
        onClearStashes={vi.fn()}
        onOpenCustomInterpret={vi.fn()}
        onFollowUp={vi.fn()}
        tabRequest={{ tab: "stash", nonce: 2 }}
      />
    );
    expect(screen.getByRole("tab", { name: /暂存区/i })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("honors tabRequest even after the user manually switched tabs", () => {
    const { rerender } = renderPanel();

    // 用户手动切到暂存 tab
    fireEvent.click(screen.getByRole("tab", { name: /暂存区/i }));
    expect(screen.getByRole("tab", { name: /暂存区/i })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    // PDF 侧发起解读：强制切回解读记录 tab
    rerender(
      <AiChatPanel
        stashes={[]}
        sessions={[]}
        onRemoveStash={vi.fn()}
        onClearStashes={vi.fn()}
        onOpenCustomInterpret={vi.fn()}
        onFollowUp={vi.fn()}
        tabRequest={{ tab: "sessions", nonce: 1 }}
      />
    );
    expect(screen.getByRole("tab", { name: /解读记录/i })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    // 之后用户仍可自由切换，相同 nonce 不再强制
    fireEvent.click(screen.getByRole("tab", { name: /暂存区/i }));
    rerender(
      <AiChatPanel
        stashes={[]}
        sessions={[]}
        onRemoveStash={vi.fn()}
        onClearStashes={vi.fn()}
        onOpenCustomInterpret={vi.fn()}
        onFollowUp={vi.fn()}
        tabRequest={{ tab: "sessions", nonce: 1 }}
      />
    );
    expect(screen.getByRole("tab", { name: /暂存区/i })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("renders stash items with source info", () => {
    const stashes = [
      makeStash("stash-1", "first excerpt", {
        source: makeSource({ fileName: "a.pdf", page: 3 }),
      }),
      makeStash("stash-2", "second excerpt", {
        source: makeSource({ fileName: "b.pdf", page: 5 }),
      }),
    ];

    renderPanel({ stashes });

    expect(screen.getByText(/a.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/第 3 页/)).toBeInTheDocument();
    expect(screen.getByText(/b.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/第 5 页/)).toBeInTheDocument();
  });

  it("calls onRemoveStash when deleting a stash", () => {
    const onRemoveStash = vi.fn();
    const stashes = [makeStash("stash-1", "text")];

    renderPanel({ stashes, onRemoveStash });

    fireEvent.click(screen.getByRole("button", { name: /删除/i }));

    expect(onRemoveStash).toHaveBeenCalledWith("stash-1");
  });

  it("expands and collapses long stash text", () => {
    const longText = "a".repeat(200);
    renderPanel({ stashes: [makeStash("stash-1", longText)] });

    expect(screen.getByRole("button", { name: /展开/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /展开/i }));
    expect(screen.getByRole("button", { name: /收起/i })).toBeInTheDocument();
    expect(screen.getByText(longText)).toBeInTheDocument();
  });

  it("calls onUpdateStash when editing a stash", () => {
    const onUpdateStash = vi.fn();
    renderPanel({
      stashes: [makeStash("stash-1", "original text")],
      onUpdateStash,
    });

    fireEvent.click(screen.getByRole("button", { name: /编辑/i }));
    const textarea = screen.getByDisplayValue("original text");
    fireEvent.change(textarea, { target: { value: "updated text" } });
    fireEvent.click(screen.getByRole("button", { name: /保存/i }));

    expect(onUpdateStash).toHaveBeenCalledWith("stash-1", "updated text");
  });

  it("calls onClearStashes when clearing", () => {
    const onClearStashes = vi.fn();

    renderPanel({ stashes: [makeStash("stash-1", "text")], onClearStashes });

    fireEvent.click(screen.getByRole("button", { name: /清空暂存/i }));

    expect(onClearStashes).toHaveBeenCalled();
  });

  it("opens custom interpret modal with select-all semantics when not in selection mode", () => {
    const onOpenCustomInterpret = vi.fn();
    const stashes = [makeStash("stash-1", "text")];

    renderPanel({ stashes, onOpenCustomInterpret });

    fireEvent.click(
      screen.getByRole("button", { name: "自定义解读（1 个片段）" })
    );

    expect(onOpenCustomInterpret).toHaveBeenCalledWith(null);
  });

  it("passes selected stash ids in selection mode", () => {
    const onOpenCustomInterpret = vi.fn();
    const stashes = [
      makeStash("stash-1", "first excerpt"),
      makeStash("stash-2", "second excerpt"),
    ];

    renderPanel({ stashes, onOpenCustomInterpret });

    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.click(screen.getByText("first excerpt"));

    fireEvent.click(
      screen.getByRole("button", { name: "自定义解读（1 个片段）" })
    );

    expect(onOpenCustomInterpret).toHaveBeenCalledWith(new Set(["stash-1"]));
  });

  it("disables custom interpret button when selection mode has nothing selected", () => {
    renderPanel({ stashes: [makeStash("stash-1", "text")] });

    fireEvent.click(screen.getByRole("button", { name: "选择" }));

    expect(
      screen.getByRole("button", { name: "自定义解读（0 个片段）" })
    ).toBeDisabled();
  });

  it("toggles stash selection via checkbox", () => {
    renderPanel({ stashes: [makeStash("stash-1", "text")] });

    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    const checkbox = screen.getByRole("checkbox", { name: "选择该片段" });
    expect(checkbox).not.toBeChecked();

    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(
      screen.getByRole("button", { name: "自定义解读（1 个片段）" })
    ).toBeEnabled();

    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "自定义解读（0 个片段）" })
    ).toBeDisabled();
  });

  it("exits selection mode and restores select-all behavior", () => {
    const onOpenCustomInterpret = vi.fn();
    const stashes = [
      makeStash("stash-1", "first excerpt"),
      makeStash("stash-2", "second excerpt"),
    ];

    renderPanel({ stashes, onOpenCustomInterpret });

    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.click(screen.getByText("first excerpt"));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "自定义解读（2 个片段）" })
    );

    expect(onOpenCustomInterpret).toHaveBeenCalledWith(null);
  });

  it("renders sessions in interpretation tab", () => {
    const sessions = [makeSession({ id: "session-1" })];

    renderPanel({ sessions });

    fireEvent.click(screen.getByRole("tab", { name: /解读记录/i }));

    // 页码徽章 + 类型徽章 + 无 summary 时回退显示来源片段摘要
    expect(screen.getByText("p.3")).toBeInTheDocument();
    expect(screen.getByText("解读")).toBeInTheDocument();
    expect(screen.getByText(/source text/)).toBeInTheDocument();
  });

  it("renders LLM summary and custom type badge when present", () => {
    const sessions = [
      makeSession({
        id: "session-1",
        action: "custom",
        summary: "8.1 与 8.2 条款差异分析",
      }),
    ];

    renderPanel({ sessions });

    fireEvent.click(screen.getByRole("tab", { name: /解读记录/i }));

    expect(screen.getByText("自定义解读")).toBeInTheDocument();
    expect(screen.getByText("8.1 与 8.2 条款差异分析")).toBeInTheDocument();
    // 有 summary 时不再回退显示来源片段原文
    expect(screen.queryByText(/source text/)).not.toBeInTheDocument();
  });

  it("calls onDeleteSession from the list item without entering chatbox", () => {
    const onDeleteSession = vi.fn();
    const sessions = [makeSession({ id: "session-1" })];

    renderPanel({ sessions, onDeleteSession });

    fireEvent.click(screen.getByRole("tab", { name: /解读记录/i }));
    fireEvent.click(screen.getByRole("button", { name: /删除解读记录/i }));

    expect(onDeleteSession).toHaveBeenCalledWith("session-1");
    // 删除按钮 stopPropagation：不应进入会话详情
    expect(
      screen.queryByRole("button", { name: /返回解读记录/i })
    ).not.toBeInTheDocument();
  });

  it("calls onDeleteSession from the chatbox header", () => {
    const onDeleteSession = vi.fn();
    const sessions = [makeSession({ id: "session-1" })];

    renderPanel({ sessions, onDeleteSession });

    fireEvent.click(screen.getByRole("tab", { name: /解读记录/i }));
    fireEvent.click(screen.getByText(/source text/));
    fireEvent.click(screen.getByRole("button", { name: /删除解读记录/i }));

    expect(onDeleteSession).toHaveBeenCalledWith("session-1");
  });

  it("enters full-screen chatbox when clicking a session", () => {
    const sessions = [
      makeSession({
        id: "session-1",
        messages: [
          makeMessage({ id: "msg-1", role: "user", content: "问题" }),
          makeMessage({ id: "msg-2", role: "assistant", content: "回答" }),
        ],
      }),
    ];

    renderPanel({ sessions });

    fireEvent.click(screen.getByRole("tab", { name: /解读记录/i }));
    fireEvent.click(screen.getByText(/source text/));

    expect(screen.getByText(/回答/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /返回解读记录/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: /解读记录/i })
    ).not.toBeInTheDocument();
  });

  it("calls onGotoSession and still enters chatbox when clicking a session", () => {
    const sessions = [
      makeSession({
        id: "session-1",
        messages: [
          makeMessage({ id: "msg-1", role: "user", content: "问题" }),
          makeMessage({ id: "msg-2", role: "assistant", content: "回答" }),
        ],
      }),
    ];
    const onGotoSession = vi.fn();

    renderPanel({ sessions, onGotoSession });

    fireEvent.click(screen.getByRole("tab", { name: /解读记录/i }));
    fireEvent.click(screen.getByText(/source text/));

    expect(onGotoSession).toHaveBeenCalledTimes(1);
    expect(onGotoSession).toHaveBeenCalledWith(sessions[0]);
    expect(screen.getByText(/回答/)).toBeInTheDocument();
  });

  it("returns to session list when back button is clicked", () => {
    const sessions = [
      makeSession({
        id: "session-1",
        messages: [
          makeMessage({ id: "msg-1", role: "user", content: "问题" }),
          makeMessage({ id: "msg-2", role: "assistant", content: "回答" }),
        ],
      }),
    ];

    renderPanel({ sessions });

    fireEvent.click(screen.getByRole("tab", { name: /解读记录/i }));
    fireEvent.click(screen.getByText(/source text/));
    expect(screen.getByText(/回答/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /返回解读记录/i }));

    expect(screen.queryByText(/回答/)).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /解读记录/i })).toBeInTheDocument();
  });

  it("enters chatbox when expandedSessionId prop is provided", () => {
    const sessions = [
      makeSession({
        id: "session-1",
        messages: [
          makeMessage({ id: "msg-1", role: "user", content: "问题" }),
          makeMessage({ id: "msg-2", role: "assistant", content: "回答" }),
        ],
      }),
    ];

    const { rerender } = renderPanel({ sessions });
    expect(screen.getByRole("tab", { name: /解读记录/i })).toBeInTheDocument();

    rerender(
      <AiChatPanel
        stashes={[]}
        sessions={sessions}
        expandedSessionId="session-1"
        onRemoveStash={vi.fn()}
        onClearStashes={vi.fn()}
        onOpenCustomInterpret={vi.fn()}
        onFollowUp={vi.fn()}
      />
    );

    expect(screen.getByText(/回答/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /返回解读记录/i })
    ).toBeInTheDocument();
  });

  it("returns to list when active session is removed", () => {
    const sessions = [
      makeSession({
        id: "session-1",
        messages: [makeMessage({ id: "msg-1", role: "user", content: "问题" })],
      }),
    ];

    const { rerender } = renderPanel({
      sessions,
      expandedSessionId: "session-1",
    });
    expect(screen.getByText(/问题/)).toBeInTheDocument();

    rerender(
      <AiChatPanel
        stashes={[]}
        sessions={[]}
        onRemoveStash={vi.fn()}
        onClearStashes={vi.fn()}
        onOpenCustomInterpret={vi.fn()}
        onFollowUp={vi.fn()}
      />
    );

    expect(screen.queryByText(/问题/)).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /解读记录/i })).toBeInTheDocument();
  });

  it("filters sessions by current/all scope", () => {
    const current = makeSession({ id: "session-1", summary: "当前文档的解读" });
    const other = makeSession({
      id: "session-2",
      summary: "另一文档的解读",
      sources: [
        makeStash("stash-9", "other", {
          source: makeSource({ fileName: "other.pdf", page: 7 }),
        }),
      ],
    });

    renderPanel({ sessions: [current], allSessions: [current, other] });

    fireEvent.click(screen.getByRole("tab", { name: /解读记录/i }));

    expect(screen.getByText("当前文档的解读")).toBeInTheDocument();
    expect(screen.queryByText("另一文档的解读")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "当前文档" }));

    expect(screen.getByText("另一文档的解读")).toBeInTheDocument();
    // 从「全部」视图可以进入非当前文档的会话详情
    fireEvent.click(screen.getByText("另一文档的解读"));
    expect(
      screen.getByRole("button", { name: /返回解读记录/i })
    ).toBeInTheDocument();
  });

  it("collapses long first user message and shows source cards", () => {
    const longPrompt = "模板提示词".repeat(60);
    const sessions = [
      makeSession({
        id: "session-1",
        messages: [
          makeMessage({ id: "msg-1", role: "user", content: longPrompt }),
          makeMessage({ id: "msg-2", role: "assistant", content: "回答" }),
        ],
      }),
    ];

    renderPanel({ sessions });

    fireEvent.click(screen.getByRole("tab", { name: /解读记录/i }));
    fireEvent.click(screen.getByText(/source text/));

    // 来源片段卡片（点击跳原文）
    const sourceCard = screen.getByRole("button", { name: /file\.pdf/ });
    expect(sourceCard).toBeInTheDocument();
    // 长 prompt 默认折叠，展开后可见全文
    expect(screen.queryByText(longPrompt)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    expect(screen.getByText(longPrompt)).toBeInTheDocument();
  });

  it("calls onFollowUp when submitting follow-up", () => {
    const onFollowUp = vi.fn();
    const sessions = [
      makeSession({
        id: "session-1",
        messages: [
          makeMessage({ id: "msg-1", role: "user", content: "问题" }),
          makeMessage({ id: "msg-2", role: "assistant", content: "回答" }),
        ],
      }),
    ];

    renderPanel({ sessions, onFollowUp });

    fireEvent.click(screen.getByRole("tab", { name: /解读记录/i }));
    fireEvent.click(screen.getByText(/source text/));

    const input = screen.getByPlaceholderText(/继续追问/);
    fireEvent.change(input, { target: { value: "追问内容" } });
    fireEvent.click(screen.getByRole("button", { name: /发送/i }));

    expect(onFollowUp).toHaveBeenCalledWith("session-1", "追问内容");
  });

  it("shows interrupt button when session is streaming", () => {
    const onInterrupt = vi.fn();
    const sessions = [
      makeSession({
        id: "session-1",
        isStreaming: true,
        messages: [
          makeMessage({ id: "msg-1", role: "user", content: "问题" }),
          makeMessage({ id: "msg-2", role: "assistant", content: "" }),
        ],
      }),
    ];

    renderPanel({ sessions, onInterrupt });

    fireEvent.click(screen.getByRole("tab", { name: /解读记录/i }));
    fireEvent.click(screen.getByText(/source text/));

    const interruptBtn = screen.getByRole("button", { name: /中止/i });
    expect(interruptBtn).toBeInTheDocument();

    fireEvent.click(interruptBtn);
    expect(onInterrupt).toHaveBeenCalledWith("session-1");
  });

  it("does not interrupt when pressing Enter in textarea while streaming", () => {
    const onInterrupt = vi.fn();
    const onFollowUp = vi.fn();
    const sessions = [
      makeSession({
        id: "session-1",
        isStreaming: true,
        messages: [
          makeMessage({ id: "msg-1", role: "user", content: "问题" }),
          makeMessage({ id: "msg-2", role: "assistant", content: "" }),
        ],
      }),
    ];

    renderPanel({ sessions, onInterrupt, onFollowUp });

    fireEvent.click(screen.getByRole("tab", { name: /解读记录/i }));
    fireEvent.click(screen.getByText(/source text/));

    const input = screen.getByPlaceholderText(/生成中/);
    expect(input).not.toBeDisabled();

    fireEvent.change(input, { target: { value: "下一个问题" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: false });

    expect(onInterrupt).not.toHaveBeenCalled();
    expect(onFollowUp).not.toHaveBeenCalled();
    expect(input).toHaveValue("下一个问题");
  });

  describe("session sort", () => {
    const sessionItemTexts = (container: HTMLElement) =>
      Array.from(container.querySelectorAll(".session-item")).map(
        (el) => el.textContent ?? ""
      );

    it("sorts sessions by recent activity by default", () => {
      const sessions = [
        makeSession({ id: "s1", summary: "最旧活动", updatedAt: 100 }),
        makeSession({ id: "s2", summary: "最新活动", updatedAt: 300 }),
        makeSession({ id: "s3", summary: "中间活动", updatedAt: 200 }),
      ];

      const { container } = renderPanel({ sessions });

      const texts = sessionItemTexts(container);
      expect(texts[0]).toContain("最新活动");
      expect(texts[1]).toContain("中间活动");
      expect(texts[2]).toContain("最旧活动");
    });

    it("reorders by created time and notifies change", () => {
      const onSessionSortModeChange = vi.fn();
      const sessions = [
        makeSession({
          id: "s1",
          summary: "后创建",
          createdAt: 300,
          updatedAt: 100,
        }),
        makeSession({
          id: "s2",
          summary: "先创建",
          createdAt: 100,
          updatedAt: 300,
        }),
      ];

      const { container } = renderPanel({
        sessions,
        onSessionSortModeChange,
      });

      fireEvent.click(screen.getByRole("button", { name: "最近活动" }));
      fireEvent.click(screen.getByRole("option", { name: "创建时间" }));

      expect(onSessionSortModeChange).toHaveBeenCalledWith("createdAt");
      const texts = sessionItemTexts(container);
      expect(texts[0]).toContain("后创建");
      expect(texts[1]).toContain("先创建");
    });

    it("reorders by minimum source page", () => {
      const sessions = [
        makeSession({
          id: "s1",
          summary: "第十二页",
          sources: [
            makeStash("stash-1", "p12", { source: makeSource({ page: 12 }) }),
          ],
        }),
        makeSession({
          id: "s2",
          summary: "第三页",
          sources: [
            makeStash("stash-2", "p3", { source: makeSource({ page: 3 }) }),
            makeStash("stash-3", "p7", { source: makeSource({ page: 7 }) }),
          ],
        }),
      ];

      const { container } = renderPanel({ sessions });

      fireEvent.click(screen.getByRole("button", { name: "最近活动" }));
      fireEvent.click(screen.getByRole("option", { name: "按页码" }));

      const texts = sessionItemTexts(container);
      expect(texts[0]).toContain("第三页");
      expect(texts[1]).toContain("第十二页");
    });

    it("hides page option and falls back to recent activity in all-documents scope", () => {
      const current = makeSession({
        id: "s1",
        summary: "当前文档解读",
        updatedAt: 100,
      });
      const other = makeSession({
        id: "s2",
        summary: "另一文档解读",
        updatedAt: 200,
        sources: [
          makeStash("stash-9", "other", {
            source: makeSource({ fileName: "other.pdf", page: 7 }),
          }),
        ],
      });

      const { container } = renderPanel({
        sessions: [current],
        allSessions: [current, other],
        sessionSortMode: "page",
      });

      fireEvent.click(screen.getByRole("button", { name: "当前文档" }));

      // 排序下拉回退显示「最近活动」，且选项中不再提供「按页码」
      const trigger = screen.getByRole("button", { name: "最近活动" });
      fireEvent.click(trigger);
      expect(screen.queryByRole("option", { name: "按页码" })).toBeNull();
      // 另一文档的解读 updatedAt 更新，排在最前
      const items = container.querySelectorAll(".session-item");
      expect(items[0].textContent).toContain("另一文档解读");
    });
  });
});
