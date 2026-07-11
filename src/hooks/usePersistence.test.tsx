import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import type { InvokeArgs } from "@tauri-apps/api/core";
import {
  usePersistence,
  UsePersistenceReturn,
  UsePersistenceProps,
} from "./usePersistence";
import { DEFAULT_SETTINGS } from "../services/settings";
import { InterpretationSession } from "../services/sessions";
import { Annotation } from "../services/annotations";

// Mock Tauri core invoke for all persistence-related commands.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string, _args?: Record<string, unknown>) => {
    switch (command) {
      case "load_pdf_data":
        return Promise.resolve({ annotations: [], sessionIds: [] });
      case "save_pdf_data":
      case "save_session":
      case "delete_session":
      case "log_error":
        return Promise.resolve(null);
      default:
        return Promise.reject(
          new Error(`No mock handler for command: ${command}`)
        );
    }
  }),
}));

// Mock LLM streaming so we can count calls and control chunks.
vi.mock("../services/llm", async () => {
  const actual =
    await vi.importActual<typeof import("../services/llm")>("../services/llm");
  return {
    ...actual,
    streamChatCompletion: vi.fn(),
  };
});

// Mock Tauri event bridge (dictionary download progress is not used here).
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// Mock confirmation dialog to always confirm in tests.
vi.mock("../services/dialog", () => ({
  showConfirm: vi.fn(() => Promise.resolve(true)),
}));

function makeMockStream(chunks: string[] = ["hello"]) {
  return async function* () {
    for (const chunk of chunks) {
      yield { type: "chunk" as const, content: chunk };
    }
  };
}

function TestHarness({
  onHook,
}: {
  onHook: (hook: UsePersistenceReturn) => void;
}) {
  const hook = usePersistence({
    activeTab: null,
    activeTabId: null,
    secondaryTab: null,
    isSplitView: false,
    openRightPanel: vi.fn(),
    settings: DEFAULT_SETTINGS,
  });
  onHook(hook);
  return null;
}

function ConfigurableHarness({
  props,
  onHook,
}: {
  props: UsePersistenceProps;
  onHook: (hook: UsePersistenceReturn) => void;
}) {
  const hook = usePersistence(props);
  onHook(hook);
  return null;
}

