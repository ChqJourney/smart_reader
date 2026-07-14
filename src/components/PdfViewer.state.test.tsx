import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

const SCALE = 1.5;
const PAGE_HEIGHTS = [200, 250, 300, 350, 400];
const NUM_PAGES = PAGE_HEIGHTS.length;
const PAGE_SPACING = 24;

function createMockPdf() {
  return {
    numPages: NUM_PAGES,
    getOutline: vi.fn(() => Promise.resolve([])),
    getPage: vi.fn(async (pageNum: number) => {
      const height = PAGE_HEIGHTS[pageNum - 1] ?? 300;
      const viewport = {
        width: 200 * SCALE,
        height: height * SCALE,
        scale: SCALE,
        convertToViewportPoint: (x: number, y: number) => [
          x * SCALE,
          y * SCALE,
        ],
      };
      return {
        getViewport: () => viewport,
        render: () => ({ promise: Promise.resolve() }),
        getTextContent: () => Promise.resolve({ items: [] }),
        getAnnotations: () => Promise.resolve([]),
      };
    }),
    destroy: vi.fn(),
  };
}

function expectedScrollTopForPage(targetPage: number): number {
  let top = 0;
  for (let i = 1; i < targetPage; i++) {
    top += PAGE_HEIGHTS[i - 1] * SCALE + PAGE_SPACING;
  }
  return top;
}

