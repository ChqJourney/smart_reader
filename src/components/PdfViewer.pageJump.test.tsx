import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  act,
} from "@testing-library/react";
import PdfViewer, {
  computeContinuousScrollTop,
  PageViewportInfo,
} from "./PdfViewer";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_SETTINGS } from "../services/settings";

// --- Helpers for computeContinuousScrollTop unit tests ---

function makeElement(rect: Partial<DOMRect>): HTMLDivElement {
  return {
    getBoundingClientRect: () =>
      ({
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => "",
        ...rect,
      }) as DOMRect,
  } as HTMLDivElement;
}

function makeContainer(
  rect: Partial<DOMRect>,
  scrollTop: number
): HTMLDivElement {
  return {
    getBoundingClientRect: () =>
      ({
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => "",
        ...rect,
      }) as DOMRect,
    scrollTop,
  } as HTMLDivElement;
}

// --- Mock pdfjs-dist worker URL import and module ---

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

// --- Component integration test setup ---

const SCALE = 1.5;
const PAGE_HEIGHTS = [200, 250, 300, 350, 400, 450, 500, 550, 600, 650];
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
  };
}

function expectedScrollTopForPage(targetPage: number): number {
  let top = 0;
  for (let i = 1; i < targetPage; i++) {
    top += PAGE_HEIGHTS[i - 1] * SCALE + PAGE_SPACING;
  }
  return top;
}

describe("computeContinuousScrollTop", () => {
  it("uses DOM geometry when the target wrapper is available and viewport data is incomplete", () => {
    // Container border-box top is at viewport y=100, content area starts at y=124 (padding-top 24).
    const container = makeContainer({ top: 100 }, 500);
    // Target wrapper top is at viewport y=224.
    // At scrollTop=500, its top relative to content origin is
    // (224 - 100 + 500 - 24) = 600.
    const target = makeElement({ top: 224 });

    const top = computeContinuousScrollTop(
      3,
      container,
      () => target,
      new Map<number, PageViewportInfo>()
    );

    expect(top).toBe(600);
  });

  it("falls back to viewport accumulation when the wrapper is not yet available", () => {
    const container = makeContainer({ top: 0 }, 0);
    const viewports = new Map<number, PageViewportInfo>([
      [1, { width: 100, height: 200 }],
      [2, { width: 100, height: 250 }],
    ]);

    // Page 3 top = (page1 height + spacing) + (page2 height + spacing)
    //            = (200 + 24) + (250 + 24) = 498
    const top = computeContinuousScrollTop(3, container, () => null, viewports);

    expect(top).toBe(498);
  });

  it("returns 0 for the first page", () => {
    const container = makeContainer({ top: 100 }, 0);
    const first = makeElement({ top: 124 });

    const top = computeContinuousScrollTop(
      1,
      container,
      () => first,
      new Map<number, PageViewportInfo>()
    );

    expect(top).toBe(0);
  });

  it("is independent of the wrapper's offsetParent", () => {
    // Simulate a wrapper whose offsetTop is wrong (relative to body, not container),
    // but getBoundingClientRect is correct. This was the root cause of the original bug.
    const container = makeContainer({ top: 300 }, 0);
    const target = makeElement({ top: 324 });
    Object.defineProperty(target, "offsetTop", {
      value: 900, // wrong, would be relative to body
      configurable: true,
    });

    const top = computeContinuousScrollTop(
      2,
      container,
      () => target,
      new Map<number, PageViewportInfo>()
    );

    expect(top).toBe(0);
  });

  it("prefers authoritative viewport sizes over incomplete DOM geometry", () => {
    // This is the regression case for the continuous-mode page jump bug:
    // the target wrapper exists in the DOM, but earlier pages have not finished
    // sizing themselves, so getBoundingClientRect reports an inaccurate position.
    const viewports = new Map<number, PageViewportInfo>([
      [1, { width: 100, height: 200 }],
      [2, { width: 100, height: 250 }],
      [3, { width: 100, height: 300 }],
    ]);

    const container = makeContainer({ top: 100 }, 0);
    // The DOM thinks earlier pages are only 50px tall (placeholders), so page 3
    // appears at y=100 + 24 + 50 + 24 + 50 + 24 = 272. The correct position based
    // on viewports is y=100 + 24 + 200 + 24 + 250 + 24 = 622.
    const target = makeElement({ top: 272, height: 300 });

    const top = computeContinuousScrollTop(
      3,
      container,
      () => target,
      viewports
    );

    // scrollTop should align page 3 at the top: (200+24) + (250+24) = 498
    expect(top).toBe(498);
  });
});

