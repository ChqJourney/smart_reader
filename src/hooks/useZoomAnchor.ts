import { useCallback, useEffect, useRef } from "react";
import {
  findPageAtY,
  findTopVisiblePage,
  toPdfOffset,
  computeRestoredScrollTop,
  type PageRect,
} from "../utils/zoomAnchor";
import type { PageViewportInfo } from "../components/PdfViewer";

/**
 * State payload delivered to `onRestored` once the zoom reflow settles. Mirrors
 * the shape PdfViewer reports to its parent via `onStateChange` so the caller
 * can forward it verbatim.
 */
export interface ZoomRestoredState {
  pageNum: number;
  scale: number;
  viewMode: "single" | "continuous";
  scrollTop: number;
}

export interface UseZoomAnchorOptions {
  viewMode: "single" | "continuous";
  /** Current (live) scale. Used to gate the restore effect. */
  scale: number;
  /**
   * Page viewport map. Mutated by the viewport-preload effect elsewhere; here
   * it is only a dependency that re-triggers the restore effect once new-scale
   * entries land.
   */
  pageViewports: Map<number, PageViewportInfo>;
  /** Scale for which `pageViewports` currently holds entries. */
  viewportsForScale: number;
  continuousContainerRef: React.RefObject<HTMLDivElement | null>;
  pageWrapperRefs: React.MutableRefObject<(HTMLDivElement | null)[]>;
  setScale: React.Dispatch<React.SetStateAction<number>>;
  minScale: number;
  maxScale: number;
  /**
   * Fired after the scroll position has been restored to the captured anchor
   * point. Invoked inside a `requestAnimationFrame` so the zoom lock release
   * and the parent report happen after the DOM commit, mirroring the original
   * inline effect's behavior.
   */
  onRestored?: (state: ZoomRestoredState) => void;
}

export interface UseZoomAnchorResult {
  /**
   * Apply a new scale, clamped to [minScale, maxScale]. In continuous mode the
   * document point currently under the viewport top is captured first so the
   * restore effect can keep it under the viewport top after the reflow.
   *
   * @param anchorViewportOffsetPx When > 0 (Ctrl+wheel), the anchor point is
   *   restored under the cursor at this viewport-relative offset instead of
   *   at the viewport top (0).
   */
  zoomTo: (target: number, anchorViewportOffsetPx?: number) => void;
  /** Capture the viewport-top anchor (button zoom). No-op in single mode. */
  captureZoomAnchor: (anchorViewportOffsetPx: number) => void;
  /**
   * Capture the page under a screen Y (cursor). Falls back to the viewport-top
   * anchor when the cursor is not over any page (e.g. in a margin).
   */
  captureCursorAnchor: (clientY: number) => void;
  /** Suppress scroll-driven page detection while a zoom reflow is in flight. */
  isZoomingRef: React.MutableRefObject<boolean>;
}

/**
 * Owns zoom scroll-anchoring: capture a document point in PDF-space before a
 * scale change, then restore it under the viewport top (button zoom) or under
 * the cursor (Ctrl+wheel) once the new layout commits.
 *
 * Extraction rationale (see docs/REFACTOR_PLAN.md #14): the capture/restore
 * pair plus the `isZoomingRef` suppression flag form one cohesive concern and
 * were spread across four spots in PdfViewer. Centralizing them removes a
 * class of subtle ordering bugs (anchor captured against the wrong scale,
 * restore racing the viewport commit) and lets the viewer drop ~80 lines.
 *
 * Design notes:
 * - `scale` is read through a ref inside the capture callbacks so they do not
 *   rebuild on every scale change. The original code rebuilt `captureZoomAnchor`
 *   on scale change, which in turn rebuilt `zoomTo` and the wheel effect's
 *   listener. The ref version is behavior-equivalent (captures read the latest
 *   committed scale via an effect-synced ref) but keeps the dependency graphs
 *   shallow — exactly the "effect chain decoupling" goal of phase 2.
 * - `onRestored` is also ref-held so callers can pass an inline closure without
 *   triggering restore-effect re-runs.
 * - The restore effect still gates on `viewportsForScale === scale` (the
 *   preload batch for the new scale has committed). Wrapper geometry itself is
 *   exact earlier than that — PdfPage rescales stale entries to the live scale
 *   at render time — but keeping the batch gate preserves a single, well-tested
 *   "layout settled" signal shared with the fit-center effect.
 */
