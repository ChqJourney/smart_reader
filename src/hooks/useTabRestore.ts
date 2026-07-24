import { useEffect, useRef } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PageViewportInfo } from "./useViewportManager";

/**
 * Restores the viewer's page / scale / viewMode / scrollTop when a tab becomes
 * active, and executes any pending page navigation once the PDF is loaded and
 * the target page's viewport is known.
 *
 * Extraction rationale (see docs/REFACTOR_PLAN.md phase 3 / #3.4): the tab
 * sync effect and the pendingGotoPage effect were ~90 lines inside PdfViewer,
 * sharing three refs (pendingGotoPageRef / pendingScrollTopRef /
 * hasRestoredRef). Centralizing them makes the "restore exactly once per mount"
 * invariant explicit and keeps the viewer free of restore plumbing.
 *
 * Design notes:
 * - PdfViewer is remounted on tab switch via `key={tab.id}`, so each fresh
 *   instance restores its tab's scroll position exactly once.
 *   `hasRestoredRef` guards ONLY that scrollTop restore (a stale scrollTop
 *   re-applied on effect re-runs would snap the container back to an old
 *   position). Pending page jumps are NOT gated on it: goto requests can
 *   target the already-active tab (no remount), and those arrive after the
 *   mount restore has completed (docs/REFACTOR_REVIEW_2026-07-17.md #4).
 * - The mount-time application of initialState.pageNum/scale/viewMode runs
 *   EXACTLY ONCE (didInitRef). After that the viewer is the source of truth:
 *   the tab record round-trips through onStateChange, and re-applying it on
 *   every record change stomps newer viewer state with stale record values —
 *   e.g. right after onClearPendingGotoPage re-triggers the sync effect, a
 *   record clobbered mid-restore would reset the viewer back to page 1.
 * - While a mount restore is pending, the shared jump lock (isJumpingRef) is
 *   HELD so the scroll page-sync cannot recompute pageNum from the
 *   not-yet-restored DOM (scrollTop=0 → page 1) and clobber the tab record.
 *   This was the "switching tabs sometimes resets to page 1" bug: on Windows
 *   the appearing scrollbar reliably fires the ResizeObserver inside the
 *   restore window; switching away again before self-healing froze the record
 *   at page 1.
 * - The pending page jump waits until viewports for ALL pages up to the target
 *   are known, so the continuous-mode jump uses exact viewport accumulation
 *   instead of DOM geometry measured against 400px placeholders (large docs).
 * - scrollTop restoration is the single inbound path; outbound reporting lives
 *   in PdfViewer's onStateChange effect (pageNum/scale/viewMode) and
 *   useScrollPageSync's debounced scrollTop report.
 */
export interface UseTabRestoreOptions {
  initialState?:
    | (Partial<{
        pageNum: number;
        scale: number;
        viewMode: "single" | "continuous";
        scrollTop?: number;
        pendingGotoPage?: number;
      }> & { scrollTop?: number })
    | undefined;
  pdf: PDFDocumentProxy | null;
  numPages: number;
  isLoading: boolean;
  viewMode: "single" | "continuous";
  pageViewports: Map<number, PageViewportInfo>;
  tabId?: string;
  /** Navigate to a page (PdfViewer's goToPage). */
  goToPage: (page: number) => void;
  onClearPendingGotoPage?: (tabId: string) => void;
  continuousContainerRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Shared jump-suppression lock (owned by PdfViewer, consumed by
   * useScrollPageSync). Held while a mount-time restore is pending so
   * scroll/resize events in the restore window cannot make the scroll
   * page-sync recompute pageNum from the not-yet-restored DOM and clobber the
   * tab record with page 1.
   */
  isJumpingRef: React.MutableRefObject<boolean>;
  /**
   * 挂载恢复（含 scrollTop 回写）完成时触发一次。PdfViewer 的
   * autoFitToWidth 依赖它排序：必须先恢复滚动位置再 fit-to-width，
   * 否则缩放锚点会按 scrollTop=0 捕获到第 1 页。
   */
  onMountRestored?: () => void;
  setPageNum: React.Dispatch<React.SetStateAction<number>>;
  setScale: React.Dispatch<React.SetStateAction<number>>;
  setViewMode: React.Dispatch<
    React.SetStateAction<"single" | "continuous">
  >;
}

/** True when viewports for every page in [1, page] are known. */
function hasViewportsUpTo(
  pageViewports: Map<number, PageViewportInfo>,
  page: number
): boolean {
  for (let p = 1; p <= page; p++) {
    if (!pageViewports.has(p)) return false;
  }
  return true;
}

