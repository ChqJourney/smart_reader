import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import App from "./App";
import { open } from "@tauri-apps/plugin-dialog";
import { DEFAULT_SETTINGS } from "./services/settings";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("./services/llm", async () => {
  const actual = await vi.importActual<typeof import("./services/llm")>("./services/llm");
  return {
    ...actual,
    streamChatCompletion: vi.fn().mockImplementation(async function* () {
      yield { type: "chunk", content: "回答" };
    }),
  };
});

const triggerSelection = vi.fn();

const lastAnnotations = vi.fn();

vi.mock("./components/PdfViewer", () => ({
  default: React.forwardRef(
    (
      {
        onSelection,
        onToggleVisibility,
        annotations,
        onAnnotationDelete,
      }: {
        onSelection?: (
          text: string,
          page: number,
          position: { x: number; y: number; pdfX: number; pdfY: number }
        ) => void;
        onToggleVisibility?: () => void;
        annotations?: { id?: string; type: string; stashId?: string; interpretedGroupSize?: number }[];
        onAnnotationDelete?: (id: string) => void;
      },
      ref: React.Ref<HTMLDivElement>
    ) => {
      triggerSelection.mockImplementation(() => {
        onSelection?.("selected text", 3, { x: 100, y: 200, pdfX: 50, pdfY: 60 });
      });
      lastAnnotations.mockImplementation(() => annotations ?? []);
      return (
        <div data-testid="pdf-viewer" ref={ref}>
          PdfViewer
          <button data-testid="trigger-selection" onClick={() => triggerSelection()}>
            Select
          </button>
          {annotations?.map((a) => {
            const isExplain = a.type === "explain" || typeof a.interpretedGroupSize === "number";
            return (
              <div key={a.id ?? `${a.type}-${a.stashId}`}>
                <button
                  aria-label={a.type === "translate" ? "翻译" : a.type === "explain" ? "解读" : "已解读暂存"}
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
            <button title="隐藏 PDF 面板" onClick={onToggleVisibility}>隐藏</button>
          )}
        </div>
      );
    }
  ),
}));

function triggerPdfSelection() {
  fireEvent.click(screen.getByTestId("trigger-selection"));
}

async function openPdf(path = "/test/file.pdf") {
  (open as ReturnType<typeof vi.fn>).mockResolvedValue(path);
  fireEvent.click(screen.getByRole("button", { name: /Open PDF/i }));
  await waitFor(() => {
    expect(screen.getByText(path.split("/").pop()!)).toBeInTheDocument();
  });
}

function setupMockInvoke() {
  mockInvoke.mockImplementation((command: string, args?: Record<string, any>) => {
    switch (command) {
      case "load_pdf_data":
        return Promise.resolve({ annotations: [], sessionIds: [] });
      case "get_pdf_hash":
        return Promise.resolve(`hash-${args?.filePath}`);
      case "load_session":
        return Promise.resolve(null);
      case "load_settings":
        return Promise.resolve({ ...DEFAULT_SETTINGS });
      case "load_recent_files":
        return Promise.resolve([]);
      case "save_session":
      case "save_pdf_data":
      case "delete_session":
      case "save_settings":
      case "save_recent_files":
        return Promise.resolve(undefined);
      default:
        return Promise.reject(new Error(`No mock handler for command: ${command}`));
    }
  });
}

describe("App", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    vi.clearAllMocks();
    localStorage.clear();
    setupMockInvoke();
  });

  it("renders header and open button", () => {
    render(<App />);
    expect(screen.getByLabelText("最近打开的文件")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open PDF/i })).toBeInTheDocument();
  });

  it("toggles left and right panels", () => {
    render(<App />);

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
    render(<App />);

    await openPdf();
    triggerPdfSelection();

    fireEvent.click(screen.getByRole("button", { name: /加入暂存/i }));

    expect(screen.getByRole("tab", { name: /暂存区 \(1\)/i })).toBeInTheDocument();
    expect(screen.getByText(/selected text/i)).toBeInTheDocument();
  });

  it("creates a session and clears stash after custom interpretation", async () => {
    render(<App />);

    await openPdf();
    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: /加入暂存/i }));

    fireEvent.click(screen.getByRole("button", { name: /自定义解读/i }));
    fireEvent.change(screen.getByPlaceholderText(/输入你的解读要求/), {
      target: { value: "请分析" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/i }));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /解读记录 \(1\)/i })).toBeInTheDocument();
    });
    expect(screen.getByRole("tab", { name: /暂存区 \(0\)/i })).toBeInTheDocument();
  });

  it("custom interpretation prompt includes stash content", async () => {
    const { streamChatCompletion } = await import("./services/llm");
    render(<App />);

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

    const [, messages] = (streamChatCompletion as ReturnType<typeof vi.fn>).mock.calls[0];
    const userMessage = messages.find((m: { role: string; content: string }) => m.role === "user");
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
    render(<App />);

    await openPdf();
    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: /解读/i }));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /解读记录 \(1\)/i })).toBeInTheDocument();
    });
  });

  it("saves explain session reference to PDF data", async () => {
    render(<App />);

    await openPdf("/test/file.pdf");
    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: /解读/i }));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /解读记录 \(1\)/i })).toBeInTheDocument();
    });

    const annotation = lastAnnotations().find((a: { type: string }) => a.type === "explain");
    expect(annotation).toBeDefined();
    const sessionId = (annotation as any).sessionId;
    expect(sessionId).toBeDefined();

    await waitFor(() => {
      const savePdfCalls = mockInvoke.mock.calls.filter((call) => call[0] === "save_pdf_data");
      expect(savePdfCalls.length).toBeGreaterThan(0);
      expect(
        savePdfCalls.some((call) => (call[1] as any).data.sessionIds.includes(sessionId))
      ).toBe(true);
    });
  });

  it("removes a stash and its highlight when deleting", async () => {
    render(<App />);

    await openPdf();
    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: /加入暂存/i }));

    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    expect(screen.getByRole("tab", { name: /暂存区 \(0\)/i })).toBeInTheDocument();
  });

  it("clears all stashes when clearing", async () => {
    render(<App />);

    await openPdf();
    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: /加入暂存/i }));
    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: /加入暂存/i }));

    fireEvent.click(screen.getByRole("button", { name: /清空暂存/i }));

    expect(screen.getByRole("tab", { name: /暂存区 \(0\)/i })).toBeInTheDocument();
  });

  it("hides stashes and sessions when their tab is closed", async () => {
    render(<App />);

    await openPdf();
    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: /加入暂存/i }));

    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: "解读" }));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /暂存区 \(1\)/i })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /解读记录 \(1\)/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle(/关闭标签页/i));

    expect(screen.queryByText(/selected text/i)).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /暂存区 \(0\)/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /解读记录 \(0\)/i })).toBeInTheDocument();
  });

  it("filters stashes and sessions by the active tab", async () => {
    (open as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("/test/file-a.pdf")
      .mockResolvedValueOnce("/test/file-b.pdf");

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Open PDF/i }));
    await waitFor(() => {
      expect(screen.getByText("file-a.pdf")).toBeInTheDocument();
    });
    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: /加入暂存/i }));

    fireEvent.click(screen.getByRole("button", { name: /Open PDF/i }));
    await waitFor(() => {
      expect(screen.getByText("file-b.pdf")).toBeInTheDocument();
    });

    expect(screen.queryByText(/selected text/i)).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /暂存区 \(0\)/i })).toBeInTheDocument();

    const fileATab = screen.getAllByText("file-a.pdf")
      .find((el) => el.classList.contains("tab-name"))?.parentElement;
    expect(fileATab).toBeDefined();
    fireEvent.click(fileATab!);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /暂存区 \(1\)/i })).toBeInTheDocument();
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

    mockInvoke.mockImplementation((command: string, args?: Record<string, any>) => {
      if (command === "load_pdf_data" && args?.filePath === "/test/file.pdf") {
        return Promise.resolve({ annotations: [], sessionIds: ["session-existing"] });
      }
      if (command === "load_session" && args?.sessionId === "session-existing") {
        return Promise.resolve(existingSession);
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
      if (["save_session", "save_pdf_data", "delete_session", "save_settings", "save_recent_files"].includes(command)) {
        return Promise.resolve(undefined);
      }
      return Promise.reject(new Error(`No mock handler for command: ${command}`));
    });

    render(<App />);

    await openPdf();

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /解读记录 \(1\)/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/请解读/i)).toBeInTheDocument();
  });

  it("still removes annotation when session cleanup fails", async () => {
    render(<App />);

    await openPdf("/test/file.pdf");
    triggerPdfSelection();
    fireEvent.click(screen.getByRole("button", { name: /解读/i }));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /解读记录 \(1\)/i })).toBeInTheDocument();
    });

    // Make subsequent loadPdfData reject to simulate backend failure
    mockInvoke.mockImplementation((command: string, args?: Record<string, any>) => {
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
      if (["save_session", "save_pdf_data", "delete_session", "load_session", "save_settings", "save_recent_files"].includes(command)) {
        return Promise.resolve(undefined);
      }
      return Promise.reject(new Error(`No mock handler for command: ${command}`));
    });

    const deleteSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    fireEvent.click(screen.getByRole("button", { name: /删除解读/i }));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /解读记录 \(0\)/i })).toBeInTheDocument();
    });

    deleteSpy.mockRestore();
  });

  it("enters split view when dragging an inactive tab into the main area", async () => {
    (open as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("/test/file-a.pdf")
      .mockResolvedValueOnce("/test/file-b.pdf");

    render(<App />);

    await openPdf("/test/file-a.pdf");
    fireEvent.click(screen.getByRole("button", { name: /Open PDF/i }));
    await waitFor(() => {
      expect(screen.getByText("file-b.pdf")).toBeInTheDocument();
    });

    // Find the inactive tab (file-a) and drag it into the main area.
    const inactiveTab = screen.getByRole("button", { name: /关闭 file-a.pdf/i }).parentElement as HTMLElement;
    let draggedTabId = "";
    const dataTransfer = {
      setData: vi.fn((_format: string, value: string) => {
        draggedTabId = value;
      }),
      effectAllowed: "",
      getData: vi.fn(() => draggedTabId),
      dropEffect: "",
    };

    fireEvent.dragStart(inactiveTab, { dataTransfer });
    const main = document.querySelector("main") as HTMLElement;
    fireEvent.dragOver(main, { dataTransfer });
    fireEvent.drop(main, { dataTransfer });

    await waitFor(() => {
      expect(screen.getAllByTestId("pdf-viewer")).toHaveLength(2);
    });

    // Exit split view and verify we are back to a single PDF panel.
    fireEvent.click(screen.getByLabelText("退出并排视图"));
    await waitFor(() => {
      expect(screen.getAllByTestId("pdf-viewer")).toHaveLength(1);
    });
  });

  it("shrinks right panel to 20% with min 200px when entering split view", async () => {
    (open as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("/test/file-a.pdf")
      .mockResolvedValueOnce("/test/file-b.pdf");

    render(<App />);

    await openPdf("/test/file-a.pdf");
    fireEvent.click(screen.getByRole("button", { name: /Open PDF/i }));
    await waitFor(() => {
      expect(screen.getByText("file-b.pdf")).toBeInTheDocument();
    });

    const main = document.querySelector("main") as HTMLElement;
    const originalGetBoundingClientRect = main.getBoundingClientRect.bind(main);
    main.getBoundingClientRect = vi.fn(() => ({
      width: 2000,
      height: 600,
      top: 0,
      left: 0,
      right: 2000,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => "",
    } as DOMRect));

    const inactiveTab = screen.getByRole("button", { name: /关闭 file-a.pdf/i }).parentElement as HTMLElement;
    let draggedTabId = "";
    const dataTransfer = {
      setData: vi.fn((_format: string, value: string) => {
        draggedTabId = value;
      }),
      effectAllowed: "",
      getData: vi.fn(() => draggedTabId),
      dropEffect: "",
    };

    fireEvent.dragStart(inactiveTab, { dataTransfer });
    fireEvent.dragOver(main, { dataTransfer });
    fireEvent.drop(main, { dataTransfer });

    await waitFor(() => {
      expect(screen.getAllByTestId("pdf-viewer")).toHaveLength(2);
    });

    const rightPanel = document.querySelector(".right-panel") as HTMLElement;
    expect(rightPanel.style.width).toBe("20%");

    main.getBoundingClientRect = originalGetBoundingClientRect;
  });
});
