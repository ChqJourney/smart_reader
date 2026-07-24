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
import {
  InterpretationSession,
  InterpretationMessage,
} from "../services/sessions";
import { Annotation } from "../services/annotations";
import type { PdfTab } from "./useTabs";

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

// Mock PDF tool session for agent-loop tests.
const toolMocks = vi.hoisted(() => ({
  executeToolCall: vi.fn(),
  dispose: vi.fn(),
  beginToolSession: vi.fn(() => ({
    executeToolCall: toolMocks.executeToolCall,
    dispose: toolMocks.dispose,
  })),
}));

vi.mock("../services/pdfTools", () => ({
  beginToolSession: toolMocks.beginToolSession,
}));

function makeMockStream(chunks: string[] = ["hello"]) {
  return async function* () {
    for (const chunk of chunks) {
      yield { type: "chunk" as const, content: chunk };
    }
  };
}

function makeExplainSession(
  messages: InterpretationMessage[] = []
): InterpretationSession {
  return {
    id: "session-explain",
    sources: [],
    messages:
      messages.length > 0
        ? messages
        : [
            {
              id: "msg-user",
              role: "user",
              content: "请解读",
              createdAt: 1000,
            },
          ],
    isStreaming: false,
    action: "explain",
    createdAt: 1000,
    updatedAt: 1000,
  };
}

async function* toolCallRoundEvents(callId = "call-1") {
  yield {
    type: "toolCall" as const,
    name: "search_in_pdf",
    args: JSON.stringify({ file_hash: "hash-a", query: "clause" }),
    callId,
  };
  yield { type: "done" as const };
}

