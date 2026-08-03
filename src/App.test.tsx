import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import React from "react";
import App from "./App";
import { open, confirm } from "@tauri-apps/plugin-dialog";
import { DEFAULT_SETTINGS } from "./services/settings";
import { DictionaryStatusProvider } from "./hooks/useDictionaryStatus";

function renderApp() {
  return render(
    <DictionaryStatusProvider>
      <App />
    </DictionaryStatusProvider>
  );
}

const mockInvoke = vi.hoisted(() => vi.fn());
const mockListen = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mockListen,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  confirm: vi.fn(),
  message: vi.fn(),
}));

// Mock the Tauri window API: capture the onCloseRequested handler so tests can
// simulate window close, and stub the controls TitleBar touches on mount.
const mockWindow = vi.hoisted(() => ({
  closeHandler: null as
    null | ((event: { preventDefault: () => void }) => void),
  destroy: vi.fn(() => Promise.resolve()),
  minimize: vi.fn(() => Promise.resolve()),
  unmaximize: vi.fn(() => Promise.resolve()),
  toggleMaximize: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
  isMaximized: () => Promise.resolve(false),
  onResized: () => Promise.resolve(() => {}),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    ...mockWindow,
    onCloseRequested: (cb: (event: { preventDefault: () => void }) => void) => {
      mockWindow.closeHandler = cb;
      return Promise.resolve(() => {});
    },
  }),
}));

vi.mock("./services/llm", async () => {
  const actual =
    await vi.importActual<typeof import("./services/llm")>("./services/llm");
  return {
    ...actual,
    streamChatCompletion: vi.fn().mockImplementation(async function* () {
      yield { type: "chunk", content: "回答" };
    }),
  };
});

const lastAnnotations = vi.fn();
const lastInitialState = vi.fn();

vi.mock("./components/PdfViewer", () => ({
  default: React.forwardRef(
    (
      {
        tabId,
        filePath,
        onSelection,
        onToggleVisibility,
        onStateChange,
        initialState,
        annotations,
        onAnnotationDelete,
      }: {
        tabId?: string;
        filePath?: string;
        onSelection?: (
          tabId: string,
          text: string,
          page: number,
          position: { x: number; y: number; pdfX: number; pdfY: number }
        ) => void;
        onToggleVisibility?: () => void;
        onStateChange?: (state: { pageNum?: number }) => void;
        initialState?: { pageNum?: number };
        annotations?: {
          id?: string;
          type: string;
          stashId?: string;
          interpretedGroupSize?: number;
        }[];
        onAnnotationDelete?: (id: string) => void;
      },
      ref: React.Ref<HTMLDivElement>
    ) => {
      lastAnnotations.mockImplementation(() => annotations ?? []);
      lastInitialState(initialState);
      return (
        <div data-testid="pdf-viewer" data-filepath={filePath} ref={ref}>
          PdfViewer
          <button
            data-testid="trigger-selection"
            onClick={() => {
              if (!tabId) return;
              onSelection?.(tabId, "selected text", 3, {
                x: 100,
                y: 200,
                pdfX: 50,
                pdfY: 60,
              });
            }}
          >
            Select
          </button>
          <button
            data-testid="trigger-state-change"
            onClick={() => onStateChange?.({ pageNum: 5 })}
          >
            State
          </button>
          {annotations?.map((a) => {
            const isExplain =
              a.type === "explain" ||
              typeof a.interpretedGroupSize === "number";
            return (
              <div key={a.id ?? `${a.type}-${a.stashId}`}>
                <button
                  aria-label={
                    a.type === "translate"
                      ? "翻译"
                      : a.type === "explain"
                        ? "解读"
                        : "已解读暂存"
                  }
                  data-testid={`annotation-${a.type}-${a.id ?? a.stashId}`}
                  onClick={() => {}}
                >
                  {a.type}
                </button>
                <button
                  aria-label={isExplain ? "删除解读" : "删除标记"}
                  data-testid={`delete-annotation-${a.id ?? a.stashId}`}
                  onClick={() => {
                    if (a.id && onAnnotationDelete) onAnnotationDelete(a.id);
                  }}
                >
                  {isExplain ? "删除解读" : "删除标记"}
                </button>
              </div>
            );
          })}
          {onToggleVisibility && (
            <button title="隐藏 PDF 面板" onClick={onToggleVisibility}>
              隐藏
            </button>
          )}
        </div>
      );
    }
  ),
}));

function triggerPdfSelection() {
  // keep-alive 下非激活 tab 的 viewer 常驻 DOM（外层 wrapper 带
  // .viewer-hidden），只对激活 viewer 触发选区。
  const btn = document.querySelector(
    ".pdf-panel:not(.viewer-hidden) [data-testid='trigger-selection']"
  ) as HTMLElement;
  fireEvent.click(btn);
}

