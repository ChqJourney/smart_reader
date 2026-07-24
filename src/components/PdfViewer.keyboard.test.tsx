import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import PdfViewer from "./PdfViewer";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_SETTINGS } from "../services/settings";

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "/mock-pdf-worker.js",
}));

const mockGetDocument = vi.hoisted(() => vi.fn());

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: mockGetDocument,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

function createMockPdf(numPages = 5) {
  return {
    numPages,
    getOutline: vi.fn(() => Promise.resolve([])),
    getPage: vi.fn(async () => ({
      getViewport: () => ({
        width: 300,
        height: 400,
        scale: 1.5,
        convertToViewportPoint: (x: number, y: number) => [x * 1.5, y * 1.5],
      }),
      render: () => ({ promise: Promise.resolve() }),
      getTextContent: () => Promise.resolve({ items: [] }),
      getAnnotations: () => Promise.resolve([]),
    })),
    destroy: vi.fn(),
  };
}

async function renderViewerAndWaitForPdf(isFocused?: boolean) {
  mockGetDocument.mockReturnValue({
    promise: Promise.resolve(createMockPdf()),
  });
  const utils = render(
    <PdfViewer
      tabId="tab-1"
      filePath="/fake/test.pdf"
      initialState={{ viewMode: "single" }}
      settings={DEFAULT_SETTINGS}
      {...(isFocused === undefined ? {} : { isFocused })}
    />
  );
  await waitFor(() => {
    const input = screen.getByLabelText("页码") as HTMLButtonElement;
    if (!input || input.disabled) {
      throw new Error("page input not ready yet");
    }
  });
  return utils;
}

describe("PdfViewer 键盘焦点（isFocused）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValue([1, 2, 3]);
  });

  it("焦点屏响应 Ctrl+F 打开搜索条、方向键翻页", async () => {
    const { container } = await renderViewerAndWaitForPdf();

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(container.querySelector(".pdf-search-bar")).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() => {
      expect((screen.getByLabelText("页码") as HTMLElement).textContent).toBe(
        "2"
      );
    });
  });

  it("非焦点屏忽略 Ctrl+F 与方向键（分屏双响应回归）", async () => {
    const { container } = await renderViewerAndWaitForPdf(false);

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(container.querySelector(".pdf-search-bar")).toBeNull();

    fireEvent.keyDown(window, { key: "ArrowDown" });
    // 非焦点屏不翻页：页码保持 1
    expect((screen.getByLabelText("页码") as HTMLElement).textContent).toBe(
      "1"
    );
  });
});

describe("PdfViewer 跳页面板（Cmd/Ctrl+G）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValue([1, 2, 3]);
  });

  it("点击工具栏页码按钮打开跳页面板", async () => {
    await renderViewerAndWaitForPdf();

    fireEvent.click(screen.getByLabelText("页码"));
    expect(screen.getByLabelText("跳转到页")).not.toBeNull();
  });

  it("Ctrl+G 打开面板，输入页码回车跳转并闪现大数字", async () => {
    const { container } = await renderViewerAndWaitForPdf();

    fireEvent.keyDown(window, { key: "g", ctrlKey: true });
    const jumpInput = screen.getByLabelText("跳转到页") as HTMLInputElement;
    expect(jumpInput).not.toBeNull();

    fireEvent.change(jumpInput, { target: { value: "4" } });
    fireEvent.keyDown(jumpInput, { key: "Enter" });

    // 跳转到第 4 页，面板关闭，闪卡出现
    await waitFor(() => {
      expect((screen.getByLabelText("页码") as HTMLElement).textContent).toBe(
        "4"
      );
    });
    expect(screen.queryByLabelText("跳转到页")).toBeNull();
    const flash = container.querySelector(".pdf-page-flash");
    expect(flash).not.toBeNull();
    expect(flash!.textContent).toBe("4");

    // 动画结束后（600ms 定时清理）闪卡移除
    await waitFor(
      () => expect(container.querySelector(".pdf-page-flash")).toBeNull(),
      { timeout: 1500 }
    );
  });

  it("Meta+G（macOS）同样打开面板，Escape 关闭", async () => {
    await renderViewerAndWaitForPdf();

    fireEvent.keyDown(window, { key: "g", metaKey: true });
    expect(screen.getByLabelText("跳转到页")).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByLabelText("跳转到页")).toBeNull();
  });

  it("跳转目标越界时 clamp 到总页数，闪卡显示 clamp 后的页码", async () => {
    const { container } = await renderViewerAndWaitForPdf();

    fireEvent.keyDown(window, { key: "g", ctrlKey: true });
    const jumpInput = screen.getByLabelText("跳转到页") as HTMLInputElement;
    fireEvent.change(jumpInput, { target: { value: "999" } });
    fireEvent.keyDown(jumpInput, { key: "Enter" });

    await waitFor(() => {
      expect((screen.getByLabelText("页码") as HTMLElement).textContent).toBe(
        "5"
      );
    });
    expect(container.querySelector(".pdf-page-flash")!.textContent).toBe("5");
  });

  it("非焦点屏忽略 Ctrl+G", async () => {
    await renderViewerAndWaitForPdf(false);

    fireEvent.keyDown(window, { key: "g", ctrlKey: true });
    expect(screen.queryByLabelText("跳转到页")).toBeNull();
  });
});
