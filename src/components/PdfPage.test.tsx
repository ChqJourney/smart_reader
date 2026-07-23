import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import PdfPage from "./PdfPage";
import type { PageViewportInfo } from "./PdfViewer";
import { DEFAULT_SETTINGS } from "../services/settings";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../services/logs", () => ({
  error: vi.fn(),
}));

function makePdf() {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 100 * scale,
      height: 200 * scale,
      scale,
    }),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    getTextContent: () => Promise.resolve({ items: [] }),
    getAnnotations: () => Promise.resolve([]),
    cleanup: vi.fn(),
  };
  return {
    getPage: vi.fn(async () => page),
    page,
  };
}

function renderPage(
  props: Partial<React.ComponentProps<typeof PdfPage>> & {
    pageViewport?: PageViewportInfo | null;
    scale?: number;
  } = {}
) {
  const pdf = makePdf();
  const utils = render(
    <PdfPage
      pdf={pdf as never}
      pageNum={1}
      scale={props.scale ?? 1.5}
      shouldRender={props.shouldRender ?? false}
      pageViewport={props.pageViewport ?? null}
      onViewportLoaded={props.onViewportLoaded}
      settings={DEFAULT_SETTINGS}
    />
  );
  return { ...utils, pdf };
}

function getWrapper(container: HTMLElement): HTMLElement {
  const wrapper = container.querySelector(".pdf-page-wrapper");
  if (!wrapper) throw new Error("wrapper not found");
  return wrapper as HTMLElement;
}

describe("PdfPage wrapper sizing", () => {
  it("applies the pageViewport prop at render time (no one-commit state lag)", () => {
    // Regression for the zoom-restore mis-restore: wrapper sizes used to sync
    // from prop to state in an effect, so the commit that landed new viewport
    // entries still rendered OLD sizes; the zoom restore reading geometry in
    // that commit computed scrollTop from stale geometry and the page jumped.
    const { container, rerender, pdf } = renderPage({
      pageViewport: { width: 200, height: 300, scale: 1.5 },
      scale: 1.5,
    });

    const wrapper = getWrapper(container);
    expect(wrapper.style.width).toBe("200px");
    expect(wrapper.style.height).toBe("300px");

    // The post-zoom commit lands a new entry: the very next render must show
    // the new sizes — synchronously, before any effect runs.
    rerender(
      <PdfPage
        pdf={pdf as never}
        pageNum={1}
        scale={3.0}
        shouldRender={false}
        pageViewport={{ width: 400, height: 600, scale: 3.0 }}
        settings={DEFAULT_SETTINGS}
      />
    );
    expect(wrapper.style.width).toBe("400px");
    expect(wrapper.style.height).toBe("600px");
  });

  it("rescales a stale-scale entry to the live scale instead of awaiting a reload", () => {
    // A >50-page document zoomed from 1.0 to 2.0: off-window pages keep their
    // scale-1.0 entries until the preload window reaches them. Viewport sizes
    // are linear in scale, so the wrapper must render 2x immediately —
    // otherwise those pages stay wider than fitted pages and inflate
    // scrollWidth (the fit-to-width left-shift bug), and the zoom restore
    // mis-computes page positions (the zoom jump bug).
    const { container } = renderPage({
      pageViewport: { width: 200, height: 300, scale: 1.0 },
      scale: 2.0,
    });

    const wrapper = getWrapper(container);
    expect(wrapper.style.width).toBe("400px");
    expect(wrapper.style.height).toBe("600px");
  });

  it("self-loads the viewport when no entry exists and reports it back", async () => {
    const onViewportLoaded = vi.fn();
    const { container, pdf } = renderPage({
      pageViewport: null,
      scale: 1.5,
      onViewportLoaded,
    });

    await waitFor(() => {
      expect(onViewportLoaded).toHaveBeenCalledWith(
        1,
        { width: 150, height: 300, scale: 1.5 },
        1.5
      );
    });
    expect(pdf.getPage).toHaveBeenCalledWith(1);

    const wrapper = getWrapper(container);
    await waitFor(() => {
      expect(wrapper.style.width).toBe("150px");
      expect(wrapper.style.height).toBe("300px");
    });
  });

  it("does not self-load when a manager entry exists", async () => {
    const { pdf } = renderPage({
      pageViewport: { width: 200, height: 300, scale: 1.5 },
      scale: 1.5,
    });

    // Give any (unexpected) async work a chance to run.
    await new Promise((r) => setTimeout(r, 30));
    expect(pdf.getPage).not.toHaveBeenCalled();
  });
});

describe("PdfPage rendering resources", () => {
  beforeEach(() => {
    // jsdom has no 2d canvas backend; stub just enough for the render effect.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls page.cleanup() after a successful render", async () => {
    // Rendering holds fonts/images/operator-list on the page proxy; releasing
    // them after render keeps long documents from accumulating per-page
    // resources (pdfTools parity).
    const { pdf } = renderPage({
      shouldRender: true,
      pageViewport: { width: 200, height: 300, scale: 1.5 },
      scale: 1.5,
    });

    await waitFor(() => {
      expect(pdf.page.render).toHaveBeenCalled();
      expect(pdf.page.cleanup).toHaveBeenCalled();
    });
  });

  it("zeroes the canvas bitmap when the page leaves the render window", async () => {
    // Offscreen pages used to keep their full (DPR-scaled) canvas bitmap
    // resident. Scrolling the page out of the render window must free it;
    // the wrapper keeps its size via the controlled style prop.
    const { container, pdf, rerender } = renderPage({
      shouldRender: true,
      pageViewport: { width: 200, height: 300, scale: 1.5 },
      scale: 1.5,
    });

    const canvas = container.querySelector("canvas");
    if (!canvas) throw new Error("canvas not found");
    await waitFor(() => {
      expect(canvas.width).toBeGreaterThan(0);
    });
    // Let the post-render chain (textContent → hasRenderedRef) settle.
    await new Promise((r) => setTimeout(r, 0));

    rerender(
      <PdfPage
        pdf={pdf as never}
        pageNum={1}
        scale={1.5}
        shouldRender={false}
        pageViewport={{ width: 200, height: 300, scale: 1.5 }}
        settings={DEFAULT_SETTINGS}
      />
    );

    await waitFor(() => {
      expect(canvas.width).toBe(0);
      expect(canvas.height).toBe(0);
    });
  });
});