describe("PdfViewer tab state isolation", () => {
  let scrollTops = new WeakMap<Element, number>();
  let originalScrollTopDescriptor: PropertyDescriptor | undefined;
  let originalScrollToRef: unknown;

  beforeEach(() => {
    vi.mocked(invoke).mockResolvedValue([1, 2, 3]);
    scrollTops = new WeakMap<Element, number>();

    originalScrollTopDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollTop"
    );
    Object.defineProperty(Element.prototype, "scrollTop", {
      get: function (this: Element) {
        return scrollTops.get(this) ?? 0;
      },
      set: function (this: Element, value: number) {
        scrollTops.set(this, value);
      },
      configurable: true,
    });

    const originalScrollTo = (Element.prototype as any).scrollTo;
    (Element.prototype as any).scrollTo = vi.fn(function (
      this: Element,
      options: ScrollToOptions | number
    ) {
      const top = typeof options === "number" ? options : (options?.top ?? 0);
      this.scrollTop = top;
    });
    originalScrollToRef = originalScrollTo;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalScrollToRef !== undefined) {
      (Element.prototype as any).scrollTo = originalScrollToRef;
    }
    if (originalScrollTopDescriptor) {
      Object.defineProperty(
        Element.prototype,
        "scrollTop",
        originalScrollTopDescriptor
      );
    }
  });

  it("uses cached bytes without invoking read_pdf_bytes", async () => {
    const cachedBytes = new Uint8Array([1, 2, 3]);
    mockGetDocument.mockReturnValue({
      promise: Promise.resolve(createMockPdf()),
    });

    render(
      <PdfViewer
        tabId="tab-1"
        filePath="/fake/test.pdf"
        cachedBytes={cachedBytes}
        onPdfLoaded={vi.fn()}
        settings={DEFAULT_SETTINGS}
      />
    );

    await waitFor<HTMLInputElement>(() => {
      const input = screen.getByLabelText("页码") as HTMLInputElement;
      if (!input || input.disabled) {
        throw new Error("page input not ready yet");
      }
      return input;
    });

    expect(invoke).not.toHaveBeenCalledWith(
      "read_pdf_bytes",
      expect.anything()
    );
    expect(mockGetDocument).toHaveBeenCalledWith({ data: cachedBytes });
  });

  it("restores scrollTop from initialState in continuous mode", async () => {
    const targetScrollTop = 500;
    mockGetDocument.mockReturnValue({
      promise: Promise.resolve(createMockPdf()),
    });

    const { container } = render(
      <PdfViewer
        tabId="tab-1"
        filePath="/fake/test.pdf"
        initialState={{
          pageNum: 1,
          scale: SCALE,
          viewMode: "continuous",
          scrollTop: targetScrollTop,
        }}
        settings={DEFAULT_SETTINGS}
      />
    );

    await waitFor<HTMLInputElement>(() => {
      const input = screen.getByLabelText("页码") as HTMLInputElement;
      if (!input || input.disabled) {
        throw new Error("page input not ready yet");
      }
      return input;
    });

    const canvasContainer = container.querySelector(
      ".pdf-canvas-container.continuous"
    );
    expect(canvasContainer).not.toBeNull();
    expect(canvasContainer!.scrollTop).toBe(targetScrollTop);
  });

  it("executes pendingGotoPage after loading and clears it", async () => {
    const targetPage = 4;
    const onClearPendingGotoPage = vi.fn();
    mockGetDocument.mockReturnValue({
      promise: Promise.resolve(createMockPdf()),
    });

    const { container } = render(
      <PdfViewer
        tabId="tab-1"
        filePath="/fake/test.pdf"
        initialState={{
          pageNum: 1,
          scale: SCALE,
          viewMode: "continuous",
          pendingGotoPage: targetPage,
        }}
        onClearPendingGotoPage={onClearPendingGotoPage}
        settings={DEFAULT_SETTINGS}
      />
    );

    const pageInput = await waitFor<HTMLInputElement>(() => {
      const input = screen.getByLabelText("页码") as HTMLInputElement;
      if (!input || input.disabled) {
        throw new Error("page input not ready yet");
      }
      return input;
    });

    await waitFor(() => {
      expect(pageInput.value).toBe(String(targetPage));
    });

    const canvasContainer = container.querySelector(
      ".pdf-canvas-container.continuous"
    );
    expect(canvasContainer!.scrollTop).toBe(
      expectedScrollTopForPage(targetPage)
    );
    expect(onClearPendingGotoPage).toHaveBeenCalledWith("tab-1");
  });

  it("does not reload or reset page when cachedBytes becomes available after initial load", async () => {
    const onPdfLoaded = vi.fn();
    mockGetDocument.mockReturnValue({
      promise: Promise.resolve(createMockPdf()),
    });

    const { rerender } = render(
      <PdfViewer
        tabId="tab-1"
        filePath="/fake/test.pdf"
        onPdfLoaded={onPdfLoaded}
        settings={DEFAULT_SETTINGS}
      />
    );

    await waitFor<HTMLInputElement>(() => {
      const input = screen.getByLabelText("页码") as HTMLInputElement;
      if (!input || input.disabled) {
        throw new Error("page input not ready yet");
      }
      return input;
    });

    // Wait for the initial async load to finish and onPdfLoaded to fire.
    await waitFor(() => {
      expect(onPdfLoaded).toHaveBeenCalledTimes(1);
    });

    const cachedBytes = onPdfLoaded.mock.calls[0][1] as Uint8Array;

    // Clear the mock so we only count calls triggered by the re-render.
    mockGetDocument.mockClear();

    // Simulate a parent re-render that now provides cached bytes.
    rerender(
      <PdfViewer
        tabId="tab-1"
        filePath="/fake/test.pdf"
        cachedBytes={cachedBytes}
        onPdfLoaded={onPdfLoaded}
        settings={DEFAULT_SETTINGS}
      />
    );

    // Give any async work a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The PDF should not have been reloaded just because cachedBytes appeared.
    expect(mockGetDocument).not.toHaveBeenCalled();
  });

  it("reports scrollTop changes via onStateChange when scrolling", async () => {
    const onStateChange = vi.fn();
    mockGetDocument.mockReturnValue({
      promise: Promise.resolve(createMockPdf()),
    });

    const { container } = render(
      <PdfViewer
        tabId="tab-1"
        filePath="/fake/test.pdf"
        initialState={{
          pageNum: 1,
          scale: SCALE,
          viewMode: "continuous",
        }}
        onStateChange={onStateChange}
        settings={DEFAULT_SETTINGS}
      />
    );

    const canvasContainer = (await waitFor(() =>
      container.querySelector(".pdf-canvas-container.continuous")
    )) as HTMLDivElement;

    await waitFor<HTMLInputElement>(() => {
      const input = screen.getByLabelText("页码") as HTMLInputElement;
      if (!input || input.disabled) {
        throw new Error("page input not ready yet");
      }
      return input;
    });

    const targetScrollTop = expectedScrollTopForPage(3);
    canvasContainer.scrollTop = targetScrollTop;

    // Mock wrapper geometry so the scroll-driven page detection reads page 3.
    vi.spyOn(canvasContainer, "getBoundingClientRect").mockReturnValue({
      top: 0,
      left: 0,
      right: 400,
      bottom: 300,
      width: 400,
      height: 300,
      x: 0,
      y: 0,
      toJSON: () => "",
    } as DOMRect);

    const wrappers = Array.from(
      container.querySelectorAll(".pdf-page-wrapper")
    ) as HTMLDivElement[];
    wrappers.forEach((wrapper) => {
      const page = parseInt(wrapper.getAttribute("data-page")!, 10);
      const height = PAGE_HEIGHTS[page - 1] * SCALE;
      const top = 24 - targetScrollTop + expectedScrollTopForPage(page);
      vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
        top,
        left: 0,
        right: 200 * SCALE,
        bottom: top + height,
        width: 200 * SCALE,
        height,
        x: 0,
        y: top,
        toJSON: () => "",
      } as DOMRect);
    });

    fireEvent.scroll(canvasContainer);

    await waitFor(() => {
      expect(onStateChange).toHaveBeenCalledWith(
        expect.objectContaining({
          pageNum: 3,
          scrollTop: targetScrollTop,
        })
      );
    });
  });
});