export function useTabRestore(options: UseTabRestoreOptions): void {
  const {
    initialState,
    pdf,
    numPages,
    isLoading,
    viewMode,
    pageViewports,
    tabId,
    goToPage,
    onClearPendingGotoPage,
    continuousContainerRef,
    isJumpingRef,
    onMountRestored,
    setPageNum,
    setScale,
    setViewMode,
  } = options;

  const pendingGotoPageRef = useRef<number | undefined>(
    initialState?.pendingGotoPage
  );
  const pendingScrollTopRef = useRef<number | undefined>(
    initialState?.scrollTop
  );
  // Restoration of page/scroll position must run at most once per mount.
  const hasRestoredRef = useRef(false);
  // initialState's page/scale/viewMode must be applied only once per mount;
  // afterwards the viewer owns these values (see the hook doc comment).
  const didInitRef = useRef(false);

  // Sync state when switching tabs (initialState changes).
  useEffect(() => {
    if (!didInitRef.current) {
      didInitRef.current = true;
      if (initialState?.pageNum !== undefined) setPageNum(initialState.pageNum);
      if (initialState?.scale !== undefined) setScale(initialState.scale);
      if (initialState?.viewMode !== undefined)
        setViewMode(initialState.viewMode);
    }
    pendingGotoPageRef.current = initialState?.pendingGotoPage;
    pendingScrollTopRef.current = initialState?.scrollTop;
  }, [
    initialState?.pageNum,
    initialState?.scale,
    initialState?.viewMode,
    initialState?.pendingGotoPage,
    initialState?.scrollTop,
    setPageNum,
    setScale,
    setViewMode,
  ]);

  // Execute any pending page navigation once the PDF is loaded and the target
  // page viewport is known. This is used both at mount (tab-switch restore)
  // and afterwards (goto requests targeting the ALREADY-ACTIVE tab — e.g.
  // clicking a stash/annotation in the side panel — which change
  // initialState.pendingGotoPage without remounting the viewer). The pending
  // goto is therefore intentionally NOT gated on hasRestoredRef; only the
  // scrollTop restore is (applying a stale scrollTop after mount would snap
  // the user back to an old position, and after a goto it would override the
  // navigation target). See docs/REFACTOR_REVIEW_2026-07-17.md #4.
  useEffect(() => {
    if (!pdf || numPages === 0 || isLoading) {
      // Document not ready: keep the scroll page-sync suppressed so a stray
      // scroll/resize in the load window can't clobber the tab record.
      if (!hasRestoredRef.current) isJumpingRef.current = true;
      return;
    }

    const pending = pendingGotoPageRef.current;
    if (pending !== undefined && tabId) {
      // Wait until viewports for EVERY page up to the target are known, so the
      // continuous-mode jump uses exact viewport accumulation instead of DOM
      // geometry measured against not-yet-loaded placeholder heights.
      // (Clamped to numPages: a stale target beyond the document end would
      // otherwise wait forever for entries that can never arrive.)
      const ready =
        viewMode === "single" ||
        hasViewportsUpTo(pageViewports, Math.min(pending, numPages));
      if (!ready) {
        isJumpingRef.current = true;
        return;
      }
      goToPage(pending);
      onClearPendingGotoPage?.(tabId);
      pendingGotoPageRef.current = undefined;
      if (viewMode === "single") {
        // goToPage manages the jump lock only in continuous mode; release the
        // restore-window lock here (next frame, so the lock outlives this
        // effect pass).
        requestAnimationFrame(() => {
          isJumpingRef.current = false;
        });
      }
      // In continuous mode goToPage holds the lock around its own scroll and
      // releases it once the jump settles, so nothing more is needed here.
      if (!hasRestoredRef.current) {
        // Mount-time restore only: land on the exact scroll offset saved
        // for this tab, not just the page top. The gate above guarantees all
        // page heights are known, so scrollHeight is final and scrollTop is
        // not clamped.
        const savedScrollTop = pendingScrollTopRef.current;
        if (
          viewMode === "continuous" &&
          savedScrollTop !== undefined &&
          continuousContainerRef.current
        ) {
          continuousContainerRef.current.scrollTop = savedScrollTop;
        }
        pendingScrollTopRef.current = undefined;
        hasRestoredRef.current = true;
        onMountRestored?.();
      }
      return;
    }

    // No pending page jump: restore the exact continuous-scroll position
    // stored for this tab (mount-time, once).
    if (hasRestoredRef.current) return;
    // Wait until every page height is known: the saved scrollTop was captured
    // against fully-sized content, and applying it while pages above still
    // have placeholder heights would land at (or clamp to) the wrong spot.
    if (
      viewMode === "continuous" &&
      !hasViewportsUpTo(pageViewports, numPages)
    ) {
      isJumpingRef.current = true;
      return;
    }
    const scrollTop = pendingScrollTopRef.current;
    if (
      scrollTop !== undefined &&
      viewMode === "continuous" &&
      continuousContainerRef.current
    ) {
      continuousContainerRef.current.scrollTop = scrollTop;
      // Release the restore-window lock on the next frame so the scroll event
      // fired by applying scrollTop above is still suppressed by it.
      requestAnimationFrame(() => {
        isJumpingRef.current = false;
      });
    } else {
      // Nothing was applied (no saved position): no scroll event to swallow,
      // so the lock can be released synchronously — otherwise the first
      // scroll after the restore would be swallowed by the rAF delay.
      isJumpingRef.current = false;
    }
    pendingScrollTopRef.current = undefined;
    hasRestoredRef.current = true;
    onMountRestored?.();
  }, [
    pdf,
    numPages,
    isLoading,
    viewMode,
    pageViewports,
    tabId,
    goToPage,
    onClearPendingGotoPage,
    continuousContainerRef,
    isJumpingRef,
    onMountRestored,
    // Re-run when a NEW pending goto arrives for the already-mounted viewer
    // (active-tab stash/annotation navigation).
    initialState?.pendingGotoPage,
  ]);
}
