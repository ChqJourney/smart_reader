import { useEffect } from "react";
import type { PageViewportInfo } from "./useViewportManager";

/**
 * Keeps `pageNum` in sync with the visible page while scrolling in continuous
 * mode, and reports the scrollTop to the parent on a debounce.
 *
 * Extraction rationale (see docs/REFACTOR_PLAN.md phase 3 / #3.4): the
 * scroll-listener effect was ~80 lines inside PdfViewer, tightly coupled to
 * `pageNumRef`/`isJumpingRef`/`isZoomingRef`/`pageWrapperRefs` but logically
 * independent of the viewer's rendering. Centralizing it removes the last big
 * non-UI effect from the component and makes the page-detection rules
 * (top-edge-closest, jump/zoom suppression) explicit in one place.
 *
 * Design notes:
 * - `pageNum` is updated IMMEDIATELY on scroll (not debounced). setPageNum uses
 *   a functional update that bails out when the page hasn't changed, so only
 *   cross-page transitions re-render. Debouncing the page update caused tab
 *   switches within the debounce window to capture a stale page (issue 10.1).
 * - `scrollTop` reporting IS debounced (100ms) because it is high-frequency
 *   and less critical than the page number (which the onStateChange effect
 *   already reports via pageNum).
 * - `isJumpingRef` / `isZoomingRef` suppress detection during programmatic
 *   jumps and zoom reflows so `pageNum` does not drift to a different page
 *   before the scroll position settles.
 * - We compute directly from DOM geometry instead of relying on the
 *   asynchronous IntersectionObserver state, which can be stale right after a
 *   jump. The "current" page is the visible page whose top edge is closest to
 *   the viewport top — this matches a page jump and avoids centre-bias.
 */
/**
 * Minimum distance (px) by which a challenger page's top edge must beat the
 * current page's before the current page changes. Without this dead zone the
 * detected page flip-flops between N and N+1 whenever the viewport top sits
 * within a few px of a page boundary — which is exactly where zoom restores
 * and fit-to-width land, causing the "page number keeps changing" jitter.
 * 12px is half the inter-page spacing: small enough to never delay a real
 * page turn, large enough to absorb sub-pixel layout shifts and scroll-
 * anchoring adjustments during zoom reflows.
 */
const PAGE_SWITCH_MARGIN_PX = 12;

export interface UseScrollPageSyncOptions {
  viewMode: "single" | "continuous";
  scale: number;
  onStateChange?: (state: {
    pageNum: number;
    scale: number;
    viewMode: "single" | "continuous";
    scrollTop: number;
  }) => void;
  continuousContainerRef: React.RefObject<HTMLDivElement | null>;
  pageWrapperRefs: React.MutableRefObject<(HTMLDivElement | null)[]>;
  pageNumRef: React.MutableRefObject<number>;
  setPageNum: React.Dispatch<React.SetStateAction<number>>;
  /** Suppress detection during programmatic jumps (goToPage). */
  isJumpingRef: React.MutableRefObject<boolean>;
  /** Suppress detection during zoom reflows (useZoomAnchor). */
  isZoomingRef: React.MutableRefObject<boolean>;
  /**
   * Latest IntersectionObserver ratios per page (from useViewportManager).
   * Pages known to be off-screen are skipped without a DOM read, avoiding
   * O(numPages) getBoundingClientRect calls per scroll event on large
   * documents (docs/REFACTOR_REVIEW_2026-07-17.md P4). Pages with no recorded
   * ratio default to "checked", so cold start and just-jumped states stay
   * correct (page jumps also set pageNum explicitly and suppress this sync).
   */
  pageVisibilityRatios?: React.MutableRefObject<Map<number, number>>;
}

/**
 * @param _pageViewports Kept in the signature for future use (e.g. deterministic
 *   page detection from accumulated viewport heights instead of DOM geometry).
 *   Currently unused; DOM geometry is authoritative because viewports may be
 *   incomplete for large documents.
 */
