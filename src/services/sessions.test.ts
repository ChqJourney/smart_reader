import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  InterpretationSession,
  createSession,
  appendUserMessage,
  startAssistantResponse,
  updateMessageContent,
  finishStreaming,
  deleteSession,
  loadSession,
  sortSessions,
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
        isStreaming: true,
        streamingMessageId: "msg-2",
        createdAt: 1,
        updatedAt: 2,
      };
      mockInvoke.mockResolvedValue(backendResponse);

      const result = await loadSession("session-1");

      expect(mockInvoke).toHaveBeenCalledWith("load_session", {
        sessionId: "session-1",
      });
      expect(result).not.toBeNull();
      expect(result!.streamingMessageId).toBe("msg-2");
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
});
