import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  useViewportManager,
  type PageViewportInfo,
} from "./useViewportManager";

/**
 * Mock pdfjs PDFDocumentProxy. Each page's getViewport({scale}) returns
 * deterministic width/height so the preload math is testable.
 */

function makePage(baseHeight: number) {
  return {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: 200 * scale,
      height: baseHeight * scale,
      scale,
    })),
  };
}

function makePdf(numPages: number, heightFn: (p: number) => number = () => 300) {
  const pages = Array.from({ length: numPages }, (_, i) =>
    makePage(heightFn(i + 1))
  );
  return {
    getPage: vi.fn(async (p: number) => pages[p - 1]),
    numPages,
    _pages: pages,
  };
}

// Mock the log service so error paths don't touch the real backend.
vi.mock("../services/logs", () => ({
  error: vi.fn(),
}));

interface RenderOpts {
  pdf: ReturnType<typeof makePdf> | null;
  numPages: number;
  scale?: number;
  pageNum?: number;
}

function renderViewport(opts: RenderOpts) {
  return renderHook(
    (props: RenderOpts) =>
      useViewportManager({
        pdf: props.pdf as never,
        numPages: props.numPages,
        scale: props.scale ?? 1.5,
        pageNum: props.pageNum ?? 1,
      }),
    { initialProps: opts }
  );
}