describe("usePersistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initializes with empty state", () => {
    let hookRef: UsePersistenceReturn;
    render(
      <StrictMode>
        <TestHarness
          onHook={(hook) => {
            hookRef = hook;
          }}
        />
      </StrictMode>
    );

    expect(hookRef!.annotations).toEqual([]);
    expect(hookRef!.stashes).toEqual([]);
    expect(hookRef!.sessions).toEqual([]);
  });

  // C-1 regression test: handleFollowUp must start exactly one stream even when
  // React StrictMode double-invokes the setSessions updater.
  it("does not double-start stream on handleFollowUp in StrictMode", async () => {
    const { streamChatCompletion } = await import("../services/llm");
    const streamSpy = vi
      .mocked(streamChatCompletion)
      .mockImplementation(makeMockStream());

    let hookRef: UsePersistenceReturn;
    render(
      <StrictMode>
        <TestHarness
          onHook={(hook) => {
            hookRef = hook;
          }}
        />
      </StrictMode>
    );

    const session: InterpretationSession = {
      id: "session-1",
      sources: [],
      messages: [
        { id: "msg-1", role: "user", content: "initial", createdAt: 1000 },
      ],
      isStreaming: false,
      createdAt: 1000,
      updatedAt: 1000,
    };

    act(() => {
      hookRef!.setSessions([session]);
    });

    act(() => {
      hookRef!.handleFollowUp("session-1", "follow up prompt");
    });

    await waitFor(() => {
      expect(streamSpy).toHaveBeenCalledTimes(1);
    });

    // Advance timers so the debounced save effects settle.
    act(() => {
      vi.runAllTimers();
    });
  });

  it("aborts a running stream via handleInterruptSession", async () => {
    const { streamChatCompletion } = await import("../services/llm");
    let capturedSignal: AbortSignal | undefined;

    vi.mocked(streamChatCompletion).mockImplementation(
      async function* (_config, _messages, signal) {
        capturedSignal = signal;
        yield { type: "chunk" as const, content: "first" };
        // Simulate an ongoing stream; advancing timers is required to reach the next chunk.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        yield { type: "chunk" as const, content: "second" };
      }
    );

    let hookRef: UsePersistenceReturn;
    render(
      <StrictMode>
        <TestHarness
          onHook={(hook) => {
            hookRef = hook;
          }}
        />
      </StrictMode>
    );

    const session: InterpretationSession = {
      id: "session-1",
      sources: [],
      messages: [
        { id: "msg-1", role: "user", content: "initial", createdAt: 1000 },
      ],
      isStreaming: false,
      createdAt: 1000,
      updatedAt: 1000,
    };

    act(() => {
      hookRef!.setSessions([session]);
    });

    act(() => {
      hookRef!.handleFollowUp("session-1", "follow up prompt");
    });

    // Wait for the stream to start and capture its signal.
    await waitFor(() => {
      expect(capturedSignal).toBeDefined();
    });

    expect(capturedSignal!.aborted).toBe(false);

    act(() => {
      hookRef!.handleInterruptSession("session-1");
    });

    expect(capturedSignal!.aborted).toBe(true);
    expect(
      hookRef!.sessions.find((s) => s.id === "session-1")?.isStreaming
    ).toBe(false);
  });

  it("removes an explain annotation and its session via handleAnnotationDelete", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const invokeSpy = vi.mocked(invoke);

    let hookRef: UsePersistenceReturn;
    render(
      <StrictMode>
        <TestHarness
          onHook={(hook) => {
            hookRef = hook;
          }}
        />
      </StrictMode>
    );

    const annotation: Annotation = {
      id: "anno-1",
      type: "explain",
      text: "source text",
      position: { page: 1, x: 10, y: 20 },
      content: "interpretation content",
      isStreaming: false,
      createdAt: 1000,
      sessionId: "session-1",
    };

    const session: InterpretationSession = {
      id: "session-1",
      sources: [],
      messages: [
        { id: "msg-1", role: "user", content: "请解读", createdAt: 1000 },
      ],
      isStreaming: false,
      createdAt: 1000,
      updatedAt: 1000,
    };

    act(() => {
      hookRef!.setAnnotations([annotation]);
      hookRef!.setSessions([session]);
    });

    // Let the debounced session effect record the session as saved first,
    // so that removing it later is detected as a deletion.
    await act(async () => {
      vi.runAllTimers();
    });

    await act(async () => {
      await hookRef!.handleAnnotationDelete("anno-1");
    });

    expect(hookRef!.annotations).toHaveLength(0);
    expect(hookRef!.sessions).toHaveLength(0);

    // The session file deletion is also deferred to the debounced effect.
    await act(async () => {
      vi.runAllTimers();
    });

    expect(invokeSpy).toHaveBeenCalledWith("delete_session", {
      sessionId: "session-1",
    });
  });

  // H-5: split view must keep annotations separated by fileHash.
  it("loads secondary PDF annotations and keeps them separate by fileHash", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockImplementation(
      (command: string, args?: InvokeArgs) => {
        if (command === "load_pdf_data") {
          const filePath = (args as { filePath: string } | undefined)?.filePath;
          if (filePath === "/a.pdf") {
            return Promise.resolve({
              annotations: [
                {
                  id: "a1",
                  type: "translate",
                  text: "a",
                  position: { page: 1, x: 0, y: 0 },
                  content: "",
                  isStreaming: false,
                  createdAt: 1,
                },
              ],
              sessionIds: [],
            });
          }
          if (filePath === "/b.pdf") {
            return Promise.resolve({
              annotations: [
                {
                  id: "b1",
                  type: "translate",
                  text: "b",
                  position: { page: 1, x: 0, y: 0 },
                  content: "",
                  isStreaming: false,
                  createdAt: 1,
                },
              ],
              sessionIds: [],
            });
          }
        }
        if (
          [
            "save_pdf_data",
            "save_session",
            "delete_session",
            "log_error",
          ].includes(command)
        ) {
          return Promise.resolve(null);
        }
        return Promise.reject(
          new Error(`No mock handler for command: ${command}`)
        );
      }
    );

    const activeTab = {
      id: "tab-a",
      filePath: "/a.pdf",
      fileName: "a.pdf",
      fileHash: "hash-a",
    };
    const secondaryTab = {
      id: "tab-b",
      filePath: "/b.pdf",
      fileName: "b.pdf",
      fileHash: "hash-b",
    };

    let hookRef: UsePersistenceReturn;
    const { rerender } = render(
      <ConfigurableHarness
        props={{
          activeTab,
          activeTabId: "tab-a",
          secondaryTab: null,
          isSplitView: false,
          openRightPanel: vi.fn(),
          settings: DEFAULT_SETTINGS,
        }}
        onHook={(hook) => {
          hookRef = hook;
        }}
      />
    );

    await waitFor(() => {
      expect(hookRef!.annotations).toHaveLength(1);
    });
    expect(hookRef!.annotations[0].fileHash).toBe("hash-a");

    rerender(
      <ConfigurableHarness
        props={{
          activeTab,
          activeTabId: "tab-a",
          secondaryTab,
          isSplitView: true,
          openRightPanel: vi.fn(),
          settings: DEFAULT_SETTINGS,
        }}
        onHook={(hook) => {
          hookRef = hook;
        }}
      />
    );

    await waitFor(() => {
      expect(hookRef!.annotations).toHaveLength(2);
    });
    const hashes = hookRef!.annotations.map((a) => a.fileHash);
    expect(hashes).toContain("hash-a");
    expect(hashes).toContain("hash-b");
  });

  // H-6: closing a tab aborts its streams and cleans up exclusive sessions/annotations.
  it("aborts streaming sessions and removes exclusive resources when closing a tab", async () => {
    const { streamChatCompletion } = await import("../services/llm");
    let capturedSignal: AbortSignal | undefined;

    vi.mocked(streamChatCompletion).mockImplementation(
      async function* (_config, _messages, signal) {
        capturedSignal = signal;
        yield { type: "chunk" as const, content: "first" };
        await new Promise((resolve) => setTimeout(resolve, 1000));
        yield { type: "chunk" as const, content: "second" };
      }
    );

    let hookRef: UsePersistenceReturn;
    render(
      <ConfigurableHarness
        props={{
          activeTab: null,
          activeTabId: null,
          secondaryTab: null,
          isSplitView: false,
          openRightPanel: vi.fn(),
          settings: DEFAULT_SETTINGS,
        }}
        onHook={(hook) => {
          hookRef = hook;
        }}
      />
    );

    const session: InterpretationSession = {
      id: "session-1",
      sources: [
        {
          id: "stash-1",
          source: {
            tabId: "tab-1",
            fileName: "a.pdf",
            filePath: "/a.pdf",
            fileHash: "hash-1",
            page: 1,
            pdfX: 0,
            pdfY: 0,
          },
          text: "stash text",
          createdAt: 1,
        },
      ],
      messages: [
        { id: "msg-1", role: "user", content: "initial", createdAt: 1 },
      ],
      isStreaming: false,
      createdAt: 1,
      updatedAt: 1,
    };

    const annotation: Annotation = {
      id: "anno-1",
      type: "explain",
      text: "source",
      position: { page: 1, x: 0, y: 0 },
      content: "",
      isStreaming: false,
      createdAt: 1,
      fileHash: "hash-1",
      sessionId: "session-1",
    };

    act(() => {
      hookRef!.setAnnotations([annotation]);
      hookRef!.setSessions([session]);
    });

    act(() => {
      hookRef!.handleFollowUp("session-1", "follow up");
    });

    await waitFor(() => {
      expect(capturedSignal).toBeDefined();
    });
    expect(capturedSignal!.aborted).toBe(false);

    act(() => {
      hookRef!.abortSessionsForTab("tab-1", "hash-1", []);
    });

    expect(capturedSignal!.aborted).toBe(true);
    expect(hookRef!.sessions).toHaveLength(0);
    expect(hookRef!.annotations).toHaveLength(0);
  });
});
