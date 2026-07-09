import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  InterpretationSession,
  createSession,
  appendUserMessage,
  startAssistantResponse,
  updateMessageContent,
  finishStreaming,
  deleteSession,
  loadSessionsFromLegacyStorage,
  loadSession,
} from "./sessions";
import { StashItem, StashSource } from "./stash";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

const STORAGE_KEY = "standardread-interpretation-sessions";

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
    it("creates a session with sources and initial user prompt", () => {
      const sources = [makeStashItem("stash-1", "text one")];
      const session = createSession(sources, "请解读这两段内容的关系");

      expect(session).toMatchObject({
        id: "test-uuid-0001",
        sources,
        isStreaming: false,
      });
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0]).toMatchObject({
        id: "test-uuid-0002",
        role: "user",
        content: "请解读这两段内容的关系",
      });
      expect(session.createdAt).toBeGreaterThan(0);
      expect(session.updatedAt).toBeGreaterThanOrEqual(session.createdAt);
    });
  });

  describe("appendUserMessage", () => {
    it("appends a user message and updates updatedAt", () => {
      vi.useFakeTimers();
      const session = createSession([makeStashItem("stash-1", "text")], "initial");
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
      const session = createSession([makeStashItem("stash-1", "text")], "initial");

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
          { id: "msg-assistant", role: "assistant", content: "", createdAt: 1000 },
        ],
      };

      const updated = updateMessageContent(session, "msg-assistant", "partial answer");

      expect(updated.messages[1].content).toBe("partial answer");
      expect(updated.messages[0]).toEqual(session.messages[0]);
    });

    it("returns the same session when message id is not found", () => {
      const session = createSession([makeStashItem("stash-1", "text")], "initial");

      const updated = updateMessageContent(session, "missing", "content");

      expect(updated).toEqual(session);
    });
  });

  describe("finishStreaming", () => {
    it("clears streaming state", () => {
      const session = createSession([makeStashItem("stash-1", "text")], "initial");
      const streaming = startAssistantResponse(session);

      const finished = finishStreaming(streaming);

      expect(finished.isStreaming).toBe(false);
      expect(finished.streamingMessageId).toBeUndefined();
    });
  });

  describe("deleteSession", () => {
    it("removes the session with matching id", () => {
      const session1: InterpretationSession = { ...createSession([makeStashItem("stash-1", "text")], "initial"), id: "session-1" };
      const session2: InterpretationSession = { ...createSession([makeStashItem("stash-2", "text")], "initial"), id: "session-2" };
      const sessions = [session1, session2];

      const result = deleteSession(sessions, session1.id);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(session2.id);
      expect(result).not.toBe(sessions);
    });

    it("returns the same array when id is not found", () => {
      const session = createSession([makeStashItem("stash-1", "text")], "initial");
      const sessions = [session];

      const result = deleteSession(sessions, "non-existent");

      expect(result).toEqual(sessions);
    });
  });

  describe("persistence", () => {
    it("loads sessions from localStorage", () => {
      const session = createSession([makeStashItem("stash-1", "text")], "initial");
      localStorage.setItem(STORAGE_KEY, JSON.stringify([session]));

      const loaded = loadSessionsFromLegacyStorage();

      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe(session.id);
      expect(loaded[0].messages).toEqual(session.messages);
    });

    it("returns empty array when localStorage is empty", () => {
      expect(loadSessionsFromLegacyStorage()).toEqual([]);
    });

    it("returns empty array when stored data is invalid", () => {
      localStorage.setItem(STORAGE_KEY, "not-json");
      expect(loadSessionsFromLegacyStorage()).toEqual([]);
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
        messages: [{ id: "msg-1", role: "user", content: "hello", createdAt: 1 }],
        isStreaming: true,
        streamingMessageId: "msg-2",
        createdAt: 1,
        updatedAt: 2,
      };
      mockInvoke.mockResolvedValue(backendResponse);

      const result = await loadSession("session-1");

      expect(mockInvoke).toHaveBeenCalledWith("load_session", { sessionId: "session-1" });
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
});