export function useScrollPageSync(
  options: UseScrollPageSyncOptions,
  _pageViewports?: Map<number, PageViewportInfo>
): void {
  const {
    viewMode,
    scale,
    onStateChange,
    continuousContainerRef,
    pageWrapperRefs,
    pageNumRef,
    setPageNum,
    isJumpingRef,
    isZoomingRef,
    pageVisibilityRatios,
  } = options;

  useEffect(() => {
    if (viewMode !== "continuous") return;
    const container = continuousContainerRef.current;
    if (!container) return;

    let cancelled = false;
    let debounceTimeout: ReturnType<typeof setTimeout> | null = null;

    const computeAndSyncPage = (): number => {
      const container = continuousContainerRef.current;
      if (!container) return pageNumRef.current;
      if (cancelled || isJumpingRef.current || isZoomingRef.current)
        return pageNumRef.current;

      const containerRect = container.getBoundingClientRect();

      const currentPage = pageNumRef.current;
      let bestPage = currentPage;
      let bestDistance = Infinity;
      let currentDistance = Infinity;

      pageWrapperRefs.current.forEach((wrapper, i) => {
        if (!wrapper) return;
        // Skip pages the IntersectionObserver already reported off-screen —
        // avoids one getBoundingClientRect per page per scroll event. Pages
        // with no recorded ratio (?? 1) are still measured.
        if ((pageVisibilityRatios?.current.get(i + 1) ?? 1) <= 0) return;
        const rect = wrapper.getBoundingClientRect();
        // Only consider pages that actually intersect the viewport.
        if (
          rect.bottom <= containerRect.top ||
          rect.top >= containerRect.bottom
        )
          return;

        const pageTop = rect.top - containerRect.top;
        const distance = Math.abs(pageTop);

        if (i + 1 === currentPage) {
          currentDistance = distance;
        }
        if (distance < bestDistance) {
          bestDistance = distance;
          bestPage = i + 1;
        }
      });

      // Dead zone: keep the current page unless the challenger is clearly
      // closer to the viewport top (see PAGE_SWITCH_MARGIN_PX). The current
      // page only gets this preference while it actually intersects the
      // viewport (currentDistance !== Infinity).
      if (
        bestPage !== currentPage &&
        currentDistance !== Infinity &&
        currentDistance - bestDistance < PAGE_SWITCH_MARGIN_PX
      ) {
        bestPage = currentPage;
      }

      setPageNum((current) => (current === bestPage ? current : bestPage));
      return bestPage;
    };

    const updateVisiblePage = () => {
      if (cancelled || isJumpingRef.current || isZoomingRef.current) return;
      // Update pageNum IMMEDIATELY. setPageNum uses a functional update that
      // bails out when the page hasn't changed, so only cross-page transitions
      // trigger a re-render. The previous version only called setPageNum
      // inside the 100ms debounce below; its cleanup on unmount cancelled the
      // pending update, so switching tabs within that window left tab.pageNum
      // stale and the viewer restored to the wrong page on return (issue 10.1).
      const bestPage = computeAndSyncPage();
      // Debounce only the scrollTop reporting (high-frequency, less critical
      // than the page number which is already reported via the onStateChange
      // effect reacting to pageNum).
      if (debounceTimeout) clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(() => {
        requestAnimationFrame(() => {
          const container = continuousContainerRef.current;
          if (container) {
            onStateChange?.({
              pageNum: bestPage,
              scale,
              viewMode,
              scrollTop: container.scrollTop,
            });
          }
        });
      }, 100);
    };

    container.addEventListener("scroll", updateVisiblePage);
    // Also recompute when the container is resized.
    const resizeObserver = new ResizeObserver(updateVisiblePage);
    resizeObserver.observe(container);

    return () => {
      cancelled = true;
      if (debounceTimeout) clearTimeout(debounceTimeout);
      container.removeEventListener("scroll", updateVisiblePage);
      resizeObserver.disconnect();
    };
  }, [
    viewMode,
    scale,
    onStateChange,
    continuousContainerRef,
    pageWrapperRefs,
    pageNumRef,
    setPageNum,
    isJumpingRef,
    isZoomingRef,
    pageVisibilityRatios,
  ]);
}
