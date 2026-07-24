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
    const input = screen.getByLabelText("页码") as HTMLInputElement;
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
      expect((screen.getByLabelText("页码") as HTMLInputElement).value).toBe(
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
    expect((screen.getByLabelText("页码") as HTMLInputElement).value).toBe("1");
  });
});
