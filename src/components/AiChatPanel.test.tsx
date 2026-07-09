import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import AiChatPanel from "../components/AiChatPanel";
import { StashItem, StashSource } from "../services/stash";
import { InterpretationSession, InterpretationMessage } from "../services/sessions";

vi.mock("../services/llm", async () => {
  const actual = await vi.importActual<typeof import("../services/llm")>("../services/llm");
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

function makeStash(id: string, text: string, overrides: Partial<StashItem> = {}): StashItem {
  return {
    id,
    source: makeSource(),
    text,
    createdAt: 1000,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<InterpretationMessage> = {}): InterpretationMessage {
  return {
    id: `msg-${overrides.role ?? "user"}`,
    role: "user",
    content: "hello",
    createdAt: 1000,
    ...overrides,
  };
}

function makeSession(overrides: Partial<InterpretationSession> = {}): InterpretationSession {
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

  it("renders stash and sessions tabs", () => {
    render(
      <AiChatPanel
        stashes={[]}
        sessions={[]}
        onRemoveStash={vi.fn()}
        onClearStashes={vi.fn()}
        onCustomInterpret={vi.fn()}
        onFollowUp={vi.fn()}
      />
    );

    expect(screen.getByRole("tab", { name: /暂存区/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /解读记录/i })).toBeInTheDocument();
  });

  it("shows stash placeholder when empty", () => {
    render(
      <AiChatPanel
        stashes={[]}
        sessions={[]}
        onRemoveStash={vi.fn()}
        onClearStashes={vi.fn()}
        onCustomInterpret={vi.fn()}
        onFollowUp={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: /暂存区/i }));

    expect(screen.getByText(/暂无暂存片段/i)).toBeInTheDocument();
  });

  it("renders stash items with source info", () => {
    const stashes = [
      makeStash("stash-1", "first excerpt", { source: makeSource({ fileName: "a.pdf", page: 3 }) }),
      makeStash("stash-2", "second excerpt", { source: makeSource({ fileName: "b.pdf", page: 5 }) }),
    ];

    render(
      <AiChatPanel
        stashes={stashes}
        sessions={[]}
        onRemoveStash={vi.fn()}
        onClearStashes={vi.fn()}
        onCustomInterpret={vi.fn()}
        onFollowUp={vi.fn()}
      />
    );

    expect(screen.getByText(/a.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/第 3 页/)).toBeInTheDocument();
    expect(screen.getByText(/b.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/第 5 页/)).toBeInTheDocument();
  });

  it("calls onRemoveStash when deleting a stash", () => {
    const onRemoveStash = vi.fn();
    const stashes = [makeStash("stash-1", "text")];

    render(
      <AiChatPanel
        stashes={stashes}
        sessions={[]}
        onRemoveStash={onRemoveStash}
        onClearStashes={vi.fn()}
        onCustomInterpret={vi.fn()}
        onFollowUp={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /删除/i }));

    expect(onRemoveStash).toHaveBeenCalledWith("stash-1");
  });

  it("expands and collapses long stash text", () => {
    const longText = "a".repeat(200);
    render(
      <AiChatPanel
        stashes={[makeStash("stash-1", longText)]}
        sessions={[]}
        onRemoveStash={vi.fn()}
        onClearStashes={vi.fn()}
        onCustomInterpret={vi.fn()}
        onFollowUp={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: /展开/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /展开/i }));
    expect(screen.getByRole("button", { name: /收起/i })).toBeInTheDocument();
    expect(screen.getByText(longText)).toBeInTheDocument();
  });

  it("calls onUpdateStash when editing a stash", () => {
    const onUpdateStash = vi.fn();
    render(
      <AiChatPanel
        stashes={[makeStash("stash-1", "original text")]}
        sessions={[]}
        onRemoveStash={vi.fn()}
        onUpdateStash={onUpdateStash}
        onClearStashes={vi.fn()}
        onCustomInterpret={vi.fn()}
        onFollowUp={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /编辑/i }));
    const textarea = screen.getByDisplayValue("original text");
    fireEvent.change(textarea, { target: { value: "updated text" } });
    fireEvent.click(screen.getByRole("button", { name: /保存/i }));

    expect(onUpdateStash).toHaveBeenCalledWith("stash-1", "updated text");
  });

  it("calls onClearStashes when clearing", () => {
    const onClearStashes = vi.fn();

    render(
      <AiChatPanel
        stashes={[makeStash("stash-1", "text")]}
        sessions={[]}
        onRemoveStash={vi.fn()}
        onClearStashes={onClearStashes}
        onCustomInterpret={vi.fn()}
        onFollowUp={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /清空暂存/i }));

    expect(onClearStashes).toHaveBeenCalled();
  });

  it("opens custom interpret modal", () => {
    render(
      <AiChatPanel
        stashes={[makeStash("stash-1", "text")]}
        sessions={[]}
        onRemoveStash={vi.fn()}
        onClearStashes={vi.fn()}
        onCustomInterpret={vi.fn()}
        onFollowUp={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /自定义解读/i }));

    expect(screen.getByRole("heading", { name: /自定义解读/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/输入你的解读要求/)).toBeInTheDocument();
  });

  it("calls onCustomInterpret when modal submitted", () => {
    const onCustomInterpret = vi.fn();

    render(
      <AiChatPanel
        stashes={[makeStash("stash-1", "text")]}
        sessions={[]}
        onRemoveStash={vi.fn()}
        onClearStashes={vi.fn()}
        onCustomInterpret={onCustomInterpret}
        onFollowUp={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /自定义解读/i }));
    fireEvent.change(screen.getByPlaceholderText(/输入你的解读要求/), {
      target: { value: "请分析关系" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/i }));

    expect(onCustomInterpret).toHaveBeenCalledWith("请分析关系");
  });

  it("renders sessions in interpretation tab", () => {
    const sessions = [makeSession({ id: "session-1" })];

    render(
      <AiChatPanel
        stashes={[]}
        sessions={sessions}
        onRemoveStash={vi.fn()}
        onClearStashes={vi.fn()}
        onCustomInterpret={vi.fn()}
        onFollowUp={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: /解读记录/i }));

    expect(screen.getByText(/请解读/)).toBeInTheDocument();
  });

  it("expands session to show messages", () => {
    const sessions = [
      makeSession({
        id: "session-1",
        messages: [
          makeMessage({ id: "msg-1", role: "user", content: "问题" }),
          makeMessage({ id: "msg-2", role: "assistant", content: "回答" }),
        ],
      }),
    ];

    render(
      <AiChatPanel
        stashes={[]}
        sessions={sessions}
        onRemoveStash={vi.fn()}
        onClearStashes={vi.fn()}
        onCustomInterpret={vi.fn()}
        onFollowUp={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: /解读记录/i }));
    fireEvent.click(screen.getByText(/问题/));

    expect(screen.getByText(/回答/)).toBeInTheDocument();
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

    render(
      <AiChatPanel
        stashes={[]}
        sessions={sessions}
        onRemoveStash={vi.fn()}
        onClearStashes={vi.fn()}
        onCustomInterpret={vi.fn()}
        onFollowUp={onFollowUp}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: /解读记录/i }));
    fireEvent.click(screen.getByText(/问题/));

    const input = screen.getByPlaceholderText(/继续追问/);
    fireEvent.change(input, { target: { value: "追问内容" } });
    fireEvent.click(screen.getByRole("button", { name: /发送/i }));

    expect(onFollowUp).toHaveBeenCalledWith("session-1", "追问内容");
  });
});
