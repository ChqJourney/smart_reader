/* eslint-disable react-refresh/only-export-components */
import { useTranslation } from "react-i18next";
import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  forwardRef,
  useImperativeHandle,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import * as pdfjsLib from "pdfjs-dist";
import { Annotation } from "../services/annotations";
import { AppSettings } from "../services/settings";
import { error as logError } from "../services/logs";
import Icon from "./Icon";
import PdfPage from "./PdfPage";
import {
  computeFitToWidthScale,
  computeCenteredScrollLeft,
} from "../utils/fitToWidth";
import { useSearchDomain } from "../hooks/useSearchDomain";
import { getBasename } from "../utils/path";
import { usePdfDocument, type OutlineItem } from "../hooks/usePdfDocument";
import { useZoomAnchor } from "../hooks/useZoomAnchor";
import { useViewportManager, type PageViewportInfo } from "../hooks/useViewportManager";
import { useScrollPageSync } from "../hooks/useScrollPageSync";
import { useTabRestore } from "../hooks/useTabRestore";
import "./PdfViewer.css";

import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

// PageViewportInfo now lives in useViewportManager (the single source of truth
// for viewport entries). Re-exported here so PdfPage and existing tests can
// keep importing from "./PdfViewer" without churn.
export type { PageViewportInfo } from "../hooks/useViewportManager";

export interface PdfViewerState {
  pageNum: number;
  scale: number;
  viewMode: "single" | "continuous";
  scrollTop?: number;
}

export interface PdfViewerHandle {
  goToPage: (page: number) => void;
}

interface PdfViewerProps {
  tabId?: string;
  filePath: string;
  fileHash?: string;
  cachedBytes?: Uint8Array;
  onPdfLoaded?: (filePath: string, bytes: Uint8Array) => void;
  onSelection?: (
    tabId: string,
    text: string,
    page: number,
    position: {
      x: number;
      y: number;
      pdfX: number;
      pdfY: number;
      width?: number;
      height?: number;
    }
  ) => void;
  onToggleVisibility?: () => void;
  initialState?: Partial<PdfViewerState & { pendingGotoPage?: number }>;
  onStateChange?: (state: PdfViewerState) => void;
  onClearPendingGotoPage?: (tabId: string) => void;
  annotations?: Annotation[];
  highlightedAnnotationId?: string | null;
  onAnnotationUpdate?: (
    id: string,
    patch: Partial<Omit<Annotation, "id">>
  ) => void;
  onAnnotationDelete?: (id: string) => void;
  onExplainClick?: (tabId: string, id: string) => void;
  hoverTranslate?: boolean;
  settings: AppSettings;
  /**
   * 是否为当前焦点屏。分屏时两个 PdfViewer 同时挂载，window 级 keydown
   * （Ctrl+F / 翻页 / 滚动）只应由焦点屏响应，否则两屏同弹搜索条、
   * 方向键同滚两份文档。单视图恒 true（缺省值）。
   */
  isFocused?: boolean;
  /**
   * 挂载恢复完成后自动执行一次 fit-to-width（进入并排模式时 App 对两个
   * 屏都开启）。页码不变：连续模式走 zoomTo 的锚点恢复，锚点页保持在
   * 视口顶部；单页模式 pageNum 本就不受 scale 影响。
   */
  autoFitToWidth?: boolean;
}

const SCROLL_STEP = 80; // px for arrow keys
const CONTAINER_PADDING_TOP = 24; // must match .pdf-canvas-container.continuous padding-top
const PAGE_SPACING = 24; // must match .pdf-page-wrapper margin-bottom

export function computeContinuousScrollTop(
  targetPage: number,
  container: HTMLDivElement,
  getPageWrapper: (page: number) => HTMLDivElement | null | undefined,
  pageViewports: Map<number, PageViewportInfo>,
  scale: number
): number {
  // Entry heights are stored for the entry's own scale; the DOM renders them
  // rescaled to the live scale (see PdfPage), so accumulation must rescale
  // the same way to match the live layout.
  const liveHeight = (vp: PageViewportInfo) =>
    vp.scale === scale ? vp.height : vp.height * (scale / vp.scale);

  // Prefer deterministic viewport accumulation. DOM geometry can be stale or
  // incomplete (e.g. page wrappers not yet sized), causing inaccurate jumps.
  const hasAllViewports = (() => {
    for (let p = 1; p <= targetPage; p++) {
      if (!pageViewports.has(p)) return false;
    }
    return true;
  })();

  if (hasAllViewports) {
    let top = 0;
    for (let i = 1; i < targetPage; i++) {
      const vp = pageViewports.get(i)!;
      top += liveHeight(vp) + PAGE_SPACING;
    }
    return top;
  }

  // Fallback to live DOM geometry when viewport data is incomplete.
  const targetWrapper = getPageWrapper(targetPage);
  if (targetWrapper) {
    const containerRect = container.getBoundingClientRect();
    const targetRect = targetWrapper.getBoundingClientRect();
    return (
      targetRect.top -
      containerRect.top +
      container.scrollTop -
      CONTAINER_PADDING_TOP
    );
  }

  // Last resort: accumulate whatever viewport info we have.
  let top = 0;
  for (let i = 1; i < targetPage; i++) {
    const vp = pageViewports.get(i);
    top += (vp ? liveHeight(vp) : 0) + PAGE_SPACING;
  }
  return top;
}

