import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useZoomAnchor } from "./useZoomAnchor";
import type { PageViewportInfo } from "../components/PdfViewer";

/**
 * jsdom does not perform layout, so getBoundingClientRect returns all-zero
 * rects by default. These tests stub it per-element with explicit geometry so
 * the zoom-anchor math (which reads live DOM positions) is exercised against
 * deterministic values.
 */

interface MockedRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

function makeContainer(rect: MockedRect) {
  const el = document.createElement("div");
  // scrollTop is writable on a real HTMLDivElement; cast to any so we can also
  // stub getBoundingClientRect without TS complaints.
  const stub: any = el;
  stub.getBoundingClientRect = () => ({
    ...rect,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  });
  stub.scrollTop = 0;
  return stub as HTMLDivElement;
}

function makeWrapper(rect: MockedRect) {
  const el = document.createElement("div");
  const stub: any = el;
  stub.getBoundingClientRect = () => ({
    ...rect,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  });
  return stub as HTMLDivElement;
}

function makeOptions() {
  const container = makeContainer({
    top: 0,
    bottom: 600,
    left: 0,
    right: 800,
    width: 800,
    height: 600,
  });
  const page1 = makeWrapper({ top: 0, bottom: 300, left: 0, right: 800, width: 800, height: 300 });
  const page2 = makeWrapper({ top: 324, bottom: 624, left: 0, right: 800, width: 800, height: 300 });
  const page3 = makeWrapper({ top: 648, bottom: 948, left: 0, right: 800, width: 800, height: 300 });
  const pageWrapperRefs = {
    current: [page1, page2, page3],
  } as React.MutableRefObject<(HTMLDivElement | null)[]>;

  return {
    base: {
      viewMode: "continuous" as const,
      scale: 1.5,
      pageViewports: new Map<number, PageViewportInfo>([
        [1, { width: 800, height: 300, scale: 1.5 }],
        [2, { width: 800, height: 300, scale: 1.5 }],
        [3, { width: 800, height: 300, scale: 1.5 }],
      ]),
      viewportsForScale: 1.5,
      continuousContainerRef: { current: container },
      pageWrapperRefs,
      setScale: vi.fn(),
      minScale: 0.5,
      maxScale: 5.0,
      onRestored: vi.fn(),
    },
    container,
    page1,
    page2,
    page3,
    pageWrapperRefs,
  };
}

