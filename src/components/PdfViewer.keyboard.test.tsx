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
      settings={DEFAULT_SETTINGS}
      {...(isFocused === undefined ? {} : { isFocused })}
    />
  );
  // 连续模式下 goToPage / 方向键 / PageUp/PageDown 都会调用容器的
  // scrollTo / scrollBy；jsdom 未实现这两个方法，统一 mock 掉。
  const canvasContainer = utils.container.querySelector(
    ".pdf-canvas-container"
  ) as HTMLDivElement;
  Object.defineProperty(canvasContainer, "scrollTo", {
    value: vi.fn(),
    writable: true,
    configurable: true,
  });
  Object.defineProperty(canvasContainer, "scrollBy", {
    value: vi.fn(),
    writable: true,
    configurable: true,
  });
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

    // ←/→ 连续模式下走 goToPage（clamp + scrollTo + jump lock）。
    fireEvent.keyDown(window, { key: "ArrowRight" });
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

    fireEvent.keyDown(window, { key: "ArrowRight" });
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

describe("PdfViewer PageUp/PageDown 翻页", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValue([1, 2, 3]);
  });

  it("PageDown/PageUp 滚动阅读区翻屏", async () => {
    const { container } = await renderViewerAndWaitForPdf();
    const canvasContainer = container.querySelector(
      ".pdf-canvas-container.continuous"
    ) as HTMLDivElement;
    // 给容器一个固定高度，使 scrollBy 的 top 不为 0
    canvasContainer.style.height = "500px";
    Object.defineProperty(canvasContainer, "clientHeight", {
      value: 500,
      configurable: true,
    });
    const scrollByMock = vi.fn();
    Object.defineProperty(canvasContainer, "scrollBy", {
      value: scrollByMock,
      writable: true,
      configurable: true,
    });

    fireEvent.keyDown(window, { key: "PageDown" });
    await waitFor(() => {
      expect(scrollByMock).toHaveBeenCalledWith(
        expect.objectContaining({
          top: expect.any(Number),
          behavior: "smooth",
        })
      );
    });
    const downCall = scrollByMock.mock.calls[0][0] as unknown as {
      top: number;
      behavior: string;
    };
    expect(downCall.top).toBeGreaterThan(0);

    scrollByMock.mockClear();
    fireEvent.keyDown(window, { key: "PageUp" });
    await waitFor(() => {
      expect(scrollByMock).toHaveBeenCalledWith(
        expect.objectContaining({
          top: expect.any(Number),
          behavior: "smooth",
        })
      );
    });
    const upCall = scrollByMock.mock.calls[0][0] as unknown as {
      top: number;
      behavior: string;
    };
    expect(upCall.top).toBeLessThan(0);
  });
});
