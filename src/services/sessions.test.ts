import { describe, it, expect, vi, beforeEach } from "vitest";
import i18n from "i18next";
import {
  InterpretationMessage,
  InterpretationSession,
  ToolEvent,
  createSession,
  appendUserMessage,
  startAssistantResponse,
  updateMessageContent,
  finishStreaming,
  deleteSession,
  loadSession,
  saveSession,
  sortSessions,
  collectTurnProcess,
} from "./sessions";
import { StashItem, StashSource } from "./stash";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

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

function makeStashItem(id: string, text: string): StashItem {
  return {
    id,
    source: makeSource(),
    text,
    createdAt: 1000,
  };
}

describe("sessions service", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("createSession", () => {
    it("creates a session with default explain action", () => {
      const sources = [makeStashItem("stash-1", "text one")];
      const session = createSession(sources, "请解读这两段内容的关系");

      expect(session).toMatchObject({
        id: "test-uuid-0001",
        sources,
        isStreaming: false,
        action: "explain",
      });
    });

    it("creates a session with custom action", () => {
      const sources = [makeStashItem("stash-1", "text one")];
      const session = createSession(sources, "prompt", "custom");

      expect(session.action).toBe("custom");
    });

    it("creates an anchored free-question session with empty sources", () => {
      const session = createSession(
        [],
        "这份标准对爬电距离的要求是什么？",
        "custom",
        { fileHash: "hash-a", fileName: "a.pdf" }
      );

      expect(session.sources).toEqual([]);
      expect(session.anchorFileHash).toBe("hash-a");
      expect(session.anchorFileName).toBe("a.pdf");
      expect(session.messages[0]).toMatchObject({
        role: "user",
        content: "这份标准对爬电距离的要求是什么？",
      });
    });

    it("leaves anchor fields undefined when no anchor is given", () => {
      const session = createSession([makeStashItem("stash-1", "t")], "prompt");

      expect(session.anchorFileHash).toBeUndefined();
      expect(session.anchorFileName).toBeUndefined();
    });
  });

  describe("appendUserMessage", () => {
    it("appends a user message and updates updatedAt", () => {
      vi.useFakeTimers();
      const session = createSession(
        [makeStashItem("stash-1", "text")],
        "initial"
      );
      vi.advanceTimersByTime(1);

      const updated = appendUserMessage(session, "追问内容");

      expect(updated.messages).toHaveLength(2);
      expect(updated.messages[1]).toMatchObject({
        role: "user",
        content: "追问内容",
      });
      expect(updated.updatedAt).toBeGreaterThan(session.updatedAt);
      expect(updated).not.toBe(session);
      vi.useRealTimers();
    });
  });

  describe("startAssistantResponse", () => {
    it("appends an empty assistant message and marks streaming", () => {
      const session = createSession(
        [makeStashItem("stash-1", "text")],
        "initial"
      );

      const updated = startAssistantResponse(session);

      expect(updated.messages).toHaveLength(2);
      expect(updated.messages[1]).toMatchObject({
        role: "assistant",
        content: "",
      });
      expect(updated.isStreaming).toBe(true);
      expect(updated.streamingMessageId).toBe(updated.messages[1].id);
    });
  });

  describe("updateMessageContent", () => {
    it("updates the content of the specified message", () => {
      const session: InterpretationSession = {
        ...createSession([makeStashItem("stash-1", "text")], "initial"),
        messages: [
          { id: "msg-user", role: "user", content: "initial", createdAt: 1000 },
          {
            id: "msg-assistant",
            role: "assistant",
            content: "",
            createdAt: 1000,
          },
        ],
      };

      const updated = updateMessageContent(
        session,
        "msg-assistant",
        "partial answer"
      );

      expect(updated.messages[1].content).toBe("partial answer");
      expect(updated.messages[0]).toEqual(session.messages[0]);
    });

    it("returns the same session when message id is not found", () => {
      const session = createSession(
        [makeStashItem("stash-1", "text")],
        "initial"
      );

      const updated = updateMessageContent(session, "missing", "content");

      expect(updated).toEqual(session);
    });
  });

  describe("finishStreaming", () => {
    it("clears streaming state", () => {
      const session = createSession(
        [makeStashItem("stash-1", "text")],
        "initial"
      );
      const streaming = startAssistantResponse(session);

      const finished = finishStreaming(streaming);

      expect(finished.isStreaming).toBe(false);
      expect(finished.streamingMessageId).toBeUndefined();
    });
  });

  describe("deleteSession", () => {
    it("removes the session with matching id", () => {
      const session1: InterpretationSession = {
        ...createSession([makeStashItem("stash-1", "text")], "initial"),
        id: "session-1",
      };
      const session2: InterpretationSession = {
        ...createSession([makeStashItem("stash-2", "text")], "initial"),
        id: "session-2",
      };
      const sessions = [session1, session2];

      const result = deleteSession(sessions, session1.id);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(session2.id);
      expect(result).not.toBe(sessions);
    });

    it("returns the same array when id is not found", () => {
      const session = createSession(
        [makeStashItem("stash-1", "text")],
        "initial"
      );
      const sessions = [session];

      const result = deleteSession(sessions, "non-existent");

      expect(result).toEqual(sessions);
    });
  });

  describe("loadSession", () => {
    beforeEach(() => {
      mockInvoke.mockReset();
    });

    it("maps camelCase fields from backend", async () => {
      const backendResponse = {
        id: "session-1",
        sources: [
          {
            id: "stash-1",
            source: {
              tabId: "tab-1",
              fileName: "file.pdf",
              filePath: "/path/to/file.pdf",
              fileHash: "hash-file",
              page: 3,
              pdfX: 100,
              pdfY: 200,
            },
            text: "selected text",
            createdAt: 1000,
          },
        ],
        messages: [
          { id: "msg-1", role: "user", content: "hello", createdAt: 1 },
        ],
        isStreaming: false,
        createdAt: 1,
        updatedAt: 2,
      };
      mockInvoke.mockResolvedValue(backendResponse);

      const result = await loadSession("session-1");

      expect(mockInvoke).toHaveBeenCalledWith("load_session", {
        sessionId: "session-1",
      });
      expect(result).not.toBeNull();
      expect(result!.isStreaming).toBe(false);
      expect(result!.sources[0].source.fileHash).toBe("hash-file");
      expect(result!.sources[0].source.pdfX).toBe(100);
      expect(result!.createdAt).toBe(1);
      expect(result!.updatedAt).toBe(2);
    });

    it("returns null when backend throws", async () => {
      mockInvoke.mockRejectedValue(new Error("fail"));

      const result = await loadSession("session-1");

      expect(result).toBeNull();
    });

    // 回归：流式中关窗/防抖静默期落盘会把 isStreaming=true 的会话原样保存，
    // 重启后气泡永远转圈、追问输入框永久禁用（sendDisabled）、标记呼吸态常亮。
    // 加载时必须复位脏 streaming 态并给正在生成的消息追加中断提示。
    it("resets dirty isStreaming state persisted mid-stream on load", async () => {
      const dirty = {
        id: "session-dirty",
        sources: [],
        messages: [
          { id: "msg-user", role: "user", content: "question", createdAt: 1 },
          {
            id: "msg-streaming",
            role: "assistant",
            content: "partial answer",
            createdAt: 2,
          },
        ],
        isStreaming: true,
        streamingMessageId: "msg-streaming",
        action: "explain",
        createdAt: 1,
        updatedAt: 2,
      };
      mockInvoke.mockResolvedValue(dirty);

      const result = await loadSession("session-dirty");

      expect(result).not.toBeNull();
      // 复位后追问不再被 sendDisabled 禁用
      expect(result!.isStreaming).toBe(false);
      expect(result!.streamingMessageId).toBeUndefined();
      // 正在流式输出的消息带上中断提示（对齐 onError 的 [错误] + 文案模式）
      const assistant = result!.messages[1];
      expect(assistant.content).toContain("partial answer");
      expect(assistant.content).toContain(
        i18n.t("llm.error.interruptedOnExit")
      );
      expect(assistant.error).toEqual({
        kind: "streamInterrupted",
        partialContent: "partial answer",
      });
      // 其它消息不受影响
      expect(result!.messages[0]).toEqual(dirty.messages[0]);
    });

    it("marks an empty streaming message with the interruption notice only", async () => {
      const dirty = {
        id: "session-dirty-empty",
        sources: [],
        messages: [
          { id: "msg-user", role: "user", content: "question", createdAt: 1 },
          { id: "msg-streaming", role: "assistant", content: "", createdAt: 2 },
        ],
        isStreaming: true,
        streamingMessageId: "msg-streaming",
        createdAt: 1,
        updatedAt: 2,
      };
      mockInvoke.mockResolvedValue(dirty);

      const result = await loadSession("session-dirty-empty");

      expect(result!.isStreaming).toBe(false);
      expect(result!.messages[1].content.trim()).toBe(
        `${i18n.t("common.errorPrefix")} ${i18n.t("llm.error.interruptedOnExit")}`
      );
    });

    it("does not touch finished sessions on load", async () => {
      const clean = {
        id: "session-clean",
        sources: [],
        messages: [
          { id: "msg-user", role: "user", content: "question", createdAt: 1 },
          { id: "msg-ai", role: "assistant", content: "answer", createdAt: 2 },
        ],
        isStreaming: false,
        createdAt: 1,
        updatedAt: 2,
      };
      mockInvoke.mockResolvedValue(clean);

      const result = await loadSession("session-clean");

      expect(result).toEqual(clean);
    });
  });

  describe("saveSession", () => {
    beforeEach(() => {
      mockInvoke.mockReset();
    });

    it("invokes save_session with the session payload", async () => {
      mockInvoke.mockResolvedValue(null);
      const session = createSession([makeStashItem("stash-1", "t")], "prompt");

      await saveSession(session);

      expect(mockInvoke).toHaveBeenCalledWith("save_session", { session });
    });

    it("rejects when the backend write fails so callers can retry", async () => {
      // 保存失败必须抛出：persistChangedSessions 只有拿到 rejected promise
      // 才会不更新已存快照、下次防抖/flush 重试；吞错会静默丢会话。
      mockInvoke.mockRejectedValue(new Error("disk full"));
      const session = createSession([makeStashItem("stash-1", "t")], "prompt");

      await expect(saveSession(session)).rejects.toThrow("disk full");
    });
  });

  describe("sortSessions", () => {
    function makeSession(
      id: string,
      pages: number[],
      createdAt: number,
      updatedAt: number
    ): InterpretationSession {
      return {
        ...createSession(
          pages.map((page, i) => ({
            ...makeStashItem(`${id}-stash-${i}`, `text ${page}`),
            source: makeSource({ page }),
          })),
          "prompt"
        ),
        id,
        createdAt,
        updatedAt,
      };
    }

    it("sorts by updatedAt desc in recentActivity mode", () => {
      const sessions = [
        makeSession("old", [1], 100, 100),
        makeSession("new", [2], 200, 300),
        makeSession("mid", [3], 300, 200),
      ];

      const result = sortSessions(sessions, "recentActivity");

      expect(result.map((s) => s.id)).toEqual(["new", "mid", "old"]);
    });

    it("sorts by createdAt desc in createdAt mode", () => {
      const sessions = [
        makeSession("a", [1], 100, 900),
        makeSession("b", [2], 300, 100),
        makeSession("c", [3], 200, 500),
      ];

      const result = sortSessions(sessions, "createdAt");

      expect(result.map((s) => s.id)).toEqual(["b", "c", "a"]);
    });

    it("sorts by minimum source page asc in page mode", () => {
      const sessions = [
        makeSession("p12", [12], 100, 100),
        makeSession("p3", [7, 3], 200, 200),
        makeSession("p7", [7], 300, 300),
      ];

      const result = sortSessions(sessions, "page");

      expect(result.map((s) => s.id)).toEqual(["p3", "p7", "p12"]);
    });

    it("breaks page ties by createdAt desc and puts sourceless sessions last", () => {
      const sessions = [
        makeSession("older", [5], 100, 100),
        makeSession("no-source", [], 300, 300),
        makeSession("newer", [5], 200, 200),
      ];

      const result = sortSessions(sessions, "page");

      expect(result.map((s) => s.id)).toEqual(["newer", "older", "no-source"]);
    });

    it("does not mutate the input array", () => {
      const sessions = [
        makeSession("a", [2], 100, 100),
        makeSession("b", [1], 200, 200),
      ];

      const result = sortSessions(sessions, "page");

      expect(result).not.toBe(sessions);
      expect(sessions.map((s) => s.id)).toEqual(["a", "b"]);
    });
  });

  describe("collectTurnProcess", () => {
    function makeMsg(
      id: string,
      role: InterpretationMessage["role"],
      extra: Partial<InterpretationMessage> = {}
    ): InterpretationMessage {
      return { id, role, content: "", createdAt: 1000, ...extra };
    }

    const ev = (name: string, status: ToolEvent["status"] = "done") => ({
      name,
      summary: `调用 ${name}`,
      status,
    });

    it("groups all rounds of one turn onto the final assistant message", () => {
      const messages = [
        makeMsg("u1", "user"),
        makeMsg("a-tc1", "assistant", { toolEvents: [ev("search_in_pdf")] }),
        makeMsg("t1", "tool"),
        makeMsg("a-tc2", "assistant", { toolEvents: [ev("read_pdf_page")] }),
        makeMsg("t2", "tool"),
        makeMsg("a-final", "assistant"),
      ];

      const result = collectTurnProcess(messages);

      expect(result.size).toBe(1);
      expect(result.get("a-final")?.toolEvents.map((e) => e.name)).toEqual([
        "search_in_pdf",
        "read_pdf_page",
      ]);
    });

    it("merges reasoning across rounds of the same turn", () => {
      const messages = [
        makeMsg("u1", "user"),
        makeMsg("a-tc1", "assistant", {
          toolEvents: [ev("search_in_pdf")],
          reasoningContent: "先定位条款",
        }),
        makeMsg("t1", "tool"),
        makeMsg("a-final", "assistant", { reasoningContent: "综合给出结论" }),
      ];

      const result = collectTurnProcess(messages);

      expect(result.get("a-final")?.reasoning).toBe(
        "先定位条款\n\n综合给出结论"
      );
    });

    it("keeps events of different turns separate", () => {
      const messages = [
        makeMsg("u1", "user"),
        makeMsg("a-tc1", "assistant", { toolEvents: [ev("search_in_pdf")] }),
        makeMsg("a-final-1", "assistant"),
        makeMsg("u2", "user"),
        makeMsg("a-tc2", "assistant", {
          toolEvents: [ev("read_pdf_page"), ev("list_open_pdfs")],
        }),
        makeMsg("a-final-2", "assistant"),
      ];

      const result = collectTurnProcess(messages);

      expect(result.get("a-final-1")?.toolEvents.map((e) => e.name)).toEqual([
        "search_in_pdf",
      ]);
      expect(result.get("a-final-2")?.toolEvents.map((e) => e.name)).toEqual([
        "read_pdf_page",
        "list_open_pdfs",
      ]);
    });

    it("includes the streaming placeholder's own events of the current round", () => {
      const messages = [
        makeMsg("u1", "user"),
        makeMsg("a-tc1", "assistant", { toolEvents: [ev("search_in_pdf")] }),
        makeMsg("t1", "tool"),
        makeMsg("a-streaming", "assistant", {
          toolEvents: [ev("read_pdf_page", "running")],
        }),
      ];

      const result = collectTurnProcess(messages);

      expect(result.get("a-streaming")?.toolEvents.map((e) => e.name)).toEqual([
        "search_in_pdf",
        "read_pdf_page",
      ]);
    });

    it("returns an empty map when no reasoning or tool events exist", () => {
      const messages = [makeMsg("u1", "user"), makeMsg("a1", "assistant")];

      expect(collectTurnProcess(messages).size).toBe(0);
    });
  });
});