describe("PdfViewer continuous mode page jump", () => {
  let scrollToSpy: ReturnType<typeof vi.spyOn>;
  let originalScrollToRef: unknown;
  let originalScrollTopDescriptor: PropertyDescriptor | undefined;
  const scrollTops = new WeakMap<Element, number>();

  beforeEach(() => {
    vi.mocked(invoke).mockResolvedValue([1, 2, 3]);

    mockGetDocument.mockReturnValue({
      promise: Promise.resolve(createMockPdf()),
    });

    // jsdom does not implement scrollTop/scrollTo consistently, so we install
    // our own scrollTop storage and a scrollTo mock that writes into it.
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
    scrollToSpy = vi.spyOn(Element.prototype, "scrollTo" as any);
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
    scrollTops.delete(document.body);
  });

  it("jumps to the requested page and scrolls to the correct position", async () => {
    const { container } = render(
      <PdfViewer filePath="/fake/test.pdf" settings={DEFAULT_SETTINGS} />
    );

    // Wait until the viewer has loaded the PDF and viewports are ready.
    const pageInput = await waitFor<HTMLInputElement>(() => {
      const input = screen.getByLabelText("页码") as HTMLInputElement;
      if (!input || input.disabled) {
        throw new Error("page input not ready yet");
      }
      return input;
    });

    expect(pageInput.value).toBe("1");

    const targetPage = 5;

    // Simulate the user typing a page number and pressing Enter.
    fireEvent.change(pageInput, { target: { value: String(targetPage) } });
    fireEvent.keyDown(pageInput, { key: "Enter", code: "Enter" });

    // Wait for the jump to be processed (smooth scroll is mocked, but the
    // component still holds a jump lock for a short period).
    await waitFor(() => {
      expect(pageInput.value).toBe(String(targetPage));
    });

    // Verify the displayed page number matches the requested page.
    expect(pageInput.value).toBe(String(targetPage));

    // Verify the container was scrolled to the exact position that puts the
    // target page at the top of the viewport.
    const canvasContainer = container.querySelector(
      ".pdf-canvas-container.continuous"
    );
    expect(canvasContainer).not.toBeNull();
    expect(scrollToSpy).toHaveBeenCalled();
    expect(canvasContainer!.scrollTop).toBe(
      expectedScrollTopForPage(targetPage)
    );
  });

  it("fits page width to container when fit-to-width button is clicked", async () => {
    const { container } = render(
      <PdfViewer filePath="/fake/test.pdf" settings={DEFAULT_SETTINGS} />
    );

    // Wait until the viewer has loaded the PDF and viewports are ready.
    await waitFor<HTMLInputElement>(() => {
      const input = screen.getByLabelText("页码") as HTMLInputElement;
      if (!input || input.disabled) {
        throw new Error("page input not ready yet");
      }
      return input;
    });

    expect(screen.getByText("150%")).toBeInTheDocument();

    // Provide a stable container width for the fit calculation.
    const canvasContainer = container.querySelector(
      ".pdf-canvas-container.continuous"
    ) as HTMLDivElement;
    expect(canvasContainer).not.toBeNull();
    Object.defineProperty(canvasContainer, "clientWidth", {
      value: 400,
      configurable: true,
    });
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      paddingLeft: "24px",
    } as CSSStyleDeclaration);

    const fitButton = screen.getByLabelText("适合宽度");
    fireEvent.click(fitButton);

    // newScale = (400 - 24 * 2) / (200 * 1.5 / 1.5) = 352 / 200 = 1.76
    await waitFor(() => {
      expect(screen.getByText("176%")).toBeInTheDocument();
    });
  });

  it("turns pages with prev/next buttons in continuous mode", async () => {
    const { container } = render(
      <PdfViewer filePath="/fake/test.pdf" settings={DEFAULT_SETTINGS} />
    );

    const pageInput = await waitFor<HTMLInputElement>(() => {
      const input = screen.getByLabelText("页码") as HTMLInputElement;
      if (!input || input.disabled) {
        throw new Error("page input not ready yet");
      }
      return input;
    });

    expect(pageInput.value).toBe("1");

    const nextButton = screen.getByLabelText("下一页");
    const prevButton = screen.getByLabelText("上一页");

    fireEvent.click(nextButton);
    await waitFor(() => {
      expect(pageInput.value).toBe("2");
    });

    const canvasContainer = container.querySelector(
      ".pdf-canvas-container.continuous"
    );
    expect(canvasContainer).not.toBeNull();
    expect(canvasContainer!.scrollTop).toBe(expectedScrollTopForPage(2));

    fireEvent.click(prevButton);
    await waitFor(() => {
      expect(pageInput.value).toBe("1");
    });
    expect(canvasContainer!.scrollTop).toBe(expectedScrollTopForPage(1));
  });

  it("keeps page number stable while rapidly scrolling back and forth", async () => {
    const CONTAINER_PADDING_TOP = 24;
    const CONTAINER_HEIGHT = 300;

    const { container } = render(
      <PdfViewer filePath="/fake/test.pdf" settings={DEFAULT_SETTINGS} />
    );

    const pageInput = await waitFor<HTMLInputElement>(() => {
      const input = screen.getByLabelText("页码") as HTMLInputElement;
      if (!input || input.disabled) {
        throw new Error("page input not ready yet");
      }
      return input;
    });

    const canvasContainer = container.querySelector(
      ".pdf-canvas-container.continuous"
    ) as HTMLDivElement;
    expect(canvasContainer).not.toBeNull();

    const wrappers = Array.from(
      container.querySelectorAll(".pdf-page-wrapper")
    ) as HTMLDivElement[];
    expect(wrappers.length).toBe(NUM_PAGES);

    // Execute RAF callbacks synchronously so we can fire many scroll events
    // in sequence without waiting for real animation frames.
    const originalRAF = globalThis.requestAnimationFrame;
    const rafCallbacks: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    };
    const flushRaf = () => {
      const pending = rafCallbacks.splice(0, rafCallbacks.length);
      pending.forEach((cb) => cb(performance.now()));
    };

    vi.useFakeTimers();

    // Mock container geometry once.
    vi.spyOn(canvasContainer, "getBoundingClientRect").mockReturnValue({
      top: 0,
      left: 0,
      right: 400,
      bottom: CONTAINER_HEIGHT,
      width: 400,
      height: CONTAINER_HEIGHT,
      x: 0,
      y: 0,
      toJSON: () => "",
    } as DOMRect);

    // Helper to update wrapper geometry for a given scrollTop.
    const applyScrollTop = (scrollTop: number) => {
      canvasContainer.scrollTop = scrollTop;
      wrappers.forEach((wrapper) => {
        const page = parseInt(wrapper.getAttribute("data-page")!, 10);
        const height = PAGE_HEIGHTS[page - 1] * SCALE;
        const top =
          CONTAINER_PADDING_TOP - scrollTop + expectedScrollTopForPage(page);
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
    };

    // Rapidly scroll past page 5, then back to page 3, simulating a user
    // dragging the scrollbar back and forth. The debounced handler should
    // only sync the page after scrolling pauses, using the latest position.
    applyScrollTop(expectedScrollTopForPage(5));
    fireEvent.scroll(canvasContainer);

    applyScrollTop(expectedScrollTopForPage(4));
    fireEvent.scroll(canvasContainer);

    applyScrollTop(expectedScrollTopForPage(6));
    fireEvent.scroll(canvasContainer);

    applyScrollTop(expectedScrollTopForPage(3));
    fireEvent.scroll(canvasContainer);

    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    act(flushRaf);

    expect(pageInput.value).toBe("3");

    vi.useRealTimers();
    globalThis.requestAnimationFrame = originalRAF;
  });

  it("opens the search bar with Ctrl+F and starts from the current page", async () => {
    const mockPdfWithText = {
      numPages: NUM_PAGES,
      getOutline: vi.fn(() => Promise.resolve([])),
      getPageIndex: vi.fn(() => Promise.resolve(0)),
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
          getTextContent: () =>
            Promise.resolve({
              items: [
                {
                  str:
                    pageNum === 2 || pageNum === 4
                      ? "searchable term"
                      : "other text",
                  dir: "ltr",
                  width: 80,
                  height: 12,
                  transform: [12, 0, 0, 12, 10, 20],
                  fontName: "g_d0_f1",
                },
              ],
            }),
          getAnnotations: () => Promise.resolve([]),
        };
      }),
    };

    mockGetDocument.mockReturnValue({
      promise: Promise.resolve(mockPdfWithText),
    });

    render(<PdfViewer filePath="/fake/test.pdf" settings={DEFAULT_SETTINGS} />);

    const pageInput = await waitFor<HTMLInputElement>(() => {
      const input = screen.getByLabelText("页码") as HTMLInputElement;
      if (!input || input.disabled) {
        throw new Error("page input not ready yet");
      }
      return input;
    });

    // Navigate to page 3 first.
    fireEvent.change(pageInput, { target: { value: "3" } });
    fireEvent.keyDown(pageInput, { key: "Enter", code: "Enter" });
    await waitFor(() => {
      expect(pageInput.value).toBe("3");
    });

    fireEvent.keyDown(window, { key: "f", code: "KeyF", ctrlKey: true });

    const searchInput = await waitFor(() =>
      screen.getByLabelText("搜索 PDF 内容")
    );
    expect(searchInput).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "searchable" } });

    // There are matches on pages 2 and 4. Starting from page 3, the first
    // match should be on page 4 (the second match in document order).
    await waitFor(() => {
      expect(screen.getByText(/第 2 \/ 共 2 个/)).toBeInTheDocument();
    });
  });

  it("opens the outline sidebar and renders outline items", async () => {
    const outlineItems = [
      {
        title: "Section 1",
        dest: [null, { name: "XYZ" }, 0, 0, 0],
        url: null,
        items: [],
      },
      {
        title: "Section 2",
        dest: [null, { name: "XYZ" }, 0, 0, 0],
        url: null,
        items: [],
      },
    ];

    const mockPdfWithOutline = {
      ...createMockPdf(),
      getOutline: vi.fn(() => Promise.resolve(outlineItems)),
    };

    mockGetDocument.mockReturnValue({
      promise: Promise.resolve(mockPdfWithOutline),
    });

    render(<PdfViewer filePath="/fake/test.pdf" settings={DEFAULT_SETTINGS} />);

    await waitFor<HTMLInputElement>(() => {
      const input = screen.getByLabelText("页码") as HTMLInputElement;
      if (!input || input.disabled) {
        throw new Error("page input not ready yet");
      }
      return input;
    });

    const outlineButton = screen.getByLabelText("目录");
    expect(outlineButton).not.toBeDisabled();

    fireEvent.click(outlineButton);

    await waitFor(() => {
      expect(screen.getByText("Section 1")).toBeInTheDocument();
      expect(screen.getByText("Section 2")).toBeInTheDocument();
    });
  });
});