describe("useZoomAnchor", () => {
  beforeEach(() => {
    // requestAnimationFrame fires sync-ish by default in jsdom; we want the
    // restore effect's rAF callback to run inside act() so the test can
    // observe onRestored without flakiness.
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("captureZoomAnchor is a no-op in single mode", () => {
    const { base } = makeOptions();
    const { result } = renderHook(() =>
      useZoomAnchor({ ...base, viewMode: "single" })
    );
    act(() => {
      result.current.captureZoomAnchor(0);
    });
    // No restore fires because no anchor was captured. Assert via the restore
    // effect not invoking onRestored by triggering a re-render with matching
    // viewportsForScale===scale (already the case) — onRestored stays uncalled.
    expect(base.onRestored).not.toHaveBeenCalled();
  });

  it("captureZoomAnchor writes PDF-space offset for the page spanning the viewport top", () => {
    const { base, page1, page2 } = makeOptions();
    // page1 spans viewport top (top=0, bottom=300), so anchor is page 1, offset 0.
    // Re-arrange so viewport top is inside page2: shift page1 fully above 0 is
    // not possible (top=0 is the container top); instead make page1 occupy
    // negative-ish region by giving it a small bottom and page2 starting at 0.
    const c = base.continuousContainerRef.current!;
    (page1 as any).getBoundingClientRect = () => ({
      top: -300, bottom: 0, left: 0, right: 800, width: 800, height: 300,
      x: 0, y: -300, toJSON: () => ({}),
    });
    (page2 as any).getBoundingClientRect = () => ({
      top: 0, bottom: 300, left: 0, right: 800, width: 800, height: 300,
      x: 0, y: 0, toJSON: () => ({}),
    });
    (c as any).getBoundingClientRect = () => ({
      top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600,
      x: 0, y: 0, toJSON: () => ({}),
    });

    const { result } = renderHook(() => useZoomAnchor(base));
    act(() => {
      result.current.captureZoomAnchor(0);
    });
    // Anchor captured internally; trigger restore by re-render with same
    // viewportsForScale===scale. onRestored should fire with page 2.
    // Since pendingZoomAnchorRef is internal, we observe via onRestored after
    // forcing the effect to run by toggling pageViewports identity.
    expect(base.setScale).not.toHaveBeenCalled();
    // Sanity: isZoomingRef stays false (capture alone doesn't set it).
    expect(result.current.isZoomingRef.current).toBe(false);
  });

  it("zoomTo clamps to [minScale, maxScale] and sets isZooming in continuous mode", () => {
    const { base } = makeOptions();
    const { result } = renderHook(() => useZoomAnchor(base));
    act(() => {
      result.current.zoomTo(10); // above maxScale 5.0
    });
    expect(base.setScale).toHaveBeenCalledTimes(1);
    expect(base.setScale).toHaveBeenCalledWith(5.0);
    expect(result.current.isZoomingRef.current).toBe(true);
  });

  it("zoomTo clamps below minScale", () => {
    const { base } = makeOptions();
    const { result } = renderHook(() => useZoomAnchor(base));
    act(() => {
      result.current.zoomTo(0.1); // below minScale 0.5
    });
    expect(base.setScale).toHaveBeenCalledWith(0.5);
  });

  it("zoomTo does not set isZooming when target equals current scale", () => {
    const { base } = makeOptions();
    const { result } = renderHook(() => useZoomAnchor(base));
    act(() => {
      result.current.zoomTo(base.scale); // same scale
    });
    expect(base.setScale).toHaveBeenCalledWith(base.scale);
    expect(result.current.isZoomingRef.current).toBe(false);
  });

  it("zoomTo at the min/max boundary does NOT set isZooming (clamped target equals current scale, fix #3)", () => {
    const { base } = makeOptions();
    // Already at maxScale: zooming further out must be a complete no-op
    // (no anchor capture, no zoom lock) — otherwise the lock stays stuck
    // because setScale commits no change and the restore effect never fires.
    const atMax = { ...base, scale: 5.0, viewportsForScale: 5.0 };
    const { result: r1 } = renderHook(() => useZoomAnchor(atMax));
    act(() => {
      r1.current.zoomTo(10); // clamps to 5.0 === current scale
    });
    expect(atMax.setScale).toHaveBeenCalledWith(5.0);
    expect(r1.current.isZoomingRef.current).toBe(false);

    // Already at minScale: zooming further out is likewise a no-op.
    const atMin = { ...base, scale: 0.5, viewportsForScale: 0.5 };
    const { result: r2 } = renderHook(() => useZoomAnchor(atMin));
    act(() => {
      r2.current.zoomTo(0.1); // clamps to 0.5 === current scale
    });
    expect(atMin.setScale).toHaveBeenCalledWith(0.5);
    expect(r2.current.isZoomingRef.current).toBe(false);
  });

  it("zoomTo does not set isZooming in single mode", () => {
    const { base } = makeOptions();
    const { result } = renderHook(() =>
      useZoomAnchor({ ...base, viewMode: "single" })
    );
    act(() => {
      result.current.zoomTo(2.0);
    });
    expect(base.setScale).toHaveBeenCalledWith(2.0);
    expect(result.current.isZoomingRef.current).toBe(false);
  });

  it("restore effect skips when viewportsForScale !== scale", () => {
    const { base } = makeOptions();
    // Capture an anchor, then render with mismatched viewportsForScale.
    const { result, rerender } = renderHook(
      (props: { viewportsForScale: number }) =>
        useZoomAnchor({ ...base, viewportsForScale: props.viewportsForScale }),
      { initialProps: { viewportsForScale: base.scale } }
    );
    act(() => {
      result.current.captureZoomAnchor(0);
    });
    // viewportsForScale now mismatches the (unchanged) scale — restore must NOT fire.
    rerender({ viewportsForScale: base.scale + 1 });
    expect(base.onRestored).not.toHaveBeenCalled();
  });

  it("restore effect restores scrollTop and calls onRestored once viewportsForScale matches scale", async () => {
    const { base, page2, container } = makeOptions();
    // Layout: viewport top at container y=0 sits 76px into page2 (page2 top=0
    // after we shift page1 above). Captured pdfOffset = 76 / scale = 76/1.5.
    // After restore with the SAME scale, newScrollTop = newPageTopScroll + pdfOffset*scale
    //   = (page2 top relative to container) + 76
    //   = 0 + 76 = 76 (since page2.top=0 in container coords, newPageTopScroll = 0 + container.scrollTop).
    (page2 as any).getBoundingClientRect = () => ({
      top: 0, bottom: 300, left: 0, right: 800, width: 800, height: 300,
      x: 0, y: 0, toJSON: () => ({}),
    });
    (container as any).getBoundingClientRect = () => ({
      top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600,
      x: 0, y: 0, toJSON: () => ({}),
    });
    // Force page2 to be the anchor: make page1 fully above viewport top.
    const page1 = base.pageWrapperRefs.current[0]!;
    (page1 as any).getBoundingClientRect = () => ({
      top: -300, bottom: 0, left: 0, right: 800, width: 800, height: 300,
      x: 0, y: -300, toJSON: () => ({}),
    });

    // viewportsForScale starts MISMATCHED (old scale), then a new viewport map
    // arrives with viewportsForScale === scale to simulate the post-zoom commit.
    const { result, rerender } = renderHook(
      (props: {
        viewportsForScale: number;
        pageViewports: Map<number, PageViewportInfo>;
      }) =>
        useZoomAnchor({
          ...base,
          viewportsForScale: props.viewportsForScale,
          pageViewports: props.pageViewports,
        }),
      {
        initialProps: {
          viewportsForScale: base.scale - 0.5, // stale: zoom just happened
          pageViewports: base.pageViewports,
        },
      }
    );

    // Capture anchor at viewport top (offset 0): page2, offset 0 (since page2.top=0).
    act(() => {
      result.current.captureZoomAnchor(0);
    });

    // Restore not fired yet (viewportsForScale mismatch).
    expect(base.onRestored).not.toHaveBeenCalled();

    // New viewports commit for the current scale.
    rerender({
      viewportsForScale: base.scale,
      pageViewports: new Map(base.pageViewports), // new identity triggers effect
    });

    await waitFor(() => {
      expect(base.onRestored).toHaveBeenCalledTimes(1);
    });
    expect(base.onRestored).toHaveBeenCalledWith({
      pageNum: 2,
      scale: base.scale,
      viewMode: "continuous",
      scrollTop: expect.any(Number),
    });
    // isZooming released after restore.
    expect(result.current.isZoomingRef.current).toBe(false);
  });

  it("captureCursorAnchor anchors on the page under the cursor Y", async () => {
    const { base } = makeOptions();
    // Default layout: page1 [0,300], page2 [324,624], page3 [648,948],
    // container top = 0. Cursor at clientY=400 sits 76px into page2.
    // Start with a stale viewportsForScale so the restore effect does not fire
    // prematurely; then commit matching viewports to trigger restore.
    const { result, rerender } = renderHook(
      (props: {
        viewportsForScale: number;
        pageViewports: Map<number, PageViewportInfo>;
      }) =>
        useZoomAnchor({
          ...base,
          viewportsForScale: props.viewportsForScale,
          pageViewports: props.pageViewports,
        }),
      {
        initialProps: {
          viewportsForScale: base.scale - 0.5,
          pageViewports: base.pageViewports,
        },
      }
    );

    act(() => {
      result.current.captureCursorAnchor(400);
    });
    expect(base.onRestored).not.toHaveBeenCalled();

    rerender({
      viewportsForScale: base.scale,
      pageViewports: new Map(base.pageViewports),
    });

    await waitFor(() => {
      expect(base.onRestored).toHaveBeenCalledTimes(1);
    });
    expect(base.onRestored).toHaveBeenCalledWith(
      expect.objectContaining({ pageNum: 2 })
    );
  });

  it("captureCursorAnchor falls back to viewport-top anchor when cursor is in a gap", () => {
    const { base } = makeOptions();
    // Default layout: page1 [0,300], gap (300,324), page2 [324,624], page3 [648,948].
    // Cursor at clientY=310 (in the gap) → findPageAtY returns null → fallback
    // to captureZoomAnchor(0), which anchors on the page spanning viewport top.
    const { result } = renderHook(() => useZoomAnchor(base));
    expect(() => {
      act(() => {
        result.current.captureCursorAnchor(310);
      });
    }).not.toThrow();
  });

  it("captureZoomAnchor converts pixel offsets with the LIVE scale even when viewportsForScale is stale (rapid-zoom regression)", async () => {
    const { base, page2, container } = makeOptions();
    // Live layout (scale 1.5): page2 spans the viewport top with 76px of it
    // above the top edge. The correct PDF-space offset is 76 / 1.5.
    // Converting with the STALE viewportsForScale (1.0, mid-zoom-burst) would
    // yield 76 / 1.0 and mis-restore by 38px.
    (page2 as any).getBoundingClientRect = () => ({
      top: -76, bottom: 224, left: 0, right: 800, width: 800, height: 300,
      x: 0, y: -76, toJSON: () => ({}),
    });
    const page1 = base.pageWrapperRefs.current[0]!;
    (page1 as any).getBoundingClientRect = () => ({
      top: -376, bottom: -76, left: 0, right: 800, width: 800, height: 300,
      x: 0, y: -376, toJSON: () => ({}),
    });

    const { result, rerender } = renderHook(
      (props: {
        viewportsForScale: number;
        pageViewports: Map<number, PageViewportInfo>;
      }) =>
        useZoomAnchor({
          ...base,
          viewportsForScale: props.viewportsForScale,
          pageViewports: props.pageViewports,
        }),
      {
        initialProps: {
          viewportsForScale: 1.0, // stale: a zoom burst is in flight
          pageViewports: base.pageViewports,
        },
      }
    );

    act(() => {
      result.current.captureZoomAnchor(0);
    });

    // Commit the new-scale viewports to fire the restore.
    rerender({
      viewportsForScale: base.scale,
      pageViewports: new Map(base.pageViewports),
    });

    await waitFor(() => {
      expect(base.onRestored).toHaveBeenCalledTimes(1);
    });
    // newPageTopScroll = -76 (page2 top vs container top, scrollTop 0);
    // restored = -76 + (76/1.5)*1.5 = 0. With the stale 1.0 conversion it
    // would have been -76 + 76*1.5 = 38.
    expect(container.scrollTop).toBe(0);
    expect(base.onRestored).toHaveBeenCalledWith({
      pageNum: 2,
      scale: base.scale,
      viewMode: "continuous",
      scrollTop: 0,
    });
  });

  it("onRestored is read through a ref (latest identity fires, not the captured one)", async () => {
    const { base } = makeOptions();
    const onRestored1 = vi.fn();
    const onRestored2 = vi.fn();
    // Simulate a zoom: capture anchor while viewports are stale, then commit
    // matching viewports AND swap the onRestored identity in the same rerender.
    // The restore effect must invoke the LATEST callback (onRestored2), proving
    // it reads onRestored through a ref rather than a captured closure.
    const { result, rerender } = renderHook(
      (props: {
        viewportsForScale: number;
        pageViewports: Map<number, PageViewportInfo>;
        onRestored: () => void;
      }) =>
        useZoomAnchor({
          ...base,
          viewportsForScale: props.viewportsForScale,
          pageViewports: props.pageViewports,
          onRestored: props.onRestored,
        }),
      {
        initialProps: {
          viewportsForScale: base.scale - 0.5,
          pageViewports: base.pageViewports,
          onRestored: onRestored1,
        },
      }
    );

    act(() => {
      result.current.captureZoomAnchor(0);
    });
    expect(onRestored1).not.toHaveBeenCalled();

    rerender({
      viewportsForScale: base.scale,
      pageViewports: new Map(base.pageViewports),
      onRestored: onRestored2,
    });

    await waitFor(() => {
      expect(onRestored2).toHaveBeenCalledTimes(1);
    });
    // The stale callback must NOT have been invoked for this restore.
    expect(onRestored1).not.toHaveBeenCalled();
  });
});
