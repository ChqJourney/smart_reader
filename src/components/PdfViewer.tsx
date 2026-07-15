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
import PdfPage, { SearchHighlight } from "./PdfPage";
import {
  findTopVisiblePage,
  findPageAtY,
  toPdfOffset,
  computeRestoredScrollTop,
  PageRect,
} from "../utils/zoomAnchor";
import { computeFitToWidthScale } from "../utils/fitToWidth";
import "./PdfViewer.css";

import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export interface PageViewportInfo {
  width: number;
  height: number;
}

export interface OutlineItem {
  title: string;
  dest?: string | unknown[] | null;
  url?: string | null;
  items: OutlineItem[];
}

interface SearchMatch {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
}

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
}

const SCROLL_STEP = 80; // px for arrow keys
const CONTAINER_PADDING_TOP = 24; // must match .pdf-canvas-container.continuous padding-top
const PAGE_SPACING = 24; // must match .pdf-page-wrapper margin-bottom
// For small documents we can afford to preload every viewport and get exact
// continuous-mode jumps. For large documents we lazily compute only the visible
// pages plus a small window to avoid blocking the main thread.
const VIEWPORT_PRELOAD_THRESHOLD = 50;

export function computeContinuousScrollTop(
  targetPage: number,
  container: HTMLDivElement,
  getPageWrapper: (page: number) => HTMLDivElement | null | undefined,
  pageViewports: Map<number, PageViewportInfo>
): number {
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
      top += vp.height + PAGE_SPACING;
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
    top += (vp?.height ?? 0) + PAGE_SPACING;
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
    },
    ref
  ) {
    const { t } = useTranslation();
    const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);

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
    const [numPages, setNumPages] = useState(0);
    const [scale, setScale] = useState(initialState?.scale ?? 1.5);
    const [error, setError] = useState<string>("");
    const [isLoading, setIsLoading] = useState(false);
    const [viewMode, setViewMode] = useState<"single" | "continuous">(
      initialState?.viewMode ?? "continuous"
    );
    const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set());
    const [pageViewports, setPageViewports] = useState<
      Map<number, PageViewportInfo>
    >(new Map());
    const [pageInput, setPageInput] = useState(String(pageNum));
    const [scaleInput, setScaleInput] = useState(
      `${Math.round((initialState?.scale ?? 1.5) * 100)}%`
    );
    const [outlineOpen, setOutlineOpen] = useState(false);
    const [outline, setOutline] = useState<OutlineItem[]>([]);
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
    const [searchActiveIndex, setSearchActiveIndex] = useState(-1);
    const [searchLoading, setSearchLoading] = useState(false);

    const singleContainerRef = useRef<HTMLDivElement>(null);
    const continuousContainerRef = useRef<HTMLDivElement>(null);
    const pageWrapperRefs = useRef<(HTMLDivElement | null)[]>([]);
    const pageVisibilityRatios = useRef<Map<number, number>>(new Map());
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
    // Scale for which `pageViewports` currently holds entries. The zoom restore
    // effect waits until this matches the current `scale` before reading the
    // newly-laid-out DOM, so it never restores against stale (old-scale) sizes.
    const [viewportsForScale, setViewportsForScale] = useState(scale);
    const pendingGotoPageRef = useRef(initialState?.pendingGotoPage);
    const pendingScrollTopRef = useRef(initialState?.scrollTop);
    // Restoration of page/scroll position must run at most once per mount.
    // PdfViewer is remounted on tab switch via key={tab.id}, so each fresh
    // instance restores its tab's position exactly once. Without this guard
    // the effect re-runs whenever pageViewports/pageNum change, and a stale
    // scrollTop (e.g. 0 produced by the initial goToPage(1)) would overwrite
    // a user's own jump and snap the container back to the top.
    const hasRestoredRef = useRef(false);
    // Live ref to onStateChange so the goToPage jump-lock release can report
    // the final scrollTop to the parent without capturing a stale callback
    // and without dispatching a synthetic scroll event (which would also
    // re-run computeAndSyncPage and could drift the page number).
    const onStateChangeRef = useRef(onStateChange);
    useEffect(() => {
      onStateChangeRef.current = onStateChange;
    }, [onStateChange]);
    // Keep a live ref of the current page number so the scroll-driven page
    // detection can read the latest value without re-creating its listener.
    const pageNumRef = useRef(pageNum);
    // Track the last scale for which viewports were computed so we can discard
    // stale viewport sizes after zoom changes.
    const lastScaleRef = useRef(scale);

    useEffect(() => {
      pageNumRef.current = pageNum;
    }, [pageNum]);

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

    // After fit-to-width updates the scale, center the page horizontally so
    // residual scroll position does not leave it shifted to one side.
    useEffect(() => {
      if (!pendingFitCenterRef.current || pageViewports.size === 0) return;
      pendingFitCenterRef.current = false;
      const container =
        viewMode === "single"
          ? singleContainerRef.current
          : continuousContainerRef.current;
      if (!container) return;
      requestAnimationFrame(() => {
        const maxScrollLeft = container.scrollWidth - container.clientWidth;
        container.scrollLeft = maxScrollLeft > 0 ? maxScrollLeft / 2 : 0;
      });
    }, [pageViewports, viewMode]);

    // Sync state when switching tabs
    useEffect(() => {
      if (initialState?.pageNum !== undefined) setPageNum(initialState.pageNum);
      if (initialState?.scale !== undefined) setScale(initialState.scale);
      if (initialState?.viewMode !== undefined)
        setViewMode(initialState.viewMode);
      pendingGotoPageRef.current = initialState?.pendingGotoPage;
      pendingScrollTopRef.current = initialState?.scrollTop;
    }, [
      initialState?.pageNum,
      initialState?.scale,
      initialState?.viewMode,
      initialState?.pendingGotoPage,
      initialState?.scrollTop,
    ]);

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

    // Load PDF when filePath changes. Reuse cached bytes when available so
    // switching tabs does not re-read large files from disk. Each viewer keeps
    // its own PDFDocumentProxy to avoid sharing PDF.js transport state.
    useEffect(() => {
      if (!filePath) {
        setPdf(null);
        setNumPages(0);
        setPageNum(1);
        setError("");
        setVisiblePages(new Set());
        setPageViewports(new Map());
        pageWrapperRefs.current = [];
        pageWrapperRefCallbacks.current = new Map();
        pageVisibilityRatios.current = new Map();
        return;
      }

      // Clear the previous document immediately so we never render with a
      // destroyed PDFDocumentProxy while the new file is loading.
      setPdf(null);
      setNumPages(0);
      setPageNum(1);
      setError("");
      setVisiblePages(new Set());
      setPageViewports(new Map());
      pageWrapperRefs.current = [];
      pageWrapperRefCallbacks.current = new Map();
      pageVisibilityRatios.current = new Map();
      setIsLoading(true);

      let isCancelled = false;
      let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
      let loadedPdf: pdfjsLib.PDFDocumentProxy | null = null;

      const loadPdf = async () => {
        try {
          let data: Uint8Array;
          if (cachedBytes) {
            // Make a copy before handing the bytes to PDF.js so its worker does
            // not detach the shared cached buffer.
            data = cachedBytes.slice();
          } else {
            const bytes = await invoke<ArrayBuffer>("read_pdf_bytes", {
              filePath,
            });
            if (isCancelled) return;
            const view = new Uint8Array(bytes);
            // PDF.js may transfer/detach the underlying ArrayBuffer while
            // loading. Cache a detached-buffer-safe copy and pass a separate
            // view to PDF.js so reopening the same file never reuses a
            // detached buffer.
            onPdfLoaded?.(filePath, view.slice());
            data = view;
          }

          loadingTask = pdfjsLib.getDocument({ data });
          loadedPdf = await loadingTask.promise;
          if (isCancelled) {
            loadedPdf.destroy();
            loadedPdf = null;
            return;
          }

          setPdf(loadedPdf);
          setNumPages(loadedPdf.numPages);
          setPageNum(initialState?.pageNum ?? 1);
        } catch (err) {
          if (!isCancelled) {
            logError(`Error loading PDF: ${err}`);
            setError(`Failed to load PDF: ${err}`);
          }
        } finally {
          if (!isCancelled) {
            setIsLoading(false);
          }
        }
      };

      loadPdf();

      return () => {
        isCancelled = true;
        if (loadedPdf) {
          loadedPdf.destroy();
          loadedPdf = null;
        } else if (loadingTask) {
          loadingTask.destroy();
        }
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filePath, onPdfLoaded]);

    // Execute any pending page navigation once the PDF is loaded and the target
    // page viewport is known. This is used to restore the correct page when
    // switching tabs without racing against incomplete DOM geometry.
    useEffect(() => {
      if (!pdf || numPages === 0 || isLoading || hasRestoredRef.current) return;

      const pending = pendingGotoPageRef.current;
      if (pending !== undefined && tabId) {
        if (viewMode === "single" || pageViewports.has(pending)) {
          goToPage(pending);
          onClearPendingGotoPage?.(tabId);
          pendingGotoPageRef.current = undefined;
          // In continuous mode, also restore the exact scroll offset saved
          // for this tab so switching back lands on the same reading spot,
          // not just the page top. Viewports are fully preloaded for small
          // docs by this point, so scrollHeight is correct and scrollTop
          // won't be clamped.
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
        }
        // Target page viewport not ready yet; wait for the next run without
        // marking as restored.
        return;
      }

      // No pending page jump: restore the exact continuous-scroll position
      // stored for this tab.
      const scrollTop = pendingScrollTopRef.current;
      if (
        scrollTop !== undefined &&
        viewMode === "continuous" &&
        continuousContainerRef.current
      ) {
        continuousContainerRef.current.scrollTop = scrollTop;
      }
      pendingScrollTopRef.current = undefined;
      hasRestoredRef.current = true;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pdf, numPages, isLoading, viewMode, pageViewports, tabId]);

    // Load PDF outline (bookmarks) when the PDF changes.
    useEffect(() => {
      if (!pdf) {
        setOutline([]);
        return;
      }
      let cancelled = false;
      const loadOutline = async () => {
        try {
          const outlineData = (await pdf.getOutline()) || [];
          if (!cancelled) setOutline(outlineData as OutlineItem[]);
        } catch (err) {
          logError(`Failed to load PDF outline: ${err}`);
        }
      };
      loadOutline();
      return () => {
        cancelled = true;
      };
    }, [pdf]);

    // Keyboard navigation
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
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
    }, [pdf, numPages, viewMode, searchOpen, searchMatches]);

    const MIN_SCALE = 0.1;
    const MAX_SCALE = 5.0;
    const ZOOM_STEP_RATIO = 0.1; // 10% per wheel step

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
    }, []);

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
          pdfOffset: toPdfOffset(anchor.offsetPx, scale),
          anchorViewportOffsetPx,
        };
      },
      [viewMode, scale, collectPageRects]
    );

    const zoomTo = useCallback(
      (target: number, anchorViewportOffsetPx = 0) => {
        if (viewMode === "continuous" && scale !== target) {
          captureZoomAnchor(anchorViewportOffsetPx);
          isZoomingRef.current = true;
        }
        setScale(Math.max(MIN_SCALE, Math.min(MAX_SCALE, target)));
      },
      [viewMode, scale, captureZoomAnchor]
    );

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

      const captureCursorAnchor = (clientY: number) => {
        if (viewMode !== "continuous") return;
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
          pdfOffset: toPdfOffset(anchor.offsetPx, scale),
          anchorViewportOffsetPx: clientY - containerRect.top,
        };
      };

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
          if (viewMode === "continuous") {
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
    }, [viewMode, scale, captureZoomAnchor]);

    const handleVisibilityChange = useCallback(
      (page: number, ratio: number) => {
        pageVisibilityRatios.current.set(page, ratio);
        setVisiblePages((prev) => {
          const next = new Set(prev);
          if (ratio > 0) {
            next.add(page);
          } else {
            next.delete(page);
          }
          return next;
        });
      },
      []
    );

    // Pre-compute viewport sizes so we can scroll to an exact page in continuous
    // mode. For small documents we preload every page; for large documents we
    // only compute the visible pages plus a small window, falling back to live
    // DOM geometry for the rest. This keeps opening and jumping responsive on
    // 100MB/200-page documents.
    useEffect(() => {
      if (!pdf || numPages === 0) return;
      lastScaleRef.current = scale;
      let cancelled = false;
      const loadViewports = async () => {
        const pages = new Set<number>();
        if (numPages <= VIEWPORT_PRELOAD_THRESHOLD) {
          for (let i = 1; i <= numPages; i++) pages.add(i);
        } else {
          visiblePages.forEach((p) => {
            pages.add(p);
            if (p > 1) pages.add(p - 1);
            if (p < numPages) pages.add(p + 1);
          });
          pages.add(1);
          pages.add(pageNum);
        }

        const newEntries: [number, PageViewportInfo][] = [];
        for (const i of pages) {
          try {
            const page = await pdf.getPage(i);
            if (cancelled) return;
            const vp = page.getViewport({ scale });
            newEntries.push([i, { width: vp.width, height: vp.height }]);
          } catch (err) {
            logError(`Failed to get viewport for page ${i}: ${err}`);
          }
        }
        if (!cancelled) {
          // Keep the previous entries as a placeholder instead of clearing the
          // map on zoom. Clearing collapsed every page wrapper to a 400px
          // placeholder during the async recompute, which made the scroll
          // position meaningless and caused the page to jump. The new entries
          // overwrite the stale ones; consumers that need fresh sizes gate on
          // `viewportsForScale === scale`.
          setPageViewports((prev) => {
            const map = new Map(prev);
            newEntries.forEach(([i, info]) => map.set(i, info));
            return map;
          });
          setViewportsForScale(scale);
        }
      };
      loadViewports();
      return () => {
        cancelled = true;
      };
    }, [pdf, numPages, scale, visiblePages, pageNum]);

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
            pageViewports
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
          const handleScroll = () => {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
              isJumpingRef.current = false;
              cleanup();
              // Report the final scroll position to the parent so the tab
              // state stays accurate after a programmatic jump. Without this
              // the post-jump scrollTop is never reported until the user
              // scrolls again, so switching tabs restores a stale position.
              onStateChangeRef.current?.({
                pageNum: page,
                scale,
                viewMode,
                scrollTop: container.scrollTop,
              });
            }, 150);
          };
          timeout = setTimeout(() => {
            isJumpingRef.current = false;
            cleanup();
            onStateChangeRef.current?.({
              pageNum: page,
              scale,
              viewMode,
              scrollTop: container.scrollTop,
            });
          }, 300);
          container.addEventListener("scroll", handleScroll);
          jumpScrollCleanupRef.current = cleanup;
        }
      },
      [numPages, viewMode, pageViewports]
    );

    // Build the search index when the search panel is open and the query/scale
    // changes. Debounce the query so rapid keystrokes on large documents do not
    // trigger a full text scan on every character.
    useEffect(() => {
      if (!searchOpen || !pdf || numPages === 0) {
        setSearchMatches([]);
        setSearchActiveIndex(-1);
        return;
      }
      const trimmed = searchQuery.trim();
      if (trimmed === "") {
        setSearchMatches([]);
        setSearchActiveIndex(-1);
        return;
      }

      let cancelled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;

      const build = async () => {
        setSearchLoading(true);
        const queryLower = trimmed.toLowerCase();
        const matches: SearchMatch[] = [];
        for (let p = 1; p <= numPages; p++) {
          try {
            const page = await pdf.getPage(p);
            if (cancelled) return;
            const pageViewport = page.getViewport({ scale });
            const textContent = await page.getTextContent();
            if (cancelled) return;
            for (const item of textContent.items) {
              if (!("str" in item)) continue;
              const text = item.str;
              if (!text.trim()) continue;
              if (text.toLowerCase().includes(queryLower)) {
                const [x, y] = pageViewport.convertToViewportPoint(
                  item.transform[4],
                  item.transform[5]
                );
                const width = item.width * pageViewport.scale;
                const height = (item.height || 10) * pageViewport.scale;
                matches.push({
                  id: `match-${p}-${matches.length}`,
                  page: p,
                  text,
                  x,
                  y: y - height,
                  width,
                  height,
                });
              }
            }
          } catch (err) {
            logError(`Failed to build search index for page ${p}: ${err}`);
          }
        }
        if (!cancelled) {
          setSearchMatches(matches);
          const startIndex = matches.findIndex(
            (m) => m.page >= pageNumRef.current
          );
          setSearchActiveIndex(
            startIndex >= 0 ? startIndex : matches.length > 0 ? 0 : -1
          );
        }
        if (!cancelled) setSearchLoading(false);
      };

      timeout = setTimeout(build, 250);

      return () => {
        cancelled = true;
        if (timeout) clearTimeout(timeout);
      };
    }, [searchOpen, searchQuery, pdf, numPages, scale]);

    // Scroll to the active search match whenever it changes.
    useEffect(() => {
      if (searchActiveIndex < 0 || searchActiveIndex >= searchMatches.length)
        return;
      const match = searchMatches[searchActiveIndex];
      goToPage(match.page);
    }, [searchActiveIndex, searchMatches, goToPage]);

    const goToNextSearchMatch = () => {
      if (searchMatches.length === 0) return;
      setSearchActiveIndex((i) => (i + 1) % searchMatches.length);
    };

    const goToPrevSearchMatch = () => {
      if (searchMatches.length === 0) return;
      setSearchActiveIndex(
        (i) => (i - 1 + searchMatches.length) % searchMatches.length
      );
    };

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

    const searchHighlightsByPage = useMemo(() => {
      const map = new Map<number, SearchHighlight[]>();
      searchMatches.forEach((match, index) => {
        const list = map.get(match.page) || [];
        list.push({
          id: match.id,
          page: match.page,
          x: match.x,
          y: match.y,
          width: match.width,
          height: match.height,
          isActive: index === searchActiveIndex,
        });
        map.set(match.page, list);
      });
      return map;
    }, [searchMatches, searchActiveIndex]);

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

    // Keep pageNum in sync with the visible page while scrolling in continuous mode.
    // We compute directly from DOM geometry instead of relying on the asynchronous
    // IntersectionObserver state, which can be stale right after a jump.
    // The "current" page is defined as the visible page whose top edge is closest
    // to the top of the viewport; this matches the behaviour of a page jump and
    // avoids the centre-bias that can report the next page when several short
    // pages fit on screen.
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

        let bestPage = pageNumRef.current;
        let bestDistance = Infinity;

        pageWrapperRefs.current.forEach((wrapper, i) => {
          if (!wrapper) return;
          const rect = wrapper.getBoundingClientRect();
          // Only consider pages that actually intersect the viewport.
          if (
            rect.bottom <= containerRect.top ||
            rect.top >= containerRect.bottom
          )
            return;

          const pageTop = rect.top - containerRect.top;
          const distance = Math.abs(pageTop);

          if (distance < bestDistance) {
            bestDistance = distance;
            bestPage = i + 1;
          }
        });

        setPageNum((current) => (current === bestPage ? current : bestPage));
        return bestPage;
      };

      const updateVisiblePage = () => {
        if (cancelled || isJumpingRef.current || isZoomingRef.current) return;
        if (debounceTimeout) clearTimeout(debounceTimeout);
        debounceTimeout = setTimeout(() => {
          requestAnimationFrame(() => {
            const bestPage = computeAndSyncPage();
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
    }, [viewMode, scale, onStateChange]);

    // Restore the scroll position captured by `captureZoomAnchor` once the new
    // scale's page viewports have been committed and the page wrappers have
    // been laid out at their new sizes. Reads the anchor page's true scroll
    // position from live DOM (which forces a synchronous reflow) so the math
    // works for any document size and needs no padding constants.
    useEffect(() => {
      if (!pendingZoomAnchorRef.current) return;
      // Wait until pageViewports reflects the current scale; before that the
      // page wrappers still use the old (or placeholder) sizes.
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
        onStateChangeRef.current?.({
          pageNum: page,
          scale,
          viewMode,
          scrollTop: container.scrollTop,
        });
      });
    }, [pageViewports, viewportsForScale, scale, viewMode]);

    const goToPrevPage = () => setPageNum((p) => Math.max(1, p - 1));
    const goToNextPage = () => setPageNum((p) => Math.min(numPages, p + 1));

    const fitToWidth = useCallback(() => {
      if (!pdf || numPages === 0) return;
      const container =
        viewMode === "single"
          ? singleContainerRef.current
          : continuousContainerRef.current;
      if (!container) return;
      const currentViewport = pageViewports.get(pageNum);
      if (!currentViewport) return;
      const padding = parseInt(
        window.getComputedStyle(container).paddingLeft || "24",
        10
      );
      // Derive the true page width from the viewport entry using the scale it
      // was actually computed for (`viewportsForScale`), NOT the live `scale`
      // state. During a zoom transition the map still holds old-scale entries,
      // so dividing by `scale` would yield a wrong width, an oversized fit
      // scale, and a page that ends up wider than the container (visible as a
      // left-shift after horizontal centering).
      const newScale = computeFitToWidthScale({
        viewportWidth: currentViewport.width,
        entryScale: viewportsForScale,
        containerClientWidth: container.clientWidth,
        sidePaddingPx: padding,
      });
      pendingFitCenterRef.current = true;
      zoomTo(newScale);
    }, [
      pdf,
      numPages,
      viewMode,
      pageNum,
      pageViewports,
      viewportsForScale,
      zoomTo,
    ]);

    // Stable ref callback for continuous-mode page wrappers
    const pageWrapperRefCallbacks = useRef<
      Map<number, (el: HTMLDivElement | null) => void>
    >(new Map());
    const setPageWrapperRef = useCallback((page: number) => {
      if (!pageWrapperRefCallbacks.current.has(page)) {
        pageWrapperRefCallbacks.current.set(
          page,
          (el: HTMLDivElement | null) => {
            pageWrapperRefs.current[page - 1] = el;
          }
        );
      }
      return pageWrapperRefCallbacks.current.get(page)!;
    }, []);

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
                  onSelection={handleSelection}
                  onGoToPage={goToPage}
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
                    pageViewports={pageViewports}
                    fileHash={fileHash}
                    onSelection={handleSelection}
                    onGoToPage={goToPage}
                    onVisibilityChange={handleVisibilityChange}
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
        {hasChildren && (
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