async function openPdf(path = "/test/file.pdf") {
  (open as ReturnType<typeof vi.fn>).mockResolvedValue(path);
  fireEvent.click(screen.getByTestId("open-pdf-btn"));
  await waitFor(() => {
    expect(screen.getByText(path.split("/").pop()!)).toBeInTheDocument();
  });
}

// jsdom 无布局，mock 阅读区 rect 供 tab 拖拽的指针命中检测使用。
function mockMainAreaRect(main: HTMLElement, width = 800, height = 600) {
  main.getBoundingClientRect = vi.fn(
    () =>
      ({
        left: 0,
        top: 0,
        right: width,
        bottom: height,
        width,
        height,
        x: 0,
        y: 0,
        toJSON: () => "",
      }) as DOMRect
  );
}

// 模拟 tab→分屏的鼠标拖拽：mousedown 起步 → mousemove 越过阈值进入拖拽态
// → mouseup 释放在阅读区 rect 内（新实现为鼠标拖拽，HTML5 DnD 已拆除）。
function dragTabIntoMainArea(tab: HTMLElement) {
  const main = document.querySelector("main") as HTMLElement;
  mockMainAreaRect(main);
  fireEvent.mouseDown(tab, { button: 0, clientX: 100, clientY: 10 });
  fireEvent.mouseMove(window, { clientX: 400, clientY: 300 });
  fireEvent.mouseUp(window, { clientX: 400, clientY: 300 });
}

// keep-alive 下非激活 tab 的 viewer 常驻 DOM（外层带 .viewer-hidden），
// 统计「可见」viewer 数。
function splitViewVisibleViewerCount() {
  return document.querySelectorAll(
    ".pdf-panel:not(.viewer-hidden) [data-testid='pdf-viewer']"
  ).length;
}

function setupMockInvoke(
  overrides: Record<string, (args?: Record<string, any>) => unknown> = {}
) {
  mockInvoke.mockImplementation(
    (command: string, args?: Record<string, any>) => {
      if (overrides[command]) {
        return Promise.resolve(overrides[command](args));
      }
      switch (command) {
        case "load_pdf_data":
          return Promise.resolve({ annotations: [], sessionIds: [] });
        case "get_pdf_hash":
          return Promise.resolve(`hash-${args?.filePath}`);
        case "get_pdf_file_size":
          return Promise.resolve(1024 * 1024);
        case "load_session":
          return Promise.resolve(null);
        case "load_settings":
          return Promise.resolve({ ...DEFAULT_SETTINGS });
        case "load_recent_files":
          return Promise.resolve([]);
        case "check_dictionary":
          return Promise.resolve({ exists: false, path: "" });
        case "take_pending_open_pdfs":
          return Promise.resolve([]);
        case "check_files_exist":
          return Promise.resolve(
            ((args?.paths as string[]) ?? []).map(() => true)
          );
        case "download_dictionary":
        case "authorize_pdf_path":
          return Promise.resolve(undefined);
        case "save_session":
        case "save_pdf_data":
        case "delete_session":
        case "save_settings":
        case "save_recent_files":
          return Promise.resolve(undefined);
        default:
          return Promise.reject(
            new Error(`No mock handler for command: ${command}`)
          );
      }
    }
  );
  mockListen.mockResolvedValue(() => {});
}