const PdfViewer = forwardRef<PdfViewerHandle, PdfViewerProps>(
  function PdfViewer(
    {
      tabId,
      filePath,
      fileHash,
      cachedBytes,
      onPdfLoaded,
      onSelection,
      onToggleVisibility,
      initialState,
      onStateChange,
      onClearPendingGotoPage,
      annotations,
      highlightedAnnotationId,
      onAnnotationUpdate,
      onAnnotationDelete,
      onExplainClick,
      hoverTranslate,
      settings,
      isFocused = true,
      autoFitToWidth = false,
    },
    ref
  ) {
    const { t } = useTranslation();
    // Basename of the PDF, forwarded to annotation popups so LLM prompts can
    // name the source document.
    const fileName = getBasename(filePath);
    const { pdf, numPages, isLoading, error, outline } = usePdfDocument({
      filePath,
      cachedBytes,
      onPdfLoaded,
    });

    const handleSelection = useCallback(
      (
        text: string,
        page: number,
        position: {
          x: number;
          y: number;
          pdfX: number;
          pdfY: number;
          width?: number;
          height?: number;
        }
      ) => {
        if (tabId) onSelection?.(tabId, text, page, position);
      },
      [tabId, onSelection]
    );

    const handleExplainClick = useCallback(
      (id: string) => {
        if (tabId) onExplainClick?.(tabId, id);
      },
      [tabId, onExplainClick]
    );

    const [pageNum, setPageNum] = useState(initialState?.pageNum ?? 1);
    const [scale, setScale] = useState(initialState?.scale ?? 1.5);
    const [viewMode, setViewMode] = useState<"single" | "continuous">(
      initialState?.viewMode ?? "continuous"
    );
    const [pageInput, setPageInput] = useState(String(pageNum));
    const [scaleInput, setScaleInput] = useState(
      `${Math.round((initialState?.scale ?? 1.5) * 100)}%`
    );
    const [outlineOpen, setOutlineOpen] = useState(false);

    const singleContainerRef = useRef<HTMLDivElement>(null);
    const continuousContainerRef = useRef<HTMLDivElement>(null);
    const pageInputRef = useRef<HTMLInputElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const scaleInputRef = useRef<HTMLInputElement>(null);
    const isJumpingRef = useRef(false);
    const jumpScrollCleanupRef = useRef<(() => void) | null>(null);
    const wheelDeltaRef = useRef(0);
    const lastWheelDirectionRef = useRef(0);
    const lastStateRef = useRef<PdfViewerState>({
      pageNum: initialState?.pageNum ?? 1,
      scale: initialState?.scale ?? 1.5,
      viewMode: initialState?.viewMode ?? "continuous",
    });
    const pendingFitCenterRef = useRef(false);
    // Live ref to onStateChange so the goToPage jump-lock release can report
    // the final scrollTop to the parent without capturing a stale callback
    // and without dispatching a synthetic scroll event (which would also
    // re-run computeAndSyncPage and could drift the page number).
    const onStateChangeRef = useRef(onStateChange);
    useEffect(() => {
      onStateChangeRef.current = onStateChange;
    }, [onStateChange]);

    // Zoom constants (used by useZoomAnchor and zoomOut/zoomIn/wheel handler).
    const MIN_SCALE = 0.1;
    const MAX_SCALE = 5.0;
    const ZOOM_STEP_RATIO = 0.1; // 10% per wheel step

    // Viewport preloading, visible-page tracking, and page-wrapper refs are
    // owned by useViewportManager. It is the single source of truth for
    // pageViewports / viewportsForScale / visiblePages, which useZoomAnchor,
    // fitToWidth, goToPage, renderPages, and PdfPage all consume.
    const {
      pageViewports,
      visiblePages,
      viewportsForScale,
      isReady: viewportsReady,
      setPageVisible,
      pageWrapperRefs,
      setPageWrapperRef,
      ensureViewport,
      pageVisibilityRatios,
      reportViewportLoaded,
    } = useViewportManager({
      pdf,
      numPages,
      scale,
      pageNum,
    });

    // Live refs for the latest scale / pageViewports so event handlers and
    // callbacks (wheel zoom, goToPage) read fresh values without depending on
    // their identities — keeping goToPage stable across zoom/scroll commits
    // (docs/REFACTOR_REVIEW_2026-07-17.md #2).
    const scaleRef = useRef(scale);
    useEffect(() => {
      scaleRef.current = scale;
    }, [scale]);
    const pageViewportsRef = useRef(pageViewports);
    useEffect(() => {
      pageViewportsRef.current = pageViewports;
    }, [pageViewports]);

    // Zoom scroll-anchoring (capture/restore + isZooming suppression) is owned
    // by useZoomAnchor. The viewer only forwards the restored state to the
    // parent via the live onStateChange ref, so the hook stays free of the
    // viewer's reporting plumbing.
    const handleZoomRestored = useCallback(
      (state: {
        pageNum: number;
        scale: number;
        viewMode: "single" | "continuous";
        scrollTop: number;
      }) => {
        onStateChangeRef.current?.(state);
      },
      []
    );
    const {
      zoomTo,
      captureCursorAnchor,
      isZoomingRef,
    } = useZoomAnchor({
      viewMode,
      scale,
      pageViewports,
      viewportsForScale,
      continuousContainerRef,
      pageWrapperRefs,
      setScale,
      minScale: MIN_SCALE,
      maxScale: MAX_SCALE,
      onRestored: handleZoomRestored,
    });
    // Keep a live ref of the current page number so the scroll-driven page
    // detection can read the latest value without re-creating its listener.
    const pageNumRef = useRef(pageNum);

    useEffect(() => {
      pageNumRef.current = pageNum;
    }, [pageNum]);

    // Search domain (extracted into useSearchDomain). goToPage is held in a ref
    // so the active-match effect does NOT depend on its identity — breaking the
    // "pageViewports update → goToPage changes → effect re-runs → pulls user
    // back" loop (issue 10.2). The ref is populated after goToPage is defined.
    const goToPageRef = useRef<(page: number) => void>(() => {});
    const {
      searchOpen,
      setSearchOpen,
      searchQuery,
      setSearchQuery,
      searchMatches,
      searchActiveIndex,
      setSearchActiveIndex,
      searchLoading,
      searchHighlightsByPage,
      goToNextMatch: goToNextSearchMatch,
      goToPrevMatch: goToPrevSearchMatch,
    } = useSearchDomain({
      pdf,
      numPages,
      scale,
      currentPageRef: pageNumRef,
      goToPageRef,
    });

    // Expose imperative goToPage for external triggers (e.g. annotation goto)
    useImperativeHandle(ref, () => ({
      goToPage: (target: number) => goToPage(target),
    }));

    // Ensure any temporary scroll listener registered by goToPage is removed when
    // the component unmounts, preventing leaked listeners or stale timeouts.
    useEffect(() => {
      return () => {
        jumpScrollCleanupRef.current?.();
      };
    }, []);

    // Update page input from state, but not while the user is editing.
    useEffect(() => {
      if (document.activeElement !== pageInputRef.current) {
        setPageInput(String(pageNum));
      }
    }, [pageNum]);

    // Update scale input from state, but not while the user is editing.
    useEffect(() => {
      if (document.activeElement !== scaleInputRef.current) {
        setScaleInput(`${Math.round(scale * 100)}%`);
      }
    }, [scale]);

    // Center the CURRENT page horizontally inside the scroll container.
    // The previous version centered the whole scrollable content
    // (scrollLeft = (scrollWidth - clientWidth) / 2), which pushed the fitted
    // page left whenever some OFF-SCREEN page was wider than the container —
    // e.g. pages of a large document still holding wider stale-scale sizes
    // after a zoom-out, or mixed portrait/landscape documents. Centering the
    // current page's wrapper instead is immune to other pages' widths.
    const centerCurrentPageHorizontally = useCallback(() => {
      const container =
        viewMode === "single"
          ? singleContainerRef.current
          : continuousContainerRef.current;
      if (!container) return;
      // Defer to the next frame so the read happens after any pending layout
      // commit (e.g. the zoom reflow that triggered the fit).
      requestAnimationFrame(() => {
        const maxScrollLeft = container.scrollWidth - container.clientWidth;
        if (maxScrollLeft <= 0) {
          container.scrollLeft = 0;
          return;
        }
        const wrapper = pageWrapperRefs.current[pageNumRef.current - 1];
        if (!wrapper) {
          // Single mode (no per-page wrapper refs): center the content.
          container.scrollLeft = maxScrollLeft / 2;
          return;
        }
        const wrapperRect = wrapper.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        container.scrollLeft = computeCenteredScrollLeft({
          scrollLeft: container.scrollLeft,
          wrapperLeft: wrapperRect.left,
          wrapperWidth: wrapperRect.width,
          containerLeft: containerRect.left,
          containerWidth: container.clientWidth,
          maxScrollLeft,
        });
      });
    }, [viewMode, pageWrapperRefs]);

    // After fit-to-width updates the scale, center the page horizontally so
    // residual scroll position does not leave it shifted to one side.
    useEffect(() => {
      if (!pendingFitCenterRef.current || pageViewports.size === 0) return;
      // Wait until pageViewports reflects the current scale; before that the
      // page wrappers still use old/placeholder sizes and scrollWidth is wrong,
      // which would center against stale geometry and leave the page shifted
      // (issue 10.3). Mirrors the zoom-restore effect's readiness gate.
      if (!viewportsReady) return;
      pendingFitCenterRef.current = false;
      centerCurrentPageHorizontally();
    }, [pageViewports, viewportsReady, centerCurrentPageHorizontally]);

    // Notify parent of page/scale/viewMode changes. ScrollTop is intentionally
    // omitted: the continuous scroll listener reports it on user scrolls, and
    // reporting it here races with tab-switch restoration.
    useEffect(() => {
      const newState: PdfViewerState = {
        pageNum,
        scale,
        viewMode,
      };
      if (
        lastStateRef.current.pageNum !== newState.pageNum ||
        lastStateRef.current.scale !== newState.scale ||
        lastStateRef.current.viewMode !== newState.viewMode
      ) {
        lastStateRef.current = newState;
        onStateChange?.(newState);
      }
    }, [pageNum, scale, viewMode, onStateChange]);

    // Clamp pageNum when numPages becomes known or changes
    useEffect(() => {
      if (numPages > 0 && pageNum > numPages) {
        setPageNum(numPages);
      }
    }, [numPages, pageNum]);

    // PDF loading/caching/outline now live in usePdfDocument (see hook call
    // above). filePath changes trigger a remount (key=tab.id), so viewport/page
    // state and refs are naturally reset — no inline reset needed here.

    // Keyboard navigation
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        // 分屏时两个 viewer 都挂在 window 上监听，非焦点屏直接忽略，
        // 避免 Ctrl+F 两屏同弹搜索条、方向键同滚两份文档。
        if (!isFocused) return;
        if (!pdf || numPages === 0) return;

        const isModifier = e.ctrlKey || e.metaKey;
        if (isModifier && e.key.toLowerCase() === "f") {
          e.preventDefault();
          setSearchOpen(true);
          setTimeout(() => searchInputRef.current?.focus(), 0);
          return;
        }

        if (e.key === "Escape" && searchOpen) {
          e.preventDefault();
          setSearchOpen(false);
          return;
        }

        const activeTag = (e.target as HTMLElement)?.tagName?.toLowerCase();
        const isTyping = activeTag === "input" || activeTag === "textarea";

        if (
          searchOpen &&
          searchInputRef.current === document.activeElement &&
          e.key === "Enter"
        ) {
          e.preventDefault();
          setSearchActiveIndex((i) => {
            if (searchMatches.length === 0) return i;
            return e.shiftKey
              ? (i - 1 + searchMatches.length) % searchMatches.length
              : (i + 1) % searchMatches.length;
          });
          return;
        }

        if (isTyping) return;

        if (viewMode === "single") {
          if (
            e.key === "ArrowDown" ||
            e.key === "ArrowRight" ||
            e.key === "PageDown"
          ) {
            e.preventDefault();
            setPageNum((p) => Math.min(numPages, p + 1));
          } else if (
            e.key === "ArrowUp" ||
            e.key === "ArrowLeft" ||
            e.key === "PageUp"
          ) {
            e.preventDefault();
            setPageNum((p) => Math.max(1, p - 1));
          }
        } else {
          const container = continuousContainerRef.current;
          if (!container) return;

          if (e.key === "ArrowDown") {
            e.preventDefault();
            container.scrollBy({ top: SCROLL_STEP, behavior: "smooth" });
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            container.scrollBy({ top: -SCROLL_STEP, behavior: "smooth" });
          } else if (e.key === "PageDown") {
            e.preventDefault();
            container.scrollBy({
              top: container.clientHeight * 0.9,
              behavior: "smooth",
            });
          } else if (e.key === "PageUp") {
            e.preventDefault();
            container.scrollBy({
              top: -container.clientHeight * 0.9,
              behavior: "smooth",
            });
          } else if (e.key === "Home") {
            e.preventDefault();
            container.scrollTo({ top: 0, behavior: "smooth" });
          } else if (e.key === "End") {
            e.preventDefault();
            container.scrollTo({
              top: container.scrollHeight,
              behavior: "smooth",
            });
          }
        }
      };

      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }, [pdf, numPages, viewMode, searchOpen, searchMatches, isFocused]);

    const zoomOut = useCallback(() => {
      zoomTo(scale * (1 - ZOOM_STEP_RATIO));
    }, [scale, zoomTo]);

    const zoomIn = useCallback(() => {
      zoomTo(scale * (1 + ZOOM_STEP_RATIO));
    }, [scale, zoomTo]);

    // Ctrl + wheel zoom, scoped to the PDF canvas container.
    // Accumulates wheel delta and only fires one zoom step per threshold to
    // handle high-sensitivity wheels and rapid back-and-forth scrolling.
    useEffect(() => {
      const container =
        viewMode === "single"
          ? singleContainerRef.current
          : continuousContainerRef.current;
      if (!container) return;

      let resetTimeout: ReturnType<typeof setTimeout> | null = null;

      const applyStep = (direction: number) => {
        if (direction > 0) {
          setScale((s) => Math.max(MIN_SCALE, s * (1 - ZOOM_STEP_RATIO)));
        } else {
          setScale((s) => Math.min(MAX_SCALE, s * (1 + ZOOM_STEP_RATIO)));
        }
      };

      const handleWheel = (e: WheelEvent) => {
        if (!e.ctrlKey) return;
        e.preventDefault();

        const direction = e.deltaY > 0 ? 1 : -1;
        if (
          lastWheelDirectionRef.current !== 0 &&
          lastWheelDirectionRef.current !== direction
        ) {
          // Direction reversed: reset accumulator so rapid back-and-forth
          // scrolling does not fight the current scale.
          wheelDeltaRef.current = 0;
        }
        lastWheelDirectionRef.current = direction;
        wheelDeltaRef.current += e.deltaY;

        const threshold = 100;
        if (Math.abs(wheelDeltaRef.current) >= threshold) {
          const steps = Math.floor(Math.abs(wheelDeltaRef.current) / threshold);
          // Capture the cursor anchor once per zoom burst so the document
          // point under the cursor stays under the cursor across all steps.
          // Skip at the min/max boundary in the zoom-out/zoom-in direction:
          // applyStep would clamp to the same scale (no reflow), so setting
          // the zoom lock would leave it stuck forever — the restore effect
          // only fires on an actual scale commit (REFACTOR_REVIEW #3).
          const atMinBoundary =
            direction > 0 && scaleRef.current <= MIN_SCALE;
          const atMaxBoundary =
            direction < 0 && scaleRef.current >= MAX_SCALE;
          if (
            viewMode === "continuous" &&
            !atMinBoundary &&
            !atMaxBoundary
          ) {
            captureCursorAnchor(e.clientY);
            isZoomingRef.current = true;
          }
          for (let i = 0; i < steps; i++) {
            applyStep(direction);
          }
          wheelDeltaRef.current = wheelDeltaRef.current % threshold;
        }

        if (resetTimeout) clearTimeout(resetTimeout);
        resetTimeout = setTimeout(() => {
          wheelDeltaRef.current = 0;
          lastWheelDirectionRef.current = 0;
        }, 150);
      };

      container.addEventListener("wheel", handleWheel, { passive: false });
      return () => {
        container.removeEventListener("wheel", handleWheel);
        if (resetTimeout) clearTimeout(resetTimeout);
      };
    }, [viewMode, captureCursorAnchor, isZoomingRef]);

    const goToPage = useCallback(
      (target: number) => {
        if (numPages === 0) return;
        const page = Math.max(1, Math.min(numPages, target));
        setPageNum(page);
        setPageInput(String(page));
        if (viewMode === "continuous" && continuousContainerRef.current) {
          const container = continuousContainerRef.current;
          const top = computeContinuousScrollTop(
            page,
            container,
            (p) => pageWrapperRefs.current[p - 1],
            // Read the latest viewport map / scale via refs so this callback
            // stays identity-stable across zoom/scroll commits (memoized
            // PdfPage children depend on onGoToPage) and never reports a
            // stale scale to the parent (REFACTOR_REVIEW #2).
            pageViewportsRef.current,
            scaleRef.current
          );
          // Set the jump lock synchronously so any scroll events fired by the
          // following scrollTo() are ignored. React state would not be committed
          // in time, so a ref is required.
          isJumpingRef.current = true;
          container.scrollTo({ top: Math.max(0, top), behavior: "auto" });

          // Release the lock once the programmatic scroll has settled.
          let timeout: ReturnType<typeof setTimeout>;
          const cleanup = () => {
            clearTimeout(timeout);
            container.removeEventListener("scroll", handleScroll);
            if (jumpScrollCleanupRef.current === cleanup) {
              jumpScrollCleanupRef.current = null;
            }
          };
          const reportFinalState = () => {
            // Report the final scroll position to the parent so the tab
            // state stays accurate after a programmatic jump. Without this
            // the post-jump scrollTop is never reported until the user
            // scrolls again, so switching tabs restores a stale position.
            onStateChangeRef.current?.({
              pageNum: page,
              scale: scaleRef.current,
              viewMode,
              scrollTop: container.scrollTop,
            });
          };
          const handleScroll = () => {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
              isJumpingRef.current = false;
              cleanup();
              reportFinalState();
            }, 150);
          };
          timeout = setTimeout(() => {
            isJumpingRef.current = false;
            cleanup();
            reportFinalState();
          }, 300);
          container.addEventListener("scroll", handleScroll);
          jumpScrollCleanupRef.current = cleanup;
        }
      },
      [numPages, viewMode, pageWrapperRefs]
    );

    // Keep the search domain's goToPage ref in sync so the active-match effect
    // uses the freshest navigation function without depending on its identity.
    // (The search build/active effects and next/prev navigation now live in
    // useSearchDomain — see the hook call above.) Synced in an effect, not
    // during render, per the React concurrent-mode rule against render-phase
    // ref writes (REFACTOR_REVIEW #6).
    useEffect(() => {
      goToPageRef.current = goToPage;
    }, [goToPage]);

    // Tab restore (initialState sync + pending goto page + scrollTop restore)
    // is owned by useTabRestore. It runs at most once per mount: PdfViewer is
    // remounted on tab switch via key={tab.id}, so each instance restores its
    // tab's position exactly once. Must be called AFTER goToPage is defined.
    // mountRestored 标记挂载恢复（含 scrollTop 回写）完成，供 autoFitToWidth
    // 排序：fit 必须在恢复之后执行，缩放锚点才能捕获到正确的当前页。
    const [mountRestored, setMountRestored] = useState(false);
    const handleMountRestored = useCallback(() => setMountRestored(true), []);
    useTabRestore({
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
      onMountRestored: handleMountRestored,
      setPageNum,
      setScale,
      setViewMode,
    });

    const handleOutlineClick = async (item: OutlineItem) => {
      if (item.url) {
        try {
          await invoke("open_path", { path: item.url });
        } catch (err) {
          logError(`Failed to open outline URL: ${err}`);
        }
      } else if (item.dest) {
        try {
          const dest =
            typeof item.dest === "string"
              ? await pdf!.getDestination(item.dest)
              : item.dest;
          if (!dest || !Array.isArray(dest)) return;
          const ref = dest[0];
          const pageIndex = await pdf!.getPageIndex(ref);
          goToPage(pageIndex + 1);
        } catch (err) {
          logError(`Failed to navigate to outline destination: ${err}`);
        }
      }
    };

    const handlePageInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value.replace(/\D/g, "");
      setPageInput(value);
    };

    const handlePageInputKeyDown = (
      e: React.KeyboardEvent<HTMLInputElement>
    ) => {
      if (e.key === "Enter") {
        const page = parseInt(pageInput, 10);
        if (!Number.isNaN(page)) {
          goToPage(page);
        }
        e.currentTarget.blur();
      }
    };

    const handlePageInputBlur = () => {
      setPageInput(String(pageNum));
    };

    const parseScaleInput = (value: string): number | null => {
      const trimmed = value.trim();
      const hasPercent = trimmed.endsWith("%");
      const numericPart = trimmed.replace(/%$/, "");
      if (numericPart === "") return null;
      const num = parseFloat(numericPart);
      if (Number.isNaN(num)) return null;
      if (hasPercent) return num / 100;
      // Without an explicit percent sign, treat values >= 10 as percentages
      // (e.g. 150 => 1.5) and smaller values as raw scale.
      return num >= 10 ? num / 100 : num;
    };

    const applyScaleInput = useCallback(() => {
      const parsed = parseScaleInput(scaleInput);
      if (parsed !== null) {
        zoomTo(parsed);
      } else {
        setScaleInput(`${Math.round(scale * 100)}%`);
      }
    }, [scaleInput, scale, zoomTo]);

    const handleScaleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      setScaleInput(e.target.value);
    };

    const handleScaleInputKeyDown = (
      e: React.KeyboardEvent<HTMLInputElement>
    ) => {
      if (e.key === "Enter") {
        applyScaleInput();
        e.currentTarget.blur();
      } else if (e.key === "Escape") {
        setScaleInput(`${Math.round(scale * 100)}%`);
        e.currentTarget.blur();
      }
    };

    const handleScaleInputBlur = () => {
      applyScaleInput();
    };

    // Keep pageNum in sync with the visible page while scrolling in continuous
    // mode (extracted into useScrollPageSync). The hook owns the scroll/resize
    // listener, top-edge-closest page detection, and debounced scrollTop
    // reporting; it suppresses detection during programmatic jumps
    // (isJumpingRef) and zoom reflows (isZoomingRef).
    useScrollPageSync({
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
    });

    const goToPrevPage = () => setPageNum((p) => Math.max(1, p - 1));
    const goToNextPage = () => setPageNum((p) => Math.min(numPages, p + 1));

    // Fit-to-width now triggers an on-demand viewport load when the target
    // page's entry is missing (issue 9.4). Previously fitToWidth silently
    // returned when `pageViewports.get(pageNum)` was absent — which happened
    // for large documents where the current page had never been preloaded,
    // leaving the user with no feedback. ensureViewport loads the entry at the
    // current scale and returns it, so we can always proceed.
    const fitToWidth = useCallback(async () => {
      if (!pdf || numPages === 0) return;
      const container =
        viewMode === "single"
          ? singleContainerRef.current
          : continuousContainerRef.current;
      if (!container) return;
      // ensureViewport returns the entry for the current scale (loading it if
      // needed). When the entry already exists and is ready it returns
      // synchronously without an extra getPage call.
      const currentViewport = await ensureViewport(pageNum);
      if (!currentViewport) return;
      const padding = parseInt(
        window.getComputedStyle(container).paddingLeft || "24",
        10
      );
      // ensureViewport loads at the current `scale`, so the entry's width is
      // already scaled — pass `scale` as the entry scale, not the possibly-
      // stale `viewportsForScale` (which only matters for entries still
      // lingering from a previous zoom level).
      const newScale = computeFitToWidthScale({
        viewportWidth: currentViewport.width,
        entryScale: scale,
        containerClientWidth: container.clientWidth,
        sidePaddingPx: padding,
      });
      // Round to 0.1% granularity: sub-pixel jitter in clientWidth (scrollbar
      // toggling, panel resizes) otherwise makes every click compute a
      // slightly different scale, each triggering a full reflow.
      const rounded = Math.round(newScale * 1000) / 1000;
      if (rounded === scale) {
        // Already at the fit width: no reflow will happen, so the fit-center
        // effect won't fire — center directly instead.
        centerCurrentPageHorizontally();
        return;
      }
      pendingFitCenterRef.current = true;
      zoomTo(rounded);
    }, [
      pdf,
      numPages,
      viewMode,
      pageNum,
      scale,
      ensureViewport,
      zoomTo,
      centerCurrentPageHorizontally,
    ]);

    // 进入并排模式时（App 仅在分屏分支传 autoFitToWidth，两个 viewer 都会
    // 重新挂载）自动 fit-to-width 一次。必须等挂载恢复完成再 fit：连续模式
    // 下恢复前 scrollTop=0，缩放锚点会捕获到第 1 页，把页码拉回开头。
    // fit 走 zoomTo 锚点恢复，锚点页保持在视口顶部，因此页码不变。
    const autoFitDoneRef = useRef(false);
    useEffect(() => {
      if (!autoFitToWidth || autoFitDoneRef.current) return;
      if (!mountRestored || !pdf || numPages === 0) return;
      autoFitDoneRef.current = true;
      void fitToWidth();
    }, [autoFitToWidth, mountRestored, pdf, numPages, fitToWidth]);

    // Determine which pages to render: visible + adjacent
    const renderPages = useMemo(() => {
      const pages = new Set<number>();
      visiblePages.forEach((page) => {
        pages.add(page);
        if (page > 1) pages.add(page - 1);
        if (page < numPages) pages.add(page + 1);
      });
      // Always render current page in single mode
      if (viewMode === "single") {
        pages.add(pageNum);
      }
      return pages;
    }, [visiblePages, numPages, viewMode, pageNum]);

    if (error) {
      return (
        <div className="pdf-viewer-error">
          <p>{error}</p>
        </div>
      );
    }

    return (
      <div className="pdf-viewer">
        <div className="pdf-controls">
          <div className="pdf-controls-left">
            {onToggleVisibility && (
              <button
                onClick={onToggleVisibility}
                className="icon-btn pdf-hide-btn"
                aria-label={t("pdf.hidePanel")}
                title={t("pdf.hidePanel")}
              >
                <Icon name="panel-collapse-left" size={16} />
              </button>
            )}
            <button
              onClick={() => setOutlineOpen((v) => !v)}
              className={`icon-btn pdf-outline-toggle ${outlineOpen ? "active" : ""}`}
              disabled={numPages === 0 || isLoading || outline.length === 0}
              aria-label={t("pdf.toggleOutline")}
              title={t("pdf.toggleOutline")}
            >
              <Icon name="table-of-contents" size={16} />
            </button>
            <button
              onClick={() => {
                setSearchOpen((v) => !v);
                if (!searchOpen) {
                  setTimeout(() => searchInputRef.current?.focus(), 0);
                }
              }}
              className={`icon-btn pdf-search-toggle ${searchOpen ? "active" : ""}`}
              disabled={numPages === 0 || isLoading}
              aria-label={t("pdf.toggleSearch")}
              title={t("pdf.toggleSearch")}
            >
              <Icon name="search" size={16} />
            </button>
            <button
              onClick={() =>
                setViewMode((m) => (m === "single" ? "continuous" : "single"))
              }
              className="icon-btn pdf-mode-toggle"
              disabled={numPages === 0 || isLoading}
              aria-label={
                viewMode === "single"
                  ? t("pdf.switchToContinuous")
                  : t("pdf.switchToSingle")
              }
              title={
                viewMode === "single"
                  ? t("pdf.switchToContinuous")
                  : t("pdf.switchToSingle")
              }
            >
              <Icon
                name={viewMode === "single" ? "continuous-page" : "single-page"}
                size={16}
              />
            </button>
          </div>

          <div className="pdf-controls-center">
            {viewMode === "single" && (
              <>
                <button
                  className="icon-btn"
                  onClick={goToPrevPage}
                  disabled={pageNum <= 1 || numPages === 0}
                  aria-label={t("pdf.previousPage")}
                  title={t("pdf.previousPage")}
                >
                  <Icon name="page-prev" size={16} />
                </button>
                <span className="page-info">
                  {isLoading ? (
                    t("pdf.loading")
                  ) : numPages > 0 ? (
                    <>
                      <input
                        type="text"
                        inputMode="numeric"
                        className="page-input"
                        ref={pageInputRef}
                        value={pageInput}
                        onChange={handlePageInputChange}
                        onKeyDown={handlePageInputKeyDown}
                        onBlur={handlePageInputBlur}
                        aria-label={t("pdf.pageNumber")}
                        title={t("pdf.pageNumberHint")}
                      />
                      <span> / {numPages}</span>
                    </>
                  ) : (
                    ""
                  )}
                </span>
                <button
                  className="icon-btn"
                  onClick={goToNextPage}
                  disabled={pageNum >= numPages || numPages === 0}
                  aria-label={t("pdf.nextPage")}
                  title={t("pdf.nextPage")}
                >
                  <Icon name="page-next" size={16} />
                </button>
              </>
            )}
            {viewMode === "continuous" && (
              <span className="page-info">
                {isLoading ? (
                  t("pdf.loading")
                ) : numPages > 0 ? (
                  <>
                    <button
                      className="icon-btn"
                      onClick={() => goToPage(pageNum - 1)}
                      disabled={pageNum <= 1 || numPages === 0 || isLoading}
                      aria-label={t("pdf.previousPage")}
                      title={t("pdf.previousPage")}
                    >
                      <Icon name="page-prev" size={16} />
                    </button>
                    <input
                      type="text"
                      inputMode="numeric"
                      className="page-input"
                      ref={pageInputRef}
                      value={pageInput}
                      onChange={handlePageInputChange}
                      onKeyDown={handlePageInputKeyDown}
                      onBlur={handlePageInputBlur}
                      disabled={isLoading}
                      aria-label={t("pdf.pageNumber")}
                      title={t("pdf.pageNumberHint")}
                    />
                    <span> / {numPages}</span>
                    <button
                      className="icon-btn"
                      onClick={() => goToPage(pageNum + 1)}
                      disabled={
                        pageNum >= numPages || numPages === 0 || isLoading
                      }
                      aria-label={t("pdf.nextPage")}
                      title={t("pdf.nextPage")}
                    >
                      <Icon name="page-next" size={16} />
                    </button>
                  </>
                ) : (
                  ""
                )}
              </span>
            )}
          </div>

          <div className="pdf-controls-right">
            <button
              className="icon-btn"
              onClick={fitToWidth}
              disabled={numPages === 0 || isLoading}
              aria-label={t("pdf.fitToWidth")}
              title={t("pdf.fitToWidth")}
            >
              <Icon name="fit-to-width" size={16} />
            </button>
            <button
              className="icon-btn"
              onClick={zoomOut}
              disabled={numPages === 0 || isLoading}
              aria-label={t("pdf.zoomOut")}
              title={t("pdf.zoomOut")}
            >
              <Icon name="zoom-out" size={16} />
            </button>
            <button
              className="icon-btn"
              onClick={zoomIn}
              disabled={numPages === 0 || isLoading}
              aria-label={t("pdf.zoomIn")}
              title={t("pdf.zoomIn")}
            >
              <Icon name="zoom-in" size={16} />
            </button>
            <input
              type="text"
              inputMode="numeric"
              className="scale-input"
              ref={scaleInputRef}
              value={scaleInput}
              onChange={handleScaleInputChange}
              onKeyDown={handleScaleInputKeyDown}
              onBlur={handleScaleInputBlur}
              disabled={numPages === 0 || isLoading}
              aria-label={t("pdf.scale")}
              title={t("pdf.scaleHint")}
            />
          </div>
        </div>

        <div className="pdf-viewer-body">
          {outlineOpen && (
            <div className="pdf-outline-sidebar">
              <div className="pdf-outline-header">
                <span>{t("pdf.outlineTitle")}</span>
                <button
                  className="icon-btn"
                  onClick={() => setOutlineOpen(false)}
                  aria-label={t("pdf.closeOutline")}
                  title={t("pdf.closeOutline")}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
              <ul className="pdf-outline-list">
                {outline.map((item, index) => (
                  <OutlineNode
                    key={index}
                    item={item}
                    level={0}
                    onClick={handleOutlineClick}
                  />
                ))}
              </ul>
            </div>
          )}

          <div
            className={`pdf-canvas-container ${viewMode === "continuous" ? "continuous" : ""}`}
            ref={
              viewMode === "single"
                ? singleContainerRef
                : continuousContainerRef
            }
            tabIndex={0}
          >
            {numPages > 0 ? (
              viewMode === "single" ? (
                <PdfPage
                  pdf={pdf!}
                  pageNum={pageNum}
                  scale={scale}
                  shouldRender={renderPages.has(pageNum)}
                  fileHash={fileHash}
                  fileName={fileName}
                  onSelection={handleSelection}
                  onGoToPage={goToPage}
                  onViewportLoaded={reportViewportLoaded}
                  annotations={annotations}
                  highlightedAnnotationId={highlightedAnnotationId}
                  onAnnotationUpdate={onAnnotationUpdate}
                  onAnnotationDelete={onAnnotationDelete}
                  onExplainClick={handleExplainClick}
                  hoverTranslate={hoverTranslate}
                  settings={settings}
                  searchHighlights={searchHighlightsByPage.get(pageNum)}
                />
              ) : (
                Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
                  <PdfPage
                    key={p}
                    pdf={pdf!}
                    pageNum={p}
                    scale={scale}
                    shouldRender={renderPages.has(p)}
                    pageViewport={pageViewports.get(p) ?? null}
                    fileHash={fileHash}
                    fileName={fileName}
                    onSelection={handleSelection}
                    onGoToPage={goToPage}
                    onVisibilityChange={setPageVisible}
                    onViewportLoaded={reportViewportLoaded}
                    annotations={annotations}
                    highlightedAnnotationId={highlightedAnnotationId}
                    onAnnotationUpdate={onAnnotationUpdate}
                    onAnnotationDelete={onAnnotationDelete}
                    onExplainClick={handleExplainClick}
                    hoverTranslate={hoverTranslate}
                    settings={settings}
                    containerRef={setPageWrapperRef(p)}
                    searchHighlights={searchHighlightsByPage.get(p)}
                  />
                ))
              )
            ) : (
              <p className="pdf-placeholder">
                {isLoading ? t("pdf.loadingPdf") : t("pdf.selectPdfToView")}
              </p>
            )}
          </div>

          {searchOpen && (
            <div className="pdf-search-bar">
              <Icon name="search" size={16} />
              <input
                ref={searchInputRef}
                type="text"
                className="pdf-search-input"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setSearchOpen(false);
                  }
                }}
                placeholder={t("pdf.searchPlaceholder")}
                aria-label={t("pdf.searchPlaceholder")}
              />
              <span className="pdf-search-count">
                {searchLoading
                  ? t("pdf.searchLoading")
                  : searchMatches.length > 0
                    ? t("pdf.searchCount", {
                        current: searchActiveIndex + 1,
                        total: searchMatches.length,
                      })
                    : searchQuery.trim()
                      ? t("pdf.noSearchResults")
                      : ""}
              </span>
              <button
                className="icon-btn"
                onClick={goToPrevSearchMatch}
                disabled={searchMatches.length === 0}
                aria-label={t("pdf.previousSearchMatch")}
                title={t("pdf.previousSearchMatch")}
              >
                <Icon name="chevron-up" size={16} />
              </button>
              <button
                className="icon-btn"
                onClick={goToNextSearchMatch}
                disabled={searchMatches.length === 0}
                aria-label={t("pdf.nextSearchMatch")}
                title={t("pdf.nextSearchMatch")}
              >
                <Icon name="chevron-down" size={16} />
              </button>
              <button
                className="icon-btn"
                onClick={() => {
                  setSearchOpen(false);
                  setSearchQuery("");
                }}
                aria-label={t("pdf.closeSearch")}
                title={t("pdf.closeSearch")}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }
);

function OutlineNode({
  item,
  level,
  onClick,
}: {
  item: OutlineItem;
  level: number;
  onClick: (item: OutlineItem) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const hasChildren = item.items && item.items.length > 0;
  return (
    <li className="pdf-outline-item">
      <div
        className="pdf-outline-row"
        style={{ paddingLeft: `${level * 12}px` }}
      >
        {hasChildren ? (
          <button
            className="icon-btn pdf-outline-expand"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? t("common.collapse") : t("common.expand")}
          >
            <Icon
              name={expanded ? "chevron-down" : "chevron-right"}
              size={12}
            />
          </button>
        ) : (
          <span className="pdf-outline-expand-placeholder" aria-hidden="true" />
        )}
        <button
          className="pdf-outline-title"
          onClick={() => onClick(item)}
          title={item.title}
        >
          {item.title || "(Untitled)"}
        </button>
      </div>
      {expanded && hasChildren && (
        <ul className="pdf-outline-list">
          {item.items.map((child, index) => (
            <OutlineNode
              key={index}
              item={child}
              level={level + 1}
              onClick={onClick}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export default PdfViewer;
