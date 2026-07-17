import { describe, it, expect, vi } from "vitest";
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
  return {
    getPage: vi.fn(async () => ({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 100 * scale,
        height: 200 * scale,
        scale,
      }),
      render: () => ({ promise: Promise.resolve() }),
      getTextContent: () => Promise.resolve({ items: [] }),
      getAnnotations: () => Promise.resolve([]),
    })),
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
      shouldRender={false}
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