async function* finalAnswerEvents() {
  yield { type: "chunk" as const, content: "Final answer based on PDF." };
  yield { type: "done" as const };
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
    focusedTab: null,
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
      async function* (_messages, options) {
        capturedSignal = options?.signal;
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
          focusedTab: null,
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
          focusedTab: secondaryTab,
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
      async function* (_messages, options) {
        capturedSignal = options?.signal;
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
          focusedTab: null,
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
    // Sessions and annotations are KEPT (not removed) so they can be restored
    // when the PDF is reopened. Only streaming is interrupted.
    expect(hookRef!.sessions).toHaveLength(1);
  });

  it("exposes only visible tab annotations", () => {
    let hookRef: UsePersistenceReturn;
    const baseProps: UsePersistenceProps = {
      activeTab: null,
      activeTabId: null,
      secondaryTab: null,
      isSplitView: false,
      focusedTab: null,
      openRightPanel: vi.fn(),
      settings: DEFAULT_SETTINGS,
    };

    const { rerender } = render(
      <StrictMode>
        <ConfigurableHarness
          props={baseProps}
          onHook={(hook) => {
            hookRef = hook;
          }}
        />
      </StrictMode>
    );

    act(() => {
      hookRef!.setAnnotations([
        {
          id: "a1",
          type: "translate",
          text: "a",
          position: { page: 1, x: 0, y: 0 },
          content: "",
          isStreaming: false,
          createdAt: 1,
          fileHash: "hash-a",
        },
        {
          id: "b1",
          type: "translate",
          text: "b",
          position: { page: 1, x: 0, y: 0 },
          content: "",
          isStreaming: false,
          createdAt: 1,
          fileHash: "hash-b",
        },
      ]);
    });

    expect(hookRef!.annotations).toHaveLength(2);
    expect(hookRef!.visibleTabAnnotations).toHaveLength(0);

    const activeTab: PdfTab = {
      id: "tab-a",
      filePath: "/a.pdf",
      fileName: "a.pdf",
      fileHash: "hash-a",
    };

    rerender(
      <StrictMode>
        <ConfigurableHarness
          props={{
            ...baseProps,
            activeTab,
            activeTabId: "tab-a",
          }}
          onHook={(hook) => {
            hookRef = hook;
          }}
        />
      </StrictMode>
    );

    expect(hookRef!.visibleTabAnnotations).toHaveLength(1);
    expect(hookRef!.visibleTabAnnotations[0].fileHash).toBe("hash-a");
  });

  it("does not remove stash annotations from other tabs when clearing stashes", () => {
    let hookRef: UsePersistenceReturn;
    const baseProps: UsePersistenceProps = {
      activeTab: null,
      activeTabId: null,
      secondaryTab: null,
      isSplitView: false,
      focusedTab: null,
      openRightPanel: vi.fn(),
      settings: DEFAULT_SETTINGS,
    };

    const { rerender } = render(
      <StrictMode>
        <ConfigurableHarness
          props={baseProps}
          onHook={(hook) => {
            hookRef = hook;
          }}
        />
      </StrictMode>
    );

    act(() => {
      hookRef!.setStashes([
        {
          id: "stash-a",
          source: {
            tabId: "tab-a",
            fileName: "a.pdf",
            filePath: "/a.pdf",
            fileHash: "hash-a",
            page: 1,
            pdfX: 0,
            pdfY: 0,
          },
          text: "a",
          createdAt: 1,
        },
        {
          id: "stash-b",
          source: {
            tabId: "tab-b",
            fileName: "b.pdf",
            filePath: "/b.pdf",
            fileHash: "hash-b",
            page: 1,
            pdfX: 0,
            pdfY: 0,
          },
          text: "b",
          createdAt: 1,
        },
      ]);
      hookRef!.setAnnotations([
        {
          id: "anno-a",
          type: "stash",
          text: "a",
          position: { page: 1, x: 0, y: 0 },
          content: "",
          isStreaming: false,
          createdAt: 1,
          fileHash: "hash-a",
          stashId: "stash-a",
        },
        {
          id: "anno-b",
          type: "stash",
          text: "b",
          position: { page: 1, x: 0, y: 0 },
          content: "",
          isStreaming: false,
          createdAt: 1,
          fileHash: "hash-b",
          stashId: "stash-b",
        },
      ]);
    });

    const activeTab: PdfTab = {
      id: "tab-a",
      filePath: "/a.pdf",
      fileName: "a.pdf",
      fileHash: "hash-a",
    };

    rerender(
      <StrictMode>
        <ConfigurableHarness
          props={{
            ...baseProps,
            activeTab,
            activeTabId: "tab-a",
          }}
          onHook={(hook) => {
            hookRef = hook;
          }}
        />
      </StrictMode>
    );

    act(() => {
      hookRef!.handleClearStashes();
    });

    expect(hookRef!.stashes).toHaveLength(1);
    expect(hookRef!.stashes[0].id).toBe("stash-b");
    expect(hookRef!.annotations).toHaveLength(1);
    expect(hookRef!.annotations[0].fileHash).toBe("hash-b");
  });

  it("buckets annotations by fileHash via setAnnotations", () => {
    let hookRef: UsePersistenceReturn;
    const baseProps: UsePersistenceProps = {
      activeTab: null,
      activeTabId: null,
      secondaryTab: null,
      isSplitView: false,
      focusedTab: null,
      openRightPanel: vi.fn(),
      settings: DEFAULT_SETTINGS,
    };

    const { rerender } = render(
      <StrictMode>
        <ConfigurableHarness
          props={baseProps}
          onHook={(hook) => {
            hookRef = hook;
          }}
        />
      </StrictMode>
    );

    act(() => {
      hookRef!.setAnnotations([
        {
          id: "a1",
          type: "translate",
          text: "a",
          position: { page: 1, x: 0, y: 0 },
          content: "",
          isStreaming: false,
          createdAt: 1,
          fileHash: "hash-a",
        },
        {
          id: "b1",
          type: "translate",
          text: "b",
          position: { page: 1, x: 0, y: 0 },
          content: "",
          isStreaming: false,
          createdAt: 1,
          fileHash: "hash-b",
        },
      ]);
    });

    const activeTab: PdfTab = {
      id: "tab-a",
      filePath: "/a.pdf",
      fileName: "a.pdf",
      fileHash: "hash-a",
    };

    rerender(
      <StrictMode>
        <ConfigurableHarness
          props={{
            ...baseProps,
            activeTab,
            activeTabId: "tab-a",
          }}
          onHook={(hook) => {
            hookRef = hook;
          }}
        />
      </StrictMode>
    );

    expect(hookRef!.visibleTabAnnotations).toHaveLength(1);
    expect(hookRef!.visibleTabAnnotations[0].id).toBe("a1");
  });

  it("focuses right-panel stashes on the selected tab", () => {
    let hookRef: UsePersistenceReturn;
    const baseProps: UsePersistenceProps = {
      activeTab: null,
      activeTabId: null,
      secondaryTab: null,
      isSplitView: false,
      focusedTab: null,
      openRightPanel: vi.fn(),
      settings: DEFAULT_SETTINGS,
    };

    const { rerender } = render(
      <StrictMode>
        <ConfigurableHarness
          props={baseProps}
          onHook={(hook) => {
            hookRef = hook;
          }}
        />
      </StrictMode>
    );

    act(() => {
      hookRef!.setStashes([
        {
          id: "stash-a",
          source: {
            tabId: "tab-a",
            fileName: "a.pdf",
            filePath: "/a.pdf",
            fileHash: "hash-a",
            page: 1,
            pdfX: 0,
            pdfY: 0,
          },
          text: "a",
          createdAt: 1,
        },
        {
          id: "stash-b",
          source: {
            tabId: "tab-b",
            fileName: "b.pdf",
            filePath: "/b.pdf",
            fileHash: "hash-b",
            page: 1,
            pdfX: 0,
            pdfY: 0,
          },
          text: "b",
          createdAt: 1,
        },
      ]);
    });

    const focusedTab: PdfTab = {
      id: "tab-b",
      filePath: "/b.pdf",
      fileName: "b.pdf",
      fileHash: "hash-b",
    };

    rerender(
      <StrictMode>
        <ConfigurableHarness
          props={{ ...baseProps, focusedTab }}
          onHook={(hook) => {
            hookRef = hook;
          }}
        />
      </StrictMode>
    );

    expect(hookRef!.focusedTabStashes).toHaveLength(1);
    expect(hookRef!.focusedTabStashes[0].id).toBe("stash-b");

    rerender(
      <StrictMode>
        <ConfigurableHarness
          props={{
            ...baseProps,
            focusedTab: {
              id: "tab-a",
              filePath: "/a.pdf",
              fileName: "a.pdf",
              fileHash: "hash-a",
            },
          }}
          onHook={(hook) => {
            hookRef = hook;
          }}
        />
      </StrictMode>
    );

    expect(hookRef!.focusedTabStashes).toHaveLength(1);
    expect(hookRef!.focusedTabStashes[0].id).toBe("stash-a");
  });

  it("focuses right-panel sessions by the focused tab's fileHash", () => {
    let hookRef: UsePersistenceReturn;
    const baseProps: UsePersistenceProps = {
      activeTab: null,
      activeTabId: null,
      secondaryTab: null,
      isSplitView: false,
      focusedTab: null,
      openRightPanel: vi.fn(),
      settings: DEFAULT_SETTINGS,
    };

    const { rerender } = render(
      <StrictMode>
        <ConfigurableHarness
          props={baseProps}
          onHook={(hook) => {
            hookRef = hook;
          }}
        />
      </StrictMode>
    );

    const sessionA: InterpretationSession = {
      id: "session-a",
      sources: [
        {
          id: "stash-a",
          source: {
            tabId: "old-tab-a",
            fileName: "a.pdf",
            filePath: "/a.pdf",
            fileHash: "hash-a",
            page: 1,
            pdfX: 0,
            pdfY: 0,
          },
          text: "a",
          createdAt: 1,
        },
      ],
      messages: [],
      isStreaming: false,
      createdAt: 1,
      updatedAt: 1,
    };

    const sessionB: InterpretationSession = {
      id: "session-b",
      sources: [
        {
          id: "stash-b",
          source: {
            tabId: "tab-b",
            fileName: "b.pdf",
            filePath: "/b.pdf",
            fileHash: "hash-b",
            page: 1,
            pdfX: 0,
            pdfY: 0,
          },
          text: "b",
          createdAt: 1,
        },
      ],
      messages: [],
      isStreaming: false,
      createdAt: 1,
      updatedAt: 1,
    };

    act(() => {
      hookRef!.setSessions([sessionA, sessionB]);
    });

    const focusedTab: PdfTab = {
      id: "tab-a",
      filePath: "/a.pdf",
      fileName: "a.pdf",
      fileHash: "hash-a",
    };

    rerender(
      <StrictMode>
        <ConfigurableHarness
          props={{ ...baseProps, focusedTab }}
          onHook={(hook) => {
            hookRef = hook;
          }}
        />
      </StrictMode>
    );

    expect(hookRef!.focusedTabSessions).toHaveLength(1);
    expect(hookRef!.focusedTabSessions[0].id).toBe("session-a");
  });

  it("merges stashes and sessions across visible tabs in split view", () => {
    let hookRef: UsePersistenceReturn;
    const activeTab: PdfTab = {
      id: "tab-a",
      filePath: "/a.pdf",
      fileName: "a.pdf",
      fileHash: "hash-a",
    };
    const secondaryTab: PdfTab = {
      id: "tab-b",
      filePath: "/b.pdf",
      fileName: "b.pdf",
      fileHash: "hash-b",
    };
    const props: UsePersistenceProps = {
      activeTab,
      activeTabId: "tab-a",
      secondaryTab,
      isSplitView: true,
      focusedTab: activeTab,
      openRightPanel: vi.fn(),
      settings: DEFAULT_SETTINGS,
    };

    render(
      <StrictMode>
        <ConfigurableHarness
          props={props}
          onHook={(hook) => {
            hookRef = hook;
          }}
        />
      </StrictMode>
    );

    const makeStash = (id: string, tabId: string, fileHash: string) => ({
      id,
      source: {
        tabId,
        fileName: `${tabId}.pdf`,
        filePath: `/${tabId}.pdf`,
        fileHash,
        page: 1,
        pdfX: 0,
        pdfY: 0,
      },
      text: id,
      createdAt: 1,
    });

    act(() => {
      hookRef!.setStashes([
        makeStash("stash-a", "tab-a", "hash-a"),
        makeStash("stash-b", "tab-b", "hash-b"),
      ]);
      hookRef!.setSessions([
        {
          id: "session-a",
          sources: [makeStash("src-a", "tab-a", "hash-a")],
          messages: [],
          isStreaming: false,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "session-b",
          sources: [makeStash("src-b", "tab-b", "hash-b")],
          messages: [],
          isStreaming: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ]);
    });

    // 分屏下右侧面板合并显示两个可见 tab 的暂存与解读记录
    expect(hookRef!.visibleTabStashes.map((s) => s.id)).toEqual([
      "stash-a",
      "stash-b",
    ]);
    expect(hookRef!.visibleTabSessions.map((s) => s.id)).toEqual([
      "session-a",
      "session-b",
    ]);
  });

  it("adds stash and comment for the focused tab instead of the active tab", () => {
    let hookRef: UsePersistenceReturn;
    const activeTab: PdfTab = {
      id: "tab-a",
      filePath: "/a.pdf",
      fileName: "a.pdf",
      fileHash: "hash-a",
    };
    const focusedTab: PdfTab = {
      id: "tab-b",
      filePath: "/b.pdf",
      fileName: "b.pdf",
      fileHash: "hash-b",
    };
    const props: UsePersistenceProps = {
      activeTab,
      activeTabId: "tab-a",
      secondaryTab: focusedTab,
      isSplitView: true,
      focusedTab,
      openRightPanel: vi.fn(),
      settings: DEFAULT_SETTINGS,
    };

    render(
      <StrictMode>
        <ConfigurableHarness
          props={props}
          onHook={(hook) => {
            hookRef = hook;
          }}
        />
      </StrictMode>
    );

    const selection = {
      text: "selected",
      x: 10,
      y: 20,
      pdfX: 5,
      pdfY: 6,
      page: 2,
    };

    act(() => {
      hookRef!.handleAddToStash(selection, "selected");
      hookRef!.handleAddComment(selection, "note");
    });

    // 暂存归属焦点屏 tab，批注落到焦点屏的 fileHash 桶
    expect(hookRef!.stashes).toHaveLength(1);
    expect(hookRef!.stashes[0].source.tabId).toBe("tab-b");
    expect(hookRef!.stashes[0].source.fileHash).toBe("hash-b");
    const hashes = hookRef!.annotations.map((a) => a.fileHash);
    expect(hashes).toEqual(["hash-b", "hash-b"]);
  });

  it("marks interpreted stash annotations across file hashes", async () => {
    const { streamChatCompletion } = await import("../services/llm");
    vi.mocked(streamChatCompletion).mockImplementation(
      makeMockStream(["done"])
    );

    let hookRef: UsePersistenceReturn;
    const focusedTab: PdfTab = {
      id: "tab-a",
      filePath: "/a.pdf",
      fileName: "a.pdf",
      fileHash: "hash-a",
    };
    const secondaryTab: PdfTab = {
      id: "tab-b",
      filePath: "/b.pdf",
      fileName: "b.pdf",
      fileHash: "hash-b",
    };
    const props: UsePersistenceProps = {
      activeTab: focusedTab,
      activeTabId: "tab-a",
      secondaryTab,
      isSplitView: true,
      focusedTab,
      openRightPanel: vi.fn(),
      settings: DEFAULT_SETTINGS,
    };

    render(
      <StrictMode>
        <ConfigurableHarness
          props={props}
          onHook={(hook) => {
            hookRef = hook;
          }}
        />
      </StrictMode>
    );

    const makeStash = (id: string, tabId: string, fileHash: string) => ({
      id,
      source: {
        tabId,
        fileName: `${tabId}.pdf`,
        filePath: `/${tabId}.pdf`,
        fileHash,
        page: 1,
        pdfX: 0,
        pdfY: 0,
      },
      text: id,
      createdAt: 1,
    });
    const stashA = makeStash("stash-a", "tab-a", "hash-a");
    const stashB = makeStash("stash-b", "tab-b", "hash-b");

    act(() => {
      hookRef!.setStashes([stashA, stashB]);
      hookRef!.setAnnotations([
        {
          id: "anno-a",
          type: "stash",
          text: "a",
          position: { page: 1, x: 0, y: 0 },
          content: "",
          isStreaming: false,
          createdAt: 1,
          fileHash: "hash-a",
          stashId: "stash-a",
        },
        {
          id: "anno-b",
          type: "stash",
          text: "b",
          position: { page: 1, x: 0, y: 0 },
          content: "",
          isStreaming: false,
          createdAt: 1,
          fileHash: "hash-b",
          stashId: "stash-b",
        },
      ]);
    });

    act(() => {
      hookRef!.handleCustomInterpret("请分析", [stashA, stashB]);
    });

    // 跨 PDF 自定义解读：两个 fileHash 桶里的 stash 批注都被标记为已解读，
    // 否则第二个文件的批注会在解读后被误删、重启后也会丢失。
    const annoA = hookRef!.annotations.find((a) => a.id === "anno-a");
    const annoB = hookRef!.annotations.find((a) => a.id === "anno-b");
    expect(annoA).toMatchObject({
      interpretedGroupSize: 2,
      interpretedIndex: 0,
    });
    expect(annoB).toMatchObject({
      interpretedGroupSize: 2,
      interpretedIndex: 1,
    });
    expect(annoA?.sessionId).toBeDefined();
    expect(annoB?.sessionId).toBe(annoA?.sessionId);
    expect(hookRef!.stashes).toHaveLength(0);
  });

  describe("data-loss prevention", () => {
    const selection = {
      text: "selected",
      x: 10,
      y: 20,
      pdfX: 5,
      pdfY: 6,
      page: 2,
    };

    const tabA: PdfTab = {
      id: "tab-a",
      filePath: "/a.pdf",
      fileName: "a.pdf",
      fileHash: "hash-a",
    };
    const tabB: PdfTab = {
      id: "tab-b",
      filePath: "/b.pdf",
      fileName: "b.pdf",
      fileHash: "hash-b",
    };

    function propsFor(tab: PdfTab): UsePersistenceProps {
      return {
        activeTab: tab,
        activeTabId: tab.id,
        secondaryTab: null,
        isSplitView: false,
        focusedTab: tab,
        openRightPanel: vi.fn(),
        settings: DEFAULT_SETTINGS,
      };
    }

    function mockInvokeWithLoad(
      loadImpl: (args?: InvokeArgs) => Promise<unknown>
    ) {
      return (command: string, args?: InvokeArgs): Promise<any> => {
        if (command === "load_pdf_data") return loadImpl(args);
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
      };
    }

    it("does not persist a hash whose initial load failed", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const invokeSpy = vi
        .mocked(invoke)
        .mockImplementation(
          mockInvokeWithLoad(() => Promise.reject(new Error("disk error")))
        );

      let hookRef: UsePersistenceReturn;
      render(
        <ConfigurableHarness
          props={propsFor(tabA)}
          onHook={(hook) => {
            hookRef = hook;
          }}
        />
      );

      // 加载失败后用户仍做了编辑（内存中的新批注）
      act(() => {
        hookRef!.handleAddComment(selection, "note");
      });
      expect(hookRef!.annotations).toHaveLength(1);

      await act(async () => {
        vi.runAllTimers();
      });

      // 该 hash 从未成功加载，任何情况下都不得写回磁盘——否则「加载失败 →
      // 空数据覆盖」会静默清空该 PDF 的已有批注。
      const saveCalls = invokeSpy.mock.calls.filter(
        ([cmd]) => cmd === "save_pdf_data"
      );
      expect(saveCalls).toHaveLength(0);
    });

    it("flushes dirty annotations of the previous tab immediately on tab switch", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const invokeSpy = vi
        .mocked(invoke)
        .mockImplementation(
          mockInvokeWithLoad(() =>
            Promise.resolve({ annotations: [], sessionIds: [] })
          )
        );

      let hookRef: UsePersistenceReturn;
      const { rerender } = render(
        <ConfigurableHarness
          props={propsFor(tabA)}
          onHook={(hook) => {
            hookRef = hook;
          }}
        />
      );

      // 等加载完成（hash-a 被标记为已加载）
      await act(async () => {});

      act(() => {
        hookRef!.handleAddComment(selection, "note");
      });

      // 立即切 tab（<500ms 防抖窗口内，不推进任何计时器）
      rerender(
        <ConfigurableHarness
          props={propsFor(tabB)}
          onHook={(hook) => {
            hookRef = hook;
          }}
        />
      );
      // 只让 flush 的微任务落地；500ms 防抖定时器确定未触发
      await act(async () => {});

      const saveCalls = invokeSpy.mock.calls.filter(
        ([cmd, args]) =>
          cmd === "save_pdf_data" &&
          (args as { filePath?: string } | undefined)?.filePath === "/a.pdf"
      );
      expect(saveCalls).toHaveLength(1);
      const savedData = (
        saveCalls[0][1] as { data: { annotations: { text: string }[] } }
      ).data;
      expect(savedData.annotations.some((a) => a.text === "note")).toBe(true);
    });

    it("flushPendingSaves persists dirty annotations and changed sessions immediately", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const invokeSpy = vi
        .mocked(invoke)
        .mockImplementation(
          mockInvokeWithLoad(() =>
            Promise.resolve({ annotations: [], sessionIds: [] })
          )
        );

      let hookRef: UsePersistenceReturn;
      render(
        <ConfigurableHarness
          props={propsFor(tabA)}
          onHook={(hook) => {
            hookRef = hook;
          }}
        />
      );
      await act(async () => {});

      const session: InterpretationSession = {
        id: "session-1",
        sources: [
          {
            id: "stash-1",
            source: {
              tabId: "tab-a",
              fileName: "a.pdf",
              filePath: "/a.pdf",
              fileHash: "hash-a",
              page: 1,
              pdfX: 0,
              pdfY: 0,
            },
            text: "stash text",
            createdAt: 1,
          },
        ],
        messages: [{ id: "msg-1", role: "user", content: "hi", createdAt: 1 }],
        isStreaming: false,
        createdAt: 1,
        updatedAt: 1,
      };

      act(() => {
        hookRef!.handleAddComment(selection, "note");
        hookRef!.setSessions([session]);
      });

      // 不推进 500ms 防抖，直接 flush（模拟退出前落盘）
      await act(async () => {
        await hookRef!.flushPendingSaves();
      });

      const pdfSaves = invokeSpy.mock.calls.filter(
        ([cmd, args]) =>
          cmd === "save_pdf_data" &&
          (args as { filePath?: string } | undefined)?.filePath === "/a.pdf"
      );
      expect(pdfSaves.length).toBeGreaterThan(0);
      const sessionSaves = invokeSpy.mock.calls.filter(
        ([cmd, args]) =>
          cmd === "save_session" &&
          (args as { session?: { id?: string } } | undefined)?.session?.id ===
            "session-1"
      );
      expect(sessionSaves.length).toBeGreaterThan(0);

      // flush 后脏标记已清、防抖定时器已取消，推进计时器不应重复保存
      invokeSpy.mockClear();
      await act(async () => {
        vi.runAllTimers();
      });
      expect(
        invokeSpy.mock.calls.filter(([cmd]) => cmd === "save_pdf_data")
      ).toHaveLength(0);
      expect(
        invokeSpy.mock.calls.filter(([cmd]) => cmd === "save_session")
      ).toHaveLength(0);
    });
  });

  describe("agent loop", () => {
    beforeEach(() => {
      toolMocks.executeToolCall.mockReset();
      toolMocks.dispose.mockReset();
      toolMocks.beginToolSession.mockClear();
      toolMocks.executeToolCall.mockResolvedValue({
        summary: "搜索 clause",
        result: "PDF search result",
      });
    });

    it("executes tool call and continues to a final answer", async () => {
      const { streamChatCompletion } = await import("../services/llm");
      let round = 0;
      vi.mocked(streamChatCompletion).mockImplementation(async function* () {
        if (round++ === 0) {
          yield* toolCallRoundEvents("call-1");
        } else {
          yield* finalAnswerEvents();
        }
      });

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

      act(() => {
        hookRef!.setSessions([makeExplainSession()]);
      });

      act(() => {
        hookRef!.handleFollowUp("session-explain", "follow up prompt");
      });

      await waitFor(() => {
        const session = hookRef!.sessions.find(
          (s) => s.id === "session-explain"
        );
        expect(session?.isStreaming).toBe(false);
      });

      const session = hookRef!.sessions.find(
        (s) => s.id === "session-explain"
      )!;
      expect(session.messages.some((m) => m.role === "tool")).toBe(true);
      const toolMsg = session.messages.find((m) => m.role === "tool")!;
      expect(toolMsg.toolCallId).toBe("call-1");
      expect(toolMsg.content).toBe("PDF search result");

      const assistantToolMsg = session.messages.find(
        (m) => m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0
      )!;
      expect(assistantToolMsg.toolCalls?.[0].function.name).toBe(
        "search_in_pdf"
      );
      expect(assistantToolMsg.toolEvents).toEqual([
        { name: "search_in_pdf", summary: "搜索 “clause”", status: "done" },
      ]);

      const finalAssistant = session.messages.find(
        (m) =>
          m.role === "assistant" && m.content === "Final answer based on PDF."
      );
      expect(finalAssistant).toBeDefined();

      expect(toolMocks.executeToolCall).toHaveBeenCalledTimes(1);
      expect(toolMocks.dispose).toHaveBeenCalledTimes(1);
    });

    it("replays persisted tool messages on follow-up", async () => {
      const { streamChatCompletion } = await import("../services/llm");
      const calls: { messages: unknown[]; options: unknown }[] = [];
      vi.mocked(streamChatCompletion).mockImplementation(
        async function* (messages, options) {
          calls.push({ messages: messages as unknown[], options });
          yield { type: "chunk" as const, content: "answer" };
          yield { type: "done" as const };
        }
      );

      const priorToolAssistant: InterpretationMessage = {
        id: "msg-tool-assistant",
        role: "assistant",
        content: "",
        createdAt: 1000,
        toolCalls: [
          {
            id: "call-prior",
            type: "function",
            function: {
              name: "search_in_pdf",
              arguments: JSON.stringify({ file_hash: "hash-a", query: "x" }),
            },
          },
        ],
        reasoningContent: "reasoning",
      };
      const priorToolResult: InterpretationMessage = {
        id: "msg-tool-result",
        role: "tool",
        content: "prior result",
        createdAt: 1001,
        toolCallId: "call-prior",
        name: "search_in_pdf",
      };

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

      act(() => {
        hookRef!.setSessions([
          makeExplainSession([priorToolAssistant, priorToolResult]),
        ]);
      });

      act(() => {
        hookRef!.handleFollowUp("session-explain", "继续追问");
      });

      await waitFor(() => {
        expect(calls.length).toBeGreaterThan(0);
      });

      const firstCallMessages = calls[0].messages as Array<{
        role: string;
        content?: string;
        toolCalls?: unknown[];
        toolCallId?: string;
        reasoningContent?: string;
      }>;
      const toolAssistantInApi = firstCallMessages.find(
        (m) => m.role === "assistant" && m.toolCalls
      );
      expect(toolAssistantInApi).toBeDefined();
      expect(toolAssistantInApi!.toolCalls).toEqual(
        priorToolAssistant.toolCalls
      );
      expect(toolAssistantInApi!.reasoningContent).toBe("reasoning");

      const toolResultInApi = firstCallMessages.find((m) => m.role === "tool");
      expect(toolResultInApi).toBeDefined();
      expect(toolResultInApi!.toolCallId).toBe("call-prior");
    });

    it("deduplicates identical tool calls within a response", async () => {
      const { streamChatCompletion } = await import("../services/llm");
      let round = 0;
      vi.mocked(streamChatCompletion).mockImplementation(async function* () {
        if (round++ === 0) {
          yield {
            type: "toolCall" as const,
            name: "search_in_pdf",
            args: JSON.stringify({ file_hash: "hash-a", query: "clause" }),
            callId: "call-a",
          };
          yield {
            type: "toolCall" as const,
            name: "search_in_pdf",
            args: JSON.stringify({ file_hash: "hash-a", query: "clause" }),
            callId: "call-b",
          };
          yield { type: "done" as const };
        } else {
          yield { type: "chunk" as const, content: "Final" };
          yield { type: "done" as const };
        }
      });

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

      act(() => {
        hookRef!.setSessions([makeExplainSession()]);
      });

      act(() => {
        hookRef!.handleFollowUp("session-explain", "追问");
      });

      await waitFor(() => {
        const session = hookRef!.sessions.find(
          (s) => s.id === "session-explain"
        );
        expect(session?.isStreaming).toBe(false);
      });

      // The tool executor should be invoked once even though two calls were emitted.
      expect(toolMocks.executeToolCall).toHaveBeenCalledTimes(1);

      const session = hookRef!.sessions.find(
        (s) => s.id === "session-explain"
      )!;
      const toolResults = session.messages.filter((m) => m.role === "tool");
      expect(toolResults).toHaveLength(2);
      expect(toolResults[0].content).toBe("PDF search result");
      expect(toolResults[1].content).toBe("PDF search result");
    });

    it("forces a final no-tools round when maxRounds is reached", async () => {
      const { streamChatCompletion } = await import("../services/llm");
      const requests: {
        messages: unknown[];
        options: { enableTools?: boolean };
      }[] = [];
      vi.mocked(streamChatCompletion).mockImplementation(
        async function* (messages, options) {
          requests.push({
            messages,
            options: { enableTools: options?.enableTools },
          });
          yield {
            type: "toolCall" as const,
            name: "search_in_pdf",
            args: JSON.stringify({ file_hash: "hash-a", query: "clause" }),
            callId: `call-${requests.length}`,
          };
          yield { type: "done" as const };
        }
      );

      let hookRef: UsePersistenceReturn;
      render(
        <StrictMode>
          <ConfigurableHarness
            props={{
              activeTab: null,
              activeTabId: null,
              secondaryTab: null,
              isSplitView: false,
              focusedTab: null,
              openRightPanel: vi.fn(),
              settings: { ...DEFAULT_SETTINGS, maxToolRounds: 1 },
            }}
            onHook={(hook) => {
              hookRef = hook;
            }}
          />
        </StrictMode>
      );

      act(() => {
        hookRef!.setSessions([makeExplainSession()]);
      });

      act(() => {
        hookRef!.handleFollowUp("session-explain", "追问");
      });

      await waitFor(() => {
        const session = hookRef!.sessions.find(
          (s) => s.id === "session-explain"
        );
        expect(session?.isStreaming).toBe(false);
      });

      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect(requests[0].options.enableTools).toBe(true);
      expect(requests[1].options.enableTools).toBe(false);
      expect(requests[1].messages).toEqual(
        expect.not.arrayContaining([
          expect.objectContaining({ role: "tool" }),
          expect.objectContaining({ toolCalls: expect.anything() }),
        ])
      );
      expect(JSON.stringify(requests[1].messages)).toContain(
        "文档查阅工具调用已达到本次上限"
      );

      const session = hookRef!.sessions.find(
        (s) => s.id === "session-explain"
      )!;
      const finalMessage = session.messages[session.messages.length - 1];
      expect(finalMessage.content).toContain("已达到本次文档查阅工具调用上限");
      expect(finalMessage.toolEvents).toBeUndefined();
      expect(toolMocks.dispose).toHaveBeenCalledTimes(1);
    });

    it("disables tools when agentToolsEnabled is false", async () => {
      const { streamChatCompletion } = await import("../services/llm");
      const optionsList: { enableTools?: boolean }[] = [];
      vi.mocked(streamChatCompletion).mockImplementation(
        async function* (_messages, options) {
          optionsList.push({ enableTools: options?.enableTools });
          yield { type: "chunk" as const, content: "answer" };
          yield { type: "done" as const };
        }
      );

      let hookRef: UsePersistenceReturn;
      render(
        <StrictMode>
          <ConfigurableHarness
            props={{
              activeTab: null,
              activeTabId: null,
              secondaryTab: null,
              isSplitView: false,
              focusedTab: null,
              openRightPanel: vi.fn(),
              settings: { ...DEFAULT_SETTINGS, agentToolsEnabled: false },
            }}
            onHook={(hook) => {
              hookRef = hook;
            }}
          />
        </StrictMode>
      );

      act(() => {
        hookRef!.setSessions([makeExplainSession()]);
      });

      act(() => {
        hookRef!.handleFollowUp("session-explain", "追问");
      });

      await waitFor(() => {
        expect(optionsList.length).toBeGreaterThan(0);
      });

      expect(optionsList[0].enableTools).toBe(false);
      expect(toolMocks.beginToolSession).not.toHaveBeenCalled();
    });

    it("disposes the tool session when the stream errors", async () => {
      const { streamChatCompletion } = await import("../services/llm");
      vi.mocked(streamChatCompletion).mockImplementation(async function* () {
        yield {
          type: "error" as const,
          message: "boom",
          error: { kind: "unknown" as const, status: 500, body: "boom" },
        };
      });

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

      act(() => {
        hookRef!.setSessions([makeExplainSession()]);
      });

      act(() => {
        hookRef!.handleFollowUp("session-explain", "追问");
      });

      await waitFor(() => {
        expect(toolMocks.dispose).toHaveBeenCalledTimes(1);
      });
    });

    it("disposes the tool session when the stream is aborted", async () => {
      const { streamChatCompletion } = await import("../services/llm");
      let capturedSignal: AbortSignal | undefined;

      vi.mocked(streamChatCompletion).mockImplementation(
        async function* (_messages, options) {
          capturedSignal = options?.signal;
          yield {
            type: "toolCall" as const,
            name: "search_in_pdf",
            args: JSON.stringify({ file_hash: "hash-a", query: "clause" }),
            callId: "call-1",
          };
          await new Promise((resolve) => setTimeout(resolve, 50));
          yield { type: "done" as const };
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

      act(() => {
        hookRef!.setSessions([makeExplainSession()]);
      });

      act(() => {
        hookRef!.handleFollowUp("session-explain", "追问");
      });

      await waitFor(() => {
        expect(capturedSignal).toBeDefined();
      });

      act(() => {
        hookRef!.handleInterruptSession("session-explain");
      });

      await waitFor(() => {
        expect(toolMocks.dispose).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("流式合批", () => {
    // 返回值引用稳定：状态未变化时 re-render 必须复用同一对象，
    // 否则 App 层依赖 persistence 的回调会每次渲染重建。
    it("返回对象引用在无关 re-render 间保持稳定", () => {
      const props: UsePersistenceProps = {
        activeTab: null,
        activeTabId: null,
        secondaryTab: null,
        isSplitView: false,
        focusedTab: null,
        openRightPanel: vi.fn(),
        settings: DEFAULT_SETTINGS,
      };
      const refs: UsePersistenceReturn[] = [];
      const { rerender } = render(
        <ConfigurableHarness props={props} onHook={(hook) => refs.push(hook)} />
      );
      rerender(
        <ConfigurableHarness props={props} onHook={(hook) => refs.push(hook)} />
      );

      expect(refs.length).toBeGreaterThan(1);
      const last = refs[refs.length - 1];
      for (const ref of refs) {
        expect(ref).toBe(last);
      }
    });

    it("快速到达的多个 chunk 只触发有限次渲染，且 flush 后内容完整", async () => {
      const { streamChatCompletion } = await import("../services/llm");
      const chunks = Array.from({ length: 30 }, (_, i) => `chunk-${i} `);
      vi.mocked(streamChatCompletion).mockImplementation(async function* () {
        for (const chunk of chunks) {
          yield { type: "chunk" as const, content: chunk };
        }
        yield { type: "done" as const };
      });

      let hookRef: UsePersistenceReturn;
      let renderCount = 0;
      render(
        <TestHarness
          onHook={(hook) => {
            hookRef = hook;
            renderCount += 1;
          }}
        />
      );

      act(() => {
        hookRef!.setSessions([makeExplainSession()]);
      });

      const rendersBeforeStream = renderCount;

      act(() => {
        hookRef!.handleFollowUp("session-explain", "追问");
      });

      await waitFor(() => {
        const session = hookRef!.sessions.find(
          (s) => s.id === "session-explain"
        );
        expect(session?.isStreaming).toBe(false);
      });

      // 逐 chunk setSessions 时 30 个 chunk 至少触发 30 次渲染；
      // 合批后流期间的渲染次数应远小于 chunk 数。
      expect(renderCount - rendersBeforeStream).toBeLessThan(chunks.length);

      const assistantMessage = hookRef!.sessions
        .find((s) => s.id === "session-explain")!
        .messages.find((m) => m.role === "assistant");
      expect(assistantMessage?.content).toBe(chunks.join(""));
    });

    it("流未结束时按定时器 flush 已累积内容", async () => {
      const { streamChatCompletion } = await import("../services/llm");
      let releaseStream: () => void = () => {};
      vi.mocked(streamChatCompletion).mockImplementation(async function* () {
        yield { type: "chunk" as const, content: "partial" };
        // 流挂起：验证 50ms flush 定时器在流未结束时也会落状态。
        await new Promise<void>((resolve) => {
          releaseStream = resolve;
        });
        yield { type: "done" as const };
      });

      let hookRef: UsePersistenceReturn;
      render(
        <TestHarness
          onHook={(hook) => {
            hookRef = hook;
          }}
        />
      );

      act(() => {
        hookRef!.setSessions([makeExplainSession()]);
      });

      act(() => {
        hookRef!.handleFollowUp("session-explain", "追问");
      });

      // fake timers 开启 shouldAdvanceTime，50ms flush 定时器会随真实时间触发；
      // 流仍挂起时内容已落状态。
      await waitFor(() => {
        const session = hookRef!.sessions.find(
          (s) => s.id === "session-explain"
        );
        const assistantMessage = session?.messages.find(
          (m) => m.role === "assistant"
        );
        expect(assistantMessage?.content).toBe("partial");
      });
      expect(
        hookRef!.sessions.find((s) => s.id === "session-explain")?.isStreaming
      ).toBe(true);

      // 放行流结束，收尾正常。
      await act(async () => {
        releaseStream();
      });
      await waitFor(() => {
        const session = hookRef!.sessions.find(
          (s) => s.id === "session-explain"
        );
        expect(session?.isStreaming).toBe(false);
      });
    });
  });
});