describe("useViewportManager", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preloads every page viewport for small documents (<= threshold)", async () => {
    const pdf = makePdf(3, (p) => 100 * p);
    const { result } = renderViewport({ pdf, numPages: 3 });

    await waitFor(() => {
      expect(result.current.pageViewports.size).toBe(3);
    });

    expect(result.current.pageViewports.get(1)).toEqual({
      width: 200 * 1.5,
      height: 100 * 1.5,
      scale: 1.5,
    });
    expect(result.current.pageViewports.get(2)).toEqual({
      width: 200 * 1.5,
      height: 200 * 1.5,
      scale: 1.5,
    });
    expect(result.current.pageViewports.get(3)).toEqual({
      width: 200 * 1.5,
      height: 300 * 1.5,
      scale: 1.5,
    });
    expect(result.current.viewportsForScale).toBe(1.5);
    expect(result.current.isReady).toBe(true);
  });

  it("only preloads visible + adjacent + first + current for large documents", async () => {
    const pdf = makePdf(100);
    const { result } = renderViewport({ pdf, numPages: 100, pageNum: 50 });

    // No viewports yet (async).
    expect(result.current.pageViewports.size).toBe(0);

    // Simulate IO reporting pages 48-52 visible.
    act(() => {
      [48, 49, 50, 51, 52].forEach((p) =>
        result.current.setPageVisible(p, 0.5)
      );
    });

    await waitFor(() => {
      // visible(48-52) + adjacent(47,53) + first(1) + current(50, already in)
      // = {1, 47, 48, 49, 50, 51, 52, 53}
      expect(result.current.pageViewports.size).toBeGreaterThanOrEqual(8);
    });

    expect(result.current.pageViewports.has(1)).toBe(true);
    expect(result.current.pageViewports.has(47)).toBe(true);
    expect(result.current.pageViewports.has(50)).toBe(true);
    expect(result.current.pageViewports.has(53)).toBe(true);
    // Pages far from the viewport must NOT be preloaded.
    expect(result.current.pageViewports.has(80)).toBe(false);
  });

  it("ensureViewport loads a missing page on demand (fix 9.4)", async () => {
    const pdf = makePdf(100);
    const { result } = renderViewport({ pdf, numPages: 100, pageNum: 50 });

    // Page 75 is far from any preloaded window.
    expect(result.current.pageViewports.has(75)).toBe(false);

    let loaded: PageViewportInfo | null = null;
    await act(async () => {
      loaded = await result.current.ensureViewport(75);
    });

    expect(loaded).not.toBeNull();
    expect(loaded).toEqual({ width: 200 * 1.5, height: 300 * 1.5, scale: 1.5 });
    expect(result.current.pageViewports.has(75)).toBe(true);
    expect(pdf.getPage).toHaveBeenCalledWith(75);
  });

  it("ensureViewport de-duplicates concurrent loads for the same page", async () => {
    const pdf = makePdf(100);
    const { result } = renderViewport({ pdf, numPages: 100, pageNum: 1 });

    // Two concurrent ensureViewport calls for the same missing page.
    let p1: PageViewportInfo | null = null;
    let p2: PageViewportInfo | null = null;
    await act(async () => {
      const a = result.current.ensureViewport(42);
      const b = result.current.ensureViewport(42);
      [p1, p2] = await Promise.all([a, b]);
    });

    expect(p1).toEqual(p2);
    expect(p1).not.toBeNull();
    // getPage must have been called at most once for page 42 (the preload
    // effect may have touched other pages, but 42 is far from page 1).
    const callsFor42 = pdf.getPage.mock.calls.filter((c) => c[0] === 42);
    expect(callsFor42.length).toBe(1);
  });

  it("ensureViewport returns the existing entry when already loaded for current scale", async () => {
    const pdf = makePdf(3, (p) => 100 * p);
    const { result } = renderViewport({ pdf, numPages: 3 });

    await waitFor(() => expect(result.current.pageViewports.size).toBe(3));
    const before = pdf.getPage.mock.calls.length;

    let loaded: PageViewportInfo | null = null;
    await act(async () => {
      loaded = await result.current.ensureViewport(2);
    });

    expect(loaded).toEqual({ width: 200 * 1.5, height: 200 * 1.5, scale: 1.5 });
    // No additional getPage call when the entry is already present & ready.
    expect(pdf.getPage.mock.calls.length).toBe(before);
  });

  it("ensureViewport returns null when pdf is null", async () => {
    const { result } = renderViewport({ pdf: null, numPages: 10 });
    let loaded: PageViewportInfo | null = "sentinel" as never;
    await act(async () => {
      loaded = await result.current.ensureViewport(5);
    });
    expect(loaded).toBeNull();
  });

  it("setPageVisible adds/removes pages from visiblePages", () => {
    const pdf = makePdf(10);
    const { result } = renderViewport({ pdf, numPages: 10 });

    act(() => {
      result.current.setPageVisible(3, 0.5);
      result.current.setPageVisible(4, 0.5);
    });
    expect(result.current.visiblePages.has(3)).toBe(true);
    expect(result.current.visiblePages.has(4)).toBe(true);

    act(() => {
      result.current.setPageVisible(3, 0);
    });
    expect(result.current.visiblePages.has(3)).toBe(false);
    expect(result.current.visiblePages.has(4)).toBe(true);
  });

  it("pageViewports is not cleared on scale change (keeps stale entries as placeholders)", async () => {
    const pdf = makePdf(3, (p) => 100 * p);
    const { result, rerender } = renderViewport({ pdf, numPages: 3 });

    await waitFor(() => expect(result.current.pageViewports.size).toBe(3));

    // Zoom: change scale. The map must retain its old entries (not collapse to
    // 400px placeholders) while the new-scale recompute is in flight.
    rerender({ pdf, numPages: 3, scale: 2.0, pageNum: 1 });
    // Right after the scale change, before the new load settles, old entries
    // are still present and isReady is false.
    expect(result.current.pageViewports.size).toBe(3);
    expect(result.current.isReady).toBe(false);

    await waitFor(() => expect(result.current.isReady).toBe(true));
    // New entries overwrite the old ones at scale 2.0.
    expect(result.current.pageViewports.get(1)).toEqual({
      width: 200 * 2.0,
      height: 100 * 2.0,
      scale: 2.0,
    });
  });

  it("setPageWrapperRef returns a stable callback per page", () => {
    const pdf = makePdf(10);
    const { result, rerender } = renderViewport({ pdf, numPages: 10 });

    const cb1a = result.current.setPageWrapperRef(1);
    rerender({ pdf, numPages: 10 });
    const cb1b = result.current.setPageWrapperRef(1);
    expect(cb1a).toBe(cb1b);

    // The callback writes into pageWrapperRefs at index page-1.
    const el = document.createElement("div");
    act(() => {
      cb1a(el);
    });
    expect(result.current.pageWrapperRefs.current[0]).toBe(el);
  });

  it("rapid scale changes never leave mixed-scale entries (zoom regression)", async () => {
    // Regression test for the "click zoom a few times → pages jump around +
    // mixed widths" bug. Root cause: the preload effect's loadPages did not
    // check a cancelled flag, so a slow load for an OLD scale could still
    // setPageViewports (writing old-scale sizes) and flip viewportsForScale
    // back to the old scale after a newer scale had already committed. This
    // test fires three rapid scale changes and asserts the final state is
    // consistent: every page's entry matches the FINAL scale, and
    // viewportsForScale equals the final scale.
    const pdf = makePdf(3, (p) => 100 * p);
    const { result, rerender } = renderViewport({ pdf, numPages: 3 });

    await waitFor(() => expect(result.current.pageViewports.size).toBe(3));
    expect(result.current.viewportsForScale).toBe(1.5);

    // Fire scale 2.0 then 2.5 then 3.0 in quick succession without waiting
    // for each load to settle — mimics rapid zoom-button clicks.
    rerender({ pdf, numPages: 3, scale: 2.0, pageNum: 1 });
    rerender({ pdf, numPages: 3, scale: 2.5, pageNum: 1 });
    rerender({ pdf, numPages: 3, scale: 3.0, pageNum: 1 });

    await waitFor(() => expect(result.current.isReady).toBe(true), {
      timeout: 3000,
    });

    // Every page must reflect the FINAL scale (3.0), not 2.0 or 2.5.
    expect(result.current.viewportsForScale).toBe(3.0);
    for (let p = 1; p <= 3; p++) {
      const entry = result.current.pageViewports.get(p);
      expect(entry).toBeDefined();
      expect(entry!.width).toBe(200 * 3.0);
      expect(entry!.height).toBe(100 * p * 3.0);
    }
  });

  it("setPageVisible bails out when membership is unchanged (P1)", () => {
    const pdf = makePdf(10);
    const { result } = renderViewport({ pdf, numPages: 10 });

    act(() => {
      result.current.setPageVisible(3, 0.25);
    });
    const afterAdd = result.current.visiblePages;

    // Same page still visible at a different ratio: the Set identity must be
    // preserved so consumers do not re-render per IO threshold crossing.
    act(() => {
      result.current.setPageVisible(3, 0.75);
    });
    expect(result.current.visiblePages).toBe(afterAdd);

    // Same for redundant removals (page already absent).
    act(() => {
      result.current.setPageVisible(9, 0);
    });
    expect(result.current.visiblePages).toBe(afterAdd);

    // A real membership change still allocates a new Set.
    act(() => {
      result.current.setPageVisible(3, 0);
    });
    expect(result.current.visiblePages).not.toBe(afterAdd);
    expect(result.current.visiblePages.has(3)).toBe(false);
  });

  it("keeps Map identity when a reloaded batch has unchanged entries (P2 dedupe)", async () => {
    const pdf = makePdf(3, (p) => 100 * p);
    const { result, rerender } = renderViewport({ pdf, numPages: 3 });

    await waitFor(() => expect(result.current.pageViewports.size).toBe(3));
    const settledMap = result.current.pageViewports;
    const entry1 = settledMap.get(1);

    // Re-trigger the preload effect with the same scale (pageNum dep change):
    // the batch re-fetches but sizes are identical, so the Map AND the entry
    // objects must keep their identity (memoized PdfPage depends on it).
    rerender({ pdf, numPages: 3, scale: 1.5, pageNum: 2 });
    // Allow the re-triggered batch to settle.
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.pageViewports).toBe(settledMap);
    expect(result.current.pageViewports.get(1)).toBe(entry1);
  });

  it("ensureViewport does NOT flip viewportsForScale while a scale batch is in flight (fix #1)", async () => {
    // Controllable getPage: each call parks a resolver so the test decides
    // exactly when the batch vs. the single-page load settle.
    const pending: Array<() => void> = [];
    const pages = [makePage(100), makePage(200), makePage(300)];
    const pdf = {
      getPage: vi.fn(
        (p: number) =>
          new Promise<(typeof pages)[number]>((resolve) => {
            pending.push(() => resolve(pages[p - 1]));
          })
      ),
      numPages: 3,
    };
    const { result, rerender } = renderViewport({
      pdf: pdf as never,
      numPages: 3,
    });

    // Complete the initial preload at scale 1.5.
    await act(async () => {
      pending.splice(0).forEach((r) => r());
    });
    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(result.current.viewportsForScale).toBe(1.5);

    // Zoom to 2.0: the batch starts but its getPage calls are parked.
    rerender({ pdf: pdf as never, numPages: 3, scale: 2.0, pageNum: 1 });
    expect(result.current.isReady).toBe(false);
    expect(pending.length).toBe(3); // batch for pages 1-3 parked

    // ensureViewport(page 2): one more parked call; resolve ONLY it while the
    // batch is still in flight.
    let loaded: PageViewportInfo | null = null;
    await act(async () => {
      const pr = result.current.ensureViewport(2);
      pending.pop()!(); // resolve the ensureViewport getPage(2) only
      loaded = await pr;
    });
    expect(loaded).toEqual({ width: 200 * 2.0, height: 200 * 2.0, scale: 2.0 });
    // The single-page load must NOT mark the map ready: the other entries are
    // still old-scale, and consumers (zoom restore / fit-center) gate on it.
    expect(result.current.viewportsForScale).toBe(1.5);
    expect(result.current.isReady).toBe(false);

    // Readiness arrives only when the batch for scale 2.0 commits.
    await act(async () => {
      pending.splice(0).forEach((r) => r());
    });
    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(result.current.viewportsForScale).toBe(2.0);
  });

  it("reportViewportLoaded merges self-loaded entries in a batched flush without touching viewportsForScale", async () => {
    const pdf = makePdf(100);
    const { result } = renderViewport({ pdf, numPages: 100, pageNum: 1 });

    await waitFor(() => expect(result.current.isReady).toBe(true));
    const readyScale = result.current.viewportsForScale;

    // Page 42 is far outside the preload window.
    expect(result.current.pageViewports.has(42)).toBe(false);

    act(() => {
      result.current.reportViewportLoaded(
        42,
        { width: 300, height: 450, scale: 1.5 },
        1.5
      );
    });

    // Not merged synchronously — the flush is batched (100ms).
    expect(result.current.pageViewports.has(42)).toBe(false);

    await waitFor(() => {
      expect(result.current.pageViewports.get(42)).toEqual({
        width: 300,
        height: 450,
        scale: 1.5,
      });
    });
    // Single-page write-backs must not flip the global readiness flag.
    expect(result.current.viewportsForScale).toBe(readyScale);
  });

  it("reportViewportLoaded drops results computed for a stale scale", async () => {
    const pdf = makePdf(100);
    const { result, rerender } = renderViewport({ pdf, numPages: 100, pageNum: 1 });

    await waitFor(() => expect(result.current.isReady).toBe(true));

    // Zoom to 2.0: reports for the old scale (1.5) must be ignored.
    rerender({ pdf, numPages: 100, scale: 2.0, pageNum: 1 });

    act(() => {
      result.current.reportViewportLoaded(
        43,
        { width: 300, height: 450, scale: 1.5 },
        1.5
      );
      // ...while a report for the live scale is accepted.
      result.current.reportViewportLoaded(
        44,
        { width: 400, height: 600, scale: 2.0 },
        2.0
      );
    });

    await waitFor(() => {
      expect(result.current.pageViewports.get(44)).toEqual({
        width: 400,
        height: 600,
        scale: 2.0,
      });
    });
    expect(result.current.pageViewports.has(43)).toBe(false);
  });

  it("reportViewportLoaded keeps Map identity when the reported sizes are unchanged", async () => {
    const pdf = makePdf(3, (p) => 100 * p);
    const { result } = renderViewport({ pdf, numPages: 3 });

    await waitFor(() => expect(result.current.pageViewports.size).toBe(3));
    const settledMap = result.current.pageViewports;

    act(() => {
      result.current.reportViewportLoaded(
        2,
        { width: 200 * 1.5, height: 200 * 1.5, scale: 1.5 },
        1.5
      );
    });

    // Let the 100ms flush run; identical values must not produce a new Map.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    expect(result.current.pageViewports).toBe(settledMap);
  });
});