describe("App", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    vi.clearAllMocks();
    localStorage.clear();
    setupMockInvoke();
  });

  it("renders header and open button", () => {
    renderApp();
    expect(screen.getByLabelText("最近打开的文件")).toBeInTheDocument();
    expect(screen.getByTestId("open-pdf-btn")).toBeInTheDocument();
  });

  it("opens a PDF via Ctrl/Cmd+O", async () => {
    renderApp();
    (open as ReturnType<typeof vi.fn>).mockResolvedValue("/test/file.pdf");
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    await waitFor(() => {
      expect(screen.getByText("file.pdf")).toBeInTheDocument();
    });
  });

  it("does not open the file dialog on Ctrl+Shift+O (recent files panel)", async () => {
    renderApp();
    fireEvent.keyDown(window, { key: "O", ctrlKey: true, shiftKey: true });
    // Ctrl+Shift+O 是最近文件面板的快捷键，不应触发文件对话框
    expect(open).not.toHaveBeenCalled();
  });

  it("opens a recent file from the panel and restores its last page", async () => {
    setupMockInvoke({
      load_recent_files: () => [
        {
          path: "/recent/old.pdf",
          fileName: "old.pdf",
          openedAt: 1,
          lastPage: 7,
        },
      ],
    });
    renderApp();

    fireEvent.click(screen.getByTestId("recent-files-trigger"));
    fireEvent.click(await screen.findByText("old.pdf"));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /关闭 old\.pdf/i })
      ).toBeInTheDocument();
    });
    expect(lastInitialState).toHaveBeenCalledWith(
      expect.objectContaining({ pageNum: 7 })
    );
  });

  it("writes the last read page back to recent files when a tab closes", async () => {
    renderApp();
    await openPdf("/test/file.pdf");

    fireEvent.click(screen.getByTestId("trigger-state-change"));
    fireEvent.click(screen.getByRole("button", { name: /关闭 file\.pdf/i }));

    await waitFor(() => {
      const saves = mockInvoke.mock.calls.filter(
        ([cmd]) => cmd === "save_recent_files"
      );
      expect(saves.length).toBeGreaterThan(0);
      expect(saves[saves.length - 1]?.[1]?.files?.[0]).toMatchObject({
        path: "/test/file.pdf",
        lastPage: 5,
      });
    });
  });

  it("flushes pending annotations and last page on window close", async () => {
    renderApp();
    await openPdf("/test/file.pdf");

    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: "批注" }));
    fireEvent.click(screen.getByTestId("trigger-state-change")); // pageNum → 5

    // 不等 500ms 防抖，直接触发关窗：退出前必须把脏数据落盘
    expect(mockWindow.closeHandler).toBeTruthy();
    const preventDefault = vi.fn();
    await act(async () => {
      mockWindow.closeHandler!({ preventDefault });
    });

    expect(preventDefault).toHaveBeenCalled();

    await waitFor(() => {
      const pdfSaves = mockInvoke.mock.calls.filter(
        ([cmd, args]) =>
          cmd === "save_pdf_data" &&
          (args as { filePath?: string })?.filePath === "/test/file.pdf"
      );
      expect(pdfSaves.length).toBeGreaterThan(0);
    });

    // 退出时把当前打开 tab 的页码回写到最近文件
    await waitFor(() => {
      const saves = mockInvoke.mock.calls.filter(
        ([cmd]) => cmd === "save_recent_files"
      );
      expect(saves[saves.length - 1]?.[1]?.files?.[0]).toMatchObject({
        path: "/test/file.pdf",
        lastPage: 5,
      });
    });

    // flush 完成后才销毁窗口
    await waitFor(() => {
      expect(mockWindow.destroy).toHaveBeenCalled();
    });
  });

  it("pins a recent file from the panel and persists it", async () => {
    setupMockInvoke({
      load_recent_files: () => [
        { path: "/recent/a.pdf", fileName: "a.pdf", openedAt: 1 },
      ],
    });
    renderApp();

    fireEvent.click(screen.getByTestId("recent-files-trigger"));
    fireEvent.click(await screen.findByLabelText("固定到顶部"));

    await waitFor(() => {
      const saves = mockInvoke.mock.calls.filter(
        ([cmd]) => cmd === "save_recent_files"
      );
      expect(saves.length).toBeGreaterThan(0);
      expect(saves[saves.length - 1]?.[1]?.files?.[0]).toMatchObject({
        path: "/recent/a.pdf",
        pinned: true,
      });
    });
  });

  it("toggles left and right panels", () => {
    renderApp();

    const hidePdfBtn = screen.getByTitle(/隐藏 PDF/i);
    fireEvent.click(hidePdfBtn);
    expect(screen.queryByTestId("pdf-viewer")).not.toBeInTheDocument();

    const showPdfBtn = screen.getByTitle(/显示 PDF/i);
    fireEvent.click(showPdfBtn);
    expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument();

    const hideAiBtn = screen.getByTitle(/隐藏面板/i);
    fireEvent.click(hideAiBtn);
    expect(screen.queryByText(/AI 助手/i)).not.toBeInTheDocument();

    const showAiBtn = screen.getByTitle(/显示 AI 助手/i);
    fireEvent.click(showAiBtn);
    expect(screen.getByText(/AI 助手/i)).toBeInTheDocument();
  });

  it("adds selection to stash and shows stash tab", async () => {
    renderApp();

    await openPdf();
    triggerPdfSelection();

    fireEvent.click(screen.getByRole("button", { name: /加入暂存/i }));

    expect(
      screen.getByRole("tab", { name: /暂存区 \(1\)/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/selected text/i)).toBeInTheDocument();
  });

  it("creates a session and clears stash after custom interpretation", async () => {
    renderApp();

    await openPdf();
    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: /加入暂存/i }));

    fireEvent.click(screen.getByRole("button", { name: /自定义解读/i }));
    fireEvent.change(screen.getByPlaceholderText(/输入你的解读要求/), {
      target: { value: "请分析" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /解读记录 \(1\)/i })
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole("tab", { name: /暂存区 \(0\)/i })
    ).toBeInTheDocument();
  });

  it("custom interpretation prompt includes stash content", async () => {
    const { streamChatCompletion } = await import("./services/llm");
    renderApp();

    await openPdf();
    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: /加入暂存/i }));

    fireEvent.click(screen.getByRole("button", { name: /自定义解读/i }));
    fireEvent.change(screen.getByPlaceholderText(/输入你的解读要求/), {
      target: { value: "请分析关系" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/i }));

    await waitFor(() => {
      expect(streamChatCompletion).toHaveBeenCalled();
    });

    const [messages] = (streamChatCompletion as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const userMessage = messages.find(
      (m: { role: string; content: string }) => m.role === "user"
    );
    expect(userMessage.content).toContain("请分析关系");
    expect(userMessage.content).toContain("selected text");

    // Interpreted stash annotation should persist on the page.
    await waitFor(() => {
      const annotations = lastAnnotations();
      expect(annotations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "stash",
            interpretedGroupSize: 1,
            interpretedIndex: 0,
          }),
        ])
      );
    });
  });

  it("creates a session immediately for explain action", async () => {
    renderApp();

    await openPdf();
    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: "解读" }));

    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /解读记录 \(1\)/i })
      ).toBeInTheDocument();
    });
  });

  it("saves explain session reference to PDF data", async () => {
    renderApp();

    await openPdf("/test/file.pdf");
    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: "解读" }));

    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /解读记录 \(1\)/i })
      ).toBeInTheDocument();
    });

    const annotation = lastAnnotations().find(
      (a: { type: string }) => a.type === "explain"
    );
    expect(annotation).toBeDefined();
    const sessionId = (annotation as any).sessionId;
    expect(sessionId).toBeDefined();

    await waitFor(() => {
      const savePdfCalls = mockInvoke.mock.calls.filter(
        (call) => call[0] === "save_pdf_data"
      );
      expect(savePdfCalls.length).toBeGreaterThan(0);
      expect(
        savePdfCalls.some((call) =>
          (call[1] as any).data.sessionIds.includes(sessionId)
        )
      ).toBe(true);
    });
  });

  it("removes a stash and its highlight when deleting", async () => {
    renderApp();

    await openPdf();
    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: /加入暂存/i }));

    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    expect(
      screen.getByRole("tab", { name: /暂存区 \(0\)/i })
    ).toBeInTheDocument();
  });

  it("clears all stashes when clearing", async () => {
    renderApp();

    await openPdf();
    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: /加入暂存/i }));
    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: /加入暂存/i }));

    fireEvent.click(screen.getByRole("button", { name: /清空暂存/i }));

    expect(
      screen.getByRole("tab", { name: /暂存区 \(0\)/i })
    ).toBeInTheDocument();
  });

  it("hides stashes and sessions when their tab is closed", async () => {
    renderApp();

    await openPdf();
    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: /加入暂存/i }));

    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: "解读" }));

    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /暂存区 \(1\)/i })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("tab", { name: /解读记录 \(1\)/i })
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle(/关闭标签页/i));

    expect(screen.queryByText(/selected text/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /暂存区 \(0\)/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /解读记录 \(0\)/i })
    ).toBeInTheDocument();
  });

  it("filters stashes and sessions by the active tab", async () => {
    (open as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("/test/file-a.pdf")
      .mockResolvedValueOnce("/test/file-b.pdf");

    renderApp();

    fireEvent.click(screen.getByTestId("open-pdf-btn"));
    await waitFor(() => {
      expect(screen.getByText("file-a.pdf")).toBeInTheDocument();
    });
    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: /加入暂存/i }));

    fireEvent.click(screen.getByTestId("open-pdf-btn"));
    await waitFor(() => {
      expect(screen.getByText("file-b.pdf")).toBeInTheDocument();
    });

    expect(screen.queryByText(/selected text/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /暂存区 \(0\)/i })
    ).toBeInTheDocument();

    const fileATab = screen
      .getAllByText("file-a.pdf")
      .find((el) => el.classList.contains("tab-name"))?.parentElement;
    expect(fileATab).toBeDefined();
    fireEvent.click(fileATab!);

    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /暂存区 \(1\)/i })
      ).toBeInTheDocument();
      expect(screen.getByText(/selected text/i)).toBeInTheDocument();
    });
  });

  it("loads previous sessions when reopening the same PDF", async () => {
    const existingSession = {
      id: "session-existing",
      sources: [
        {
          id: "stash-existing",
          source: {
            tabId: "tab-old",
            fileName: "file.pdf",
            filePath: "/test/file.pdf",
            fileHash: "hash-/test/file.pdf",
            page: 3,
            pdfX: 50,
            pdfY: 60,
          },
          text: "selected text",
          createdAt: 1000,
        },
      ],
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "请解读",
          createdAt: 1000,
        },
      ],
      isStreaming: false,
      createdAt: 1000,
      updatedAt: 1000,
    };

    mockInvoke.mockImplementation(
      (command: string, args?: Record<string, any>) => {
        if (
          command === "load_pdf_data" &&
          args?.filePath === "/test/file.pdf"
        ) {
          return Promise.resolve({
            annotations: [],
            sessionIds: ["session-existing"],
          });
        }
        if (
          command === "load_session" &&
          args?.sessionId === "session-existing"
        ) {
          return Promise.resolve(existingSession);
        }
        if (command === "get_pdf_hash") {
          return Promise.resolve(`hash-${args?.filePath}`);
        }
        if (command === "get_pdf_file_size") {
          return Promise.resolve(1024 * 1024);
        }
        if (command === "load_settings") {
          return Promise.resolve({ ...DEFAULT_SETTINGS });
        }
        if (command === "load_recent_files") {
          return Promise.resolve([]);
        }
        if (
          [
            "save_session",
            "save_pdf_data",
            "delete_session",
            "save_settings",
            "save_recent_files",
            "authorize_pdf_path",
          ].includes(command)
        ) {
          return Promise.resolve(undefined);
        }
        if (command === "check_dictionary") {
          return Promise.resolve({ exists: false, path: "" });
        }
        return Promise.reject(
          new Error(`No mock handler for command: ${command}`)
        );
      }
    );

    renderApp();

    await openPdf();

    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /解读记录 \(1\)/i })
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/selected text/i)).toBeInTheDocument();
  });

  it("still removes annotation when session cleanup fails", async () => {
    renderApp();

    await openPdf("/test/file.pdf");
    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: "解读" }));

    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /解读记录 \(1\)/i })
      ).toBeInTheDocument();
    });

    // Make subsequent loadPdfData reject to simulate backend failure
    mockInvoke.mockImplementation(
      (command: string, args?: Record<string, any>) => {
        if (command === "load_pdf_data") {
          return Promise.reject(new Error("disk error"));
        }
        if (command === "get_pdf_hash") {
          return Promise.resolve(`hash-${args?.filePath}`);
        }
        if (command === "load_settings") {
          return Promise.resolve({ ...DEFAULT_SETTINGS });
        }
        if (command === "load_recent_files") {
          return Promise.resolve([]);
        }
        if (
          [
            "save_session",
            "save_pdf_data",
            "delete_session",
            "load_session",
            "save_settings",
            "save_recent_files",
            "authorize_pdf_path",
          ].includes(command)
        ) {
          return Promise.resolve(undefined);
        }
        return Promise.reject(
          new Error(`No mock handler for command: ${command}`)
        );
      }
    );

    vi.mocked(confirm).mockResolvedValue(true);

    fireEvent.click(screen.getByRole("button", { name: "删除解读" }));

    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /解读记录 \(0\)/i })
      ).toBeInTheDocument();
    });
  });

  it("keeps other tabs' data when closing the active tab", async () => {
    (open as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("/test/file-a.pdf")
      .mockResolvedValueOnce("/test/file-b.pdf");

    renderApp();

    await openPdf("/test/file-a.pdf");
    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: /加入暂存/i }));

    await openPdf("/test/file-b.pdf");
    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: /加入暂存/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /暂存区 \(1\)/i })
      ).toBeInTheDocument();
    });

    // Close the active tab (file-b).
    fireEvent.click(screen.getByRole("button", { name: /关闭 file-b.pdf/i }));

    // The remaining active tab (file-a) should still have its stash.
    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /暂存区 \(1\)/i })
      ).toBeInTheDocument();
      expect(screen.getByText(/selected text/i)).toBeInTheDocument();
    });
  });

  it("enters split view when dragging an inactive tab into the main area", async () => {
    (open as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("/test/file-a.pdf")
      .mockResolvedValueOnce("/test/file-b.pdf");

    renderApp();

    await openPdf("/test/file-a.pdf");
    fireEvent.click(screen.getByTestId("open-pdf-btn"));
    await waitFor(() => {
      expect(screen.getByText("file-b.pdf")).toBeInTheDocument();
    });

    // Find the inactive tab (file-a) and drag it into the main area.
    const inactiveTab = screen.getByRole("button", { name: /关闭 file-a.pdf/i })
      .parentElement as HTMLElement;
    dragTabIntoMainArea(inactiveTab);

    await waitFor(() => {
      expect(screen.getAllByTestId("pdf-viewer")).toHaveLength(2);
    });

    // Exit split view and verify we are back to a single VISIBLE PDF panel
    // (keep-alive: the other tab's viewer stays mounted but hidden).
    fireEvent.click(screen.getByLabelText("退出并排视图"));
    await waitFor(() => {
      const visibleViewers = document.querySelectorAll(
        ".pdf-panel:not(.viewer-hidden) [data-testid='pdf-viewer']"
      );
      expect(visibleViewers).toHaveLength(1);
    });
  });

  it("shrinks right panel to 20% with min 200px when entering split view", async () => {
    (open as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("/test/file-a.pdf")
      .mockResolvedValueOnce("/test/file-b.pdf");

    renderApp();

    await openPdf("/test/file-a.pdf");
    fireEvent.click(screen.getByTestId("open-pdf-btn"));
    await waitFor(() => {
      expect(screen.getByText("file-b.pdf")).toBeInTheDocument();
    });

    const main = document.querySelector("main") as HTMLElement;
    const originalGetBoundingClientRect = main.getBoundingClientRect.bind(main);
    main.getBoundingClientRect = vi.fn(
      () =>
        ({
          width: 2000,
          height: 600,
          top: 0,
          left: 0,
          right: 2000,
          bottom: 600,
          x: 0,
          y: 0,
          toJSON: () => "",
        }) as DOMRect
    );
    window.dispatchEvent(new Event("resize"));

    const inactiveTab = screen.getByRole("button", { name: /关闭 file-a.pdf/i })
      .parentElement as HTMLElement;

    fireEvent.mouseDown(inactiveTab, { button: 0, clientX: 100, clientY: 10 });
    fireEvent.mouseMove(window, { clientX: 400, clientY: 300 });
    fireEvent.mouseUp(window, { clientX: 400, clientY: 300 });

    await waitFor(() => {
      expect(screen.getAllByTestId("pdf-viewer")).toHaveLength(2);
    });

    const rightPanel = document.querySelector(".right-panel") as HTMLElement;
    await waitFor(() => {
      // 宽度统一取整为整数像素（后端按 u32 持久化），百分比允许 1px 取整误差
      const pct = parseFloat(rightPanel.style.width);
      expect(Number.isNaN(pct)).toBe(false);
      expect(Math.abs(pct - 20)).toBeLessThan(0.1);
    });

    main.getBoundingClientRect = originalGetBoundingClientRect;
  });

  it("keeps the AI panel closed in split view after the user hides it", async () => {
    (open as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("/test/file-a.pdf")
      .mockResolvedValueOnce("/test/file-b.pdf");

    renderApp();

    await openPdf("/test/file-a.pdf");
    fireEvent.click(screen.getByTestId("open-pdf-btn"));
    await waitFor(() => {
      expect(screen.getByText("file-b.pdf")).toBeInTheDocument();
    });

    const inactiveTab = screen.getByRole("button", { name: /关闭 file-a.pdf/i })
      .parentElement as HTMLElement;
    dragTabIntoMainArea(inactiveTab);

    await waitFor(() => {
      expect(screen.getAllByTestId("pdf-viewer")).toHaveLength(2);
    });

    // AI panel is visible in split view; hide it.
    const hideButton = screen.getByLabelText("隐藏面板");
    fireEvent.click(hideButton);

    await waitFor(() => {
      expect(screen.getByLabelText("显示 AI 助手")).toBeInTheDocument();
    });

    // The auto-open effect must not reopen the panel after the user hid it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByLabelText("隐藏面板")).not.toBeInTheDocument();
    expect(screen.getByLabelText("显示 AI 助手")).toBeInTheDocument();
  });

  it("merges stashes from both viewers in split view and keeps them visible on focus switch", async () => {
    (open as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("/test/file-a.pdf")
      .mockResolvedValueOnce("/test/file-b.pdf");

    renderApp();

    await openPdf("/test/file-a.pdf");
    fireEvent.click(screen.getByTestId("open-pdf-btn"));
    await waitFor(() => {
      expect(screen.getByText("file-b.pdf")).toBeInTheDocument();
    });

    const inactiveTab = screen.getByRole("button", { name: /关闭 file-a.pdf/i })
      .parentElement as HTMLElement;
    dragTabIntoMainArea(inactiveTab);

    await waitFor(() => {
      expect(screen.getAllByTestId("pdf-viewer")).toHaveLength(2);
    });

    // Create a stash in the primary (active) viewer.
    fireEvent.click(screen.getAllByTestId("trigger-selection")[0]);
    fireEvent.click(screen.getByRole("button", { name: /加入暂存/i }));
    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /暂存区 \(1\)/i })
      ).toBeInTheDocument();
    });

    // Click the secondary panel; merged display keeps the primary stash visible.
    const panels = document.querySelectorAll(".pdf-panel");
    expect(panels).toHaveLength(2);
    fireEvent.click(panels[1]);
    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /暂存区 \(1\)/i })
      ).toBeInTheDocument();
    });

    // Select text in the secondary viewer and stash it too:
    // the selection toolbar follows the viewer where the selection was made.
    fireEvent.click(screen.getAllByTestId("trigger-selection")[1]);
    fireEvent.click(screen.getByRole("button", { name: /加入暂存/i }));
    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /暂存区 \(2\)/i })
      ).toBeInTheDocument();
    });

    // Both stashes are listed with their source file names.
    const stashSources = document.querySelectorAll(".stash-item-source");
    const sourceTexts = Array.from(stashSources).map((el) => el.textContent);
    expect(sourceTexts.some((s) => s?.includes("file-a.pdf"))).toBe(true);
    expect(sourceTexts.some((s) => s?.includes("file-b.pdf"))).toBe(true);
  });

  it("opens only one tab when the open-pdf event is emitted multiple times", async () => {
    const listeners = new Map<string, (event: { payload: string }) => void>();
    mockListen.mockImplementation(
      (event: string, cb: (event: { payload: string }) => void) => {
        listeners.set(event, cb);
        return Promise.resolve(() => {});
      }
    );

    renderApp();

    await waitFor(() => {
      expect(screen.getByTestId("open-pdf-btn")).toBeInTheDocument();
    });

    const handler = listeners.get("open-pdf");
    expect(handler).toBeDefined();

    act(() => {
      handler!({ payload: "/test/file.pdf" });
      handler!({ payload: "/test/file.pdf" });
    });

    await waitFor(() => {
      expect(screen.getByText("file.pdf")).toBeInTheDocument();
    });

    // Count tabs by their close buttons, ignoring the same filename in the recent-files bar.
    expect(
      screen.getAllByRole("button", { name: /关闭 file.pdf/i })
    ).toHaveLength(1);
  });

  it("opens PDFs buffered by the backend during a cold start", async () => {
    setupMockInvoke({
      take_pending_open_pdfs: () => ["/test/pending.pdf"],
    });

    renderApp();

    await waitFor(() => {
      expect(screen.getByText("pending.pdf")).toBeInTheDocument();
    });
    expect(
      screen.getAllByRole("button", { name: /关闭 pending.pdf/i })
    ).toHaveLength(1);
  });

  it("shows a drop-zone overlay while dragging a tab over the main area", async () => {
    (open as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("/test/file-a.pdf")
      .mockResolvedValueOnce("/test/file-b.pdf");

    renderApp();
    await openPdf("/test/file-a.pdf");
    fireEvent.click(screen.getByTestId("open-pdf-btn"));
    await waitFor(() => {
      expect(screen.getByText("file-b.pdf")).toBeInTheDocument();
    });

    const inactiveTab = screen.getByRole("button", { name: /关闭 file-a.pdf/i })
      .parentElement as HTMLElement;
    const main = document.querySelector("main") as HTMLElement;
    mockMainAreaRect(main);

    expect(screen.queryByText("松开以并排打开")).not.toBeInTheDocument();

    // 阈值内的微小移动视为单击准备阶段，不显示遮罩
    fireEvent.mouseDown(inactiveTab, { button: 0, clientX: 100, clientY: 10 });
    fireEvent.mouseMove(window, { clientX: 102, clientY: 12 });
    expect(screen.queryByText("松开以并排打开")).not.toBeInTheDocument();

    // 越过阈值并位于阅读区内：显示遮罩
    fireEvent.mouseMove(window, { clientX: 400, clientY: 300 });
    expect(screen.getByText("松开以并排打开")).toBeInTheDocument();

    // 移出阅读区：遮罩隐藏
    fireEvent.mouseMove(window, { clientX: 900, clientY: 300 });
    expect(screen.queryByText("松开以并排打开")).not.toBeInTheDocument();

    // 移回并释放：进入分屏，遮罩复位
    fireEvent.mouseMove(window, { clientX: 400, clientY: 300 });
    expect(screen.getByText("松开以并排打开")).toBeInTheDocument();
    fireEvent.mouseUp(window, { clientX: 400, clientY: 300 });
    expect(screen.queryByText("松开以并排打开")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByTestId("pdf-viewer")).toHaveLength(2);
    });
  });

  it("cancels the tab drag when released outside the main area", async () => {
    (open as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("/test/file-a.pdf")
      .mockResolvedValueOnce("/test/file-b.pdf");

    renderApp();
    await openPdf("/test/file-a.pdf");
    fireEvent.click(screen.getByTestId("open-pdf-btn"));
    await waitFor(() => {
      expect(screen.getByText("file-b.pdf")).toBeInTheDocument();
    });

    const inactiveTab = screen.getByRole("button", { name: /关闭 file-a.pdf/i })
      .parentElement as HTMLElement;
    const main = document.querySelector("main") as HTMLElement;
    mockMainAreaRect(main);

    // 拖拽越过阈值，但释放在阅读区外：取消，不进分屏
    fireEvent.mouseDown(inactiveTab, { button: 0, clientX: 100, clientY: 10 });
    fireEvent.mouseMove(window, { clientX: 900, clientY: 300 });
    fireEvent.mouseUp(window, { clientX: 900, clientY: 300 });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(splitViewVisibleViewerCount()).toBe(1);
    expect(screen.queryByLabelText("退出并排视图")).not.toBeInTheDocument();
  });

  it("keeps tab click activation working with the mouse-drag handler attached", async () => {
    (open as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("/test/file-a.pdf")
      .mockResolvedValueOnce("/test/file-b.pdf");

    renderApp();
    await openPdf("/test/file-a.pdf");
    fireEvent.click(screen.getByTestId("open-pdf-btn"));
    await waitFor(() => {
      expect(screen.getByText("file-b.pdf")).toBeInTheDocument();
    });

    const inactiveTab = screen.getByRole("button", { name: /关闭 file-a.pdf/i })
      .parentElement as HTMLElement;
    // 未越过阈值的 mousedown + mouseup + click：按单击处理，激活该 tab
    fireEvent.mouseDown(inactiveTab, { button: 0, clientX: 100, clientY: 10 });
    fireEvent.mouseUp(window, { clientX: 100, clientY: 10 });
    fireEvent.click(inactiveTab);
    await waitFor(() => {
      const activeTabEl = document.querySelector(".tab-item.active");
      expect(activeTabEl?.textContent).toContain("file-a.pdf");
    });
  });

  it("enters split view via the tab-bar side-by-side button", async () => {
    (open as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("/test/file-a.pdf")
      .mockResolvedValueOnce("/test/file-b.pdf");

    renderApp();
    await openPdf("/test/file-a.pdf");

    // 只有一个 tab 时不显示入口
    expect(screen.queryByLabelText("并排对照")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("open-pdf-btn"));
    await waitFor(() => {
      expect(screen.getByText("file-b.pdf")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("并排对照"));

    await waitFor(() => {
      expect(screen.getAllByTestId("pdf-viewer")).toHaveLength(2);
    });
    // 进入分屏后入口消失，退出按钮出现
    expect(screen.queryByLabelText("并排对照")).not.toBeInTheDocument();
    expect(screen.getByLabelText("退出并排视图")).toBeInTheDocument();
  });

  it("jumps to a secondary-tab stash without collapsing the split view", async () => {
    (open as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("/test/file-a.pdf")
      .mockResolvedValueOnce("/test/file-b.pdf");

    renderApp();

    await openPdf("/test/file-a.pdf");
    fireEvent.click(screen.getByTestId("open-pdf-btn"));
    await waitFor(() => {
      expect(screen.getByText("file-b.pdf")).toBeInTheDocument();
    });

    // Drag file-a (inactive) into the main area: it becomes the secondary tab.
    const inactiveTab = screen.getByRole("button", { name: /关闭 file-a.pdf/i })
      .parentElement as HTMLElement;
    dragTabIntoMainArea(inactiveTab);

    await waitFor(() => {
      expect(screen.getAllByTestId("pdf-viewer")).toHaveLength(2);
    });

    // Stash from the secondary viewer (file-a).
    fireEvent.click(screen.getAllByTestId("trigger-selection")[1]);
    fireEvent.click(screen.getByRole("button", { name: /加入暂存/i }));
    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /暂存区 \(1\)/i })
      ).toBeInTheDocument();
    });

    // Click the stash text to jump to its page in the secondary viewer.
    fireEvent.click(screen.getByText("selected text"));

    // 主屏仍是 file-b（active 不被切换），两个面板渲染不同的 PDF。
    await waitFor(() => {
      const viewers = screen.getAllByTestId("pdf-viewer");
      expect(viewers).toHaveLength(2);
      expect(viewers[0].getAttribute("data-filepath")).toBe("/test/file-b.pdf");
      expect(viewers[1].getAttribute("data-filepath")).toBe("/test/file-a.pdf");
    });
    const activeTabEl = document.querySelector(".tab-item.active");
    expect(activeTabEl?.textContent).toContain("file-b.pdf");
  });

  it("shows a notice when a recent file cannot be opened side by side", async () => {
    const { message } = await import("@tauri-apps/plugin-dialog");
    setupMockInvoke({
      load_recent_files: () => [
        { path: "/test/file.pdf", fileName: "file.pdf", openedAt: 1 },
      ],
    });

    renderApp();
    await openPdf("/test/file.pdf");

    fireEvent.click(screen.getByTestId("recent-files-trigger"));
    fireEvent.click(await screen.findByLabelText("在右侧并排打开"));

    // 目标文件就是主视图本身，无法并排，应提示而非静默降级
    await waitFor(() => {
      expect(message).toHaveBeenCalledWith(
        expect.stringContaining("无法并排打开"),
        expect.objectContaining({ kind: "info" })
      );
    });
    expect(screen.getAllByTestId("pdf-viewer")).toHaveLength(1);
  });
});