export function useZoomAnchor(
  options: UseZoomAnchorOptions
): UseZoomAnchorResult {
  const {
    viewMode,
    scale,
    pageViewports,
    viewportsForScale,
    continuousContainerRef,
    pageWrapperRefs,
    setScale,
    minScale,
    maxScale,
    onRestored,
  } = options;

  // Zoom scroll-anchor: captured in PDF-space before a scale change so the
  // same document point can be restored under the viewport top (button zoom)
  // or under the cursor (Ctrl+wheel) once the new layout settles.
  const pendingZoomAnchorRef = useRef<{
    page: number;
    pdfOffset: number;
    anchorViewportOffsetPx: number;
  } | null>(null);

  // Suppress scroll-driven page detection while a zoom reflow is in progress
  // so `pageNum` does not drift to a different page before the scroll
  // position is restored.
  const isZoomingRef = useRef(false);

  // Live refs so callbacks/effects don't depend on the identity of `scale`
  // and `onRestored`.
  const scaleRef = useRef(scale);
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  // Capture math converts live DOM pixel offsets to PDF-space using the LIVE
  // scale: PdfPage rescales stale viewport entries to the live scale at render
  // time, so wrapper geometry ALWAYS reflects the committed `scale` (never the
  // scale `pageViewports` was last committed for). This holds even mid-zoom-
  // burst: the scale commit and the wrapper resize land in the same commit, so
  // a capture issued between two zoom steps reads geometry that matches
  // `scaleRef.current` exactly.
  const onRestoredRef = useRef(onRestored);
  useEffect(() => {
    onRestoredRef.current = onRestored;
  }, [onRestored]);

  // Collect page rectangles (page number + viewport-relative top/bottom) for
  // every rendered page wrapper. Used to locate the anchor page spanning the
  // viewport top (button zoom) or the page under the cursor (Ctrl+wheel).
  const collectPageRects = useCallback((): PageRect[] => {
    const container = continuousContainerRef.current;
    if (!container) return [];
    const containerRect = container.getBoundingClientRect();
    const rects: PageRect[] = [];
    pageWrapperRefs.current.forEach((wrapper, i) => {
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      rects.push({
        page: i + 1,
        top: rect.top - containerRect.top,
        bottom: rect.bottom - containerRect.top,
      });
    });
    return rects;
  }, [continuousContainerRef, pageWrapperRefs]);

  // Capture the document point currently under the viewport top (or under the
  // cursor) in PDF-space so it can be restored after the scale changes. Runs
  // synchronously *before* setScale, while the old layout is still present.
  const captureZoomAnchor = useCallback(
    (anchorViewportOffsetPx: number) => {
      if (viewMode !== "continuous") return;
      const container = continuousContainerRef.current;
      if (!container) return;
      const rects = collectPageRects();
      if (rects.length === 0) return;
      // Page rects are in container-viewport-relative coords (0 = the
      // container's visible top edge), so the viewport top is at offset 0.
      const anchor = findTopVisiblePage(rects, 0);
      if (!anchor) return;
      pendingZoomAnchorRef.current = {
        page: anchor.page,
        pdfOffset: toPdfOffset(anchor.offsetPx, scaleRef.current),
        anchorViewportOffsetPx,
      };
    },
    [viewMode, collectPageRects, continuousContainerRef]
  );

  // Capture the page under a screen Y coordinate (cursor). Used by Ctrl+wheel
  // zoom so the document point under the cursor stays under the cursor across
  // all wheel steps in a burst. Falls back to the viewport-top anchor when the
  // cursor sits in a gap or margin (findPageAtY returns null).
  const captureCursorAnchor = useCallback(
    (clientY: number) => {
      if (viewMode !== "continuous") return;
      const container = continuousContainerRef.current;
      if (!container) return;
      const containerRect = container.getBoundingClientRect();
      const rects: PageRect[] = [];
      pageWrapperRefs.current.forEach((wrapper, i) => {
        if (!wrapper) return;
        const rect = wrapper.getBoundingClientRect();
        rects.push({
          page: i + 1,
          top: rect.top - containerRect.top,
          bottom: rect.bottom - containerRect.top,
        });
      });
      const anchor = findPageAtY(rects, clientY - containerRect.top);
      if (!anchor) {
        // Cursor not over a page (e.g. in a margin): fall back to viewport-top.
        captureZoomAnchor(0);
        return;
      }
      pendingZoomAnchorRef.current = {
        page: anchor.page,
        pdfOffset: toPdfOffset(anchor.offsetPx, scaleRef.current),
        anchorViewportOffsetPx: clientY - containerRect.top,
      };
    },
    [
      viewMode,
      continuousContainerRef,
      pageWrapperRefs,
      captureZoomAnchor,
    ]
  );

  const zoomTo = useCallback(
    (target: number, anchorViewportOffsetPx = 0) => {
      const clamped = Math.max(minScale, Math.min(maxScale, target));
      // Compare the CLAMPED target against the current scale: at the min/max
      // boundary an unclamped comparison (scale !== target) would capture an
      // anchor and set isZoomingRef even though setScale commits no change —
      // the restore effect then never fires, leaving the zoom lock stuck and
      // suppressing scroll page-sync indefinitely (and a later viewport commit
      // would restore the stale anchor mid-scroll). See
      // docs/REFACTOR_REVIEW_2026-07-17.md #3.
      if (viewMode === "continuous" && clamped !== scaleRef.current) {
        captureZoomAnchor(anchorViewportOffsetPx);
        isZoomingRef.current = true;
      }
      setScale(clamped);
    },
    [viewMode, captureZoomAnchor, setScale, minScale, maxScale]
  );

  // Restore the scroll position captured by `captureZoomAnchor` once the new
  // scale's page viewports have been committed. Wrapper sizes are already
  // exact at this point (PdfPage rescales entries to the live scale at render
  // time), so the live DOM read below reflects the post-zoom layout.
  useEffect(() => {
    if (!pendingZoomAnchorRef.current) return;
    // Wait until pageViewports reflects the current scale (the shared
    // "layout settled" signal; see the hook doc comment).
    if (viewportsForScale !== scale) return;
    const { page, pdfOffset, anchorViewportOffsetPx } =
      pendingZoomAnchorRef.current;
    const container = continuousContainerRef.current;
    const wrapper = pageWrapperRefs.current[page - 1];
    if (!container || !wrapper) {
      pendingZoomAnchorRef.current = null;
      isZoomingRef.current = false;
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    const newPageTopScroll =
      wrapperRect.top - containerRect.top + container.scrollTop;
    const newScrollTop = computeRestoredScrollTop(
      newPageTopScroll,
      pdfOffset,
      scale,
      anchorViewportOffsetPx
    );
    container.scrollTop = Math.max(0, newScrollTop);
    pendingZoomAnchorRef.current = null;
    // Release the zoom lock on the next frame so the ResizeObserver-driven
    // page sync does not race the restoration.
    requestAnimationFrame(() => {
      isZoomingRef.current = false;
      onRestoredRef.current?.({
        pageNum: page,
        scale,
        viewMode,
        scrollTop: container.scrollTop,
      });
    });
  }, [
    pageViewports,
    viewportsForScale,
    scale,
    viewMode,
    continuousContainerRef,
    pageWrapperRefs,
  ]);

  return { zoomTo, captureZoomAnchor, captureCursorAnchor, isZoomingRef };
}
