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
}

export interface PdfViewerHandle {
  goToPage: (page: number) => void;
}

interface PdfViewerProps {
  filePath: string;
  fileHash?: string;
  onSelection?: (
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
  initialState?: Partial<PdfViewerState>;
  onStateChange?: (state: PdfViewerState) => void;
  annotations?: Annotation[];
  highlightedAnnotationId?: string | null;
  onAnnotationUpdate?: (
    id: string,
    patch: Partial<Omit<Annotation, "id">>
  ) => void;
  onAnnotationDelete?: (id: string) => void;
  onExplainClick?: (id: string) => void;
  hoverTranslate?: boolean;
  settings: AppSettings;
}

const SCROLL_STEP = 80; // px for arrow keys
const CONTAINER_PADDING_TOP = 24; // must match .pdf-canvas-container.continuous padding-top
const PAGE_SPACING = 24; // must match .pdf-page-wrapper margin-bottom

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
      filePath,
      fileHash,
      onSelection,
      onToggleVisibility,
      initialState,
      onStateChange,
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
    const [viewportsReady, setViewportsReady] = useState(false);
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
    const isJumpingRef = useRef(false);
    const jumpScrollCleanupRef = useRef<(() => void) | null>(null);
    const lastStateRef = useRef<PdfViewerState>({
      pageNum: initialState?.pageNum ?? 1,
      scale: initialState?.scale ?? 1.5,
      viewMode: initialState?.viewMode ?? "continuous",
    });
    // Keep a live ref of the current page number so the scroll-driven page
    // detection can read the latest value without re-creating its listener.
    const pageNumRef = useRef(pageNum);

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

    // Sync state when switching tabs
    useEffect(() => {
      if (initialState?.pageNum !== undefined) setPageNum(initialState.pageNum);
      if (initialState?.scale !== undefined) setScale(initialState.scale);
      if (initialState?.viewMode !== undefined)
        setViewMode(initialState.viewMode);
    }, [initialState?.pageNum, initialState?.scale, initialState?.viewMode]);

    // Notify parent of state changes
    useEffect(() => {
      const newState = { pageNum, scale, viewMode };
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

    // Load PDF when filePath changes
    useEffect(() => {
      if (!filePath) {
        setPdf(null);
        setNumPages(0);
        setPageNum(1);
        setError("");
        setVisiblePages(new Set());
        setPageViewports(new Map());
        setViewportsReady(false);
        pageWrapperRefs.current = [];
        pageWrapperRefCallbacks.current = new Map();
        pageVisibilityRatios.current = new Map();
        return;
      }

      let isCancelled = false;

      const loadPdf = async () => {
        setError("");
        setIsLoading(true);

        try {
          const bytes = await invoke<ArrayBuffer>("read_pdf_bytes", {
            filePath,
          });
          if (isCancelled) return;

          const uint8Array = new Uint8Array(bytes);
          const loadingTask = pdfjsLib.getDocument({ data: uint8Array });

          const loadedPdf = await loadingTask.promise;
          if (isCancelled) return;

          setPdf(loadedPdf);
          setNumPages(loadedPdf.numPages);
          setPageNum(1);
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
      };
    }, [filePath]);

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

    // Pre-compute viewport sizes so we can scroll to an exact page in continuous mode
    useEffect(() => {
      if (!pdf || numPages === 0) return;
      setViewportsReady(false);
      let cancelled = false;
      const loadViewports = async () => {
        const map = new Map<number, PageViewportInfo>();
        for (let i = 1; i <= numPages; i++) {
          try {
            const page = await pdf.getPage(i);
            if (cancelled) return;
            const vp = page.getViewport({ scale });
            map.set(i, { width: vp.width, height: vp.height });
          } catch (err) {
            logError(`Failed to get viewport for page ${i}: ${err}`);
          }
        }
        if (!cancelled) {
          setPageViewports(map);
          setViewportsReady(true);
        }
      };
      loadViewports();
      return () => {
        cancelled = true;
      };
    }, [pdf, numPages, scale]);

    const goToPage = useCallback(
      (target: number) => {
        if (numPages === 0) return;
        if (viewMode === "continuous" && !viewportsReady) return;
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
            }, 150);
          };
          timeout = setTimeout(() => {
            isJumpingRef.current = false;
            cleanup();
          }, 300);
          container.addEventListener("scroll", handleScroll);
          jumpScrollCleanupRef.current = cleanup;
        }
      },
      [numPages, viewMode, pageViewports, viewportsReady]
    );

    // Build the search index when the search panel is open and the query/scale changes.
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

      build();
      return () => {
        cancelled = true;
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

      const computeAndSyncPage = () => {
        const container = continuousContainerRef.current;
        if (!container) return;
        if (cancelled || isJumpingRef.current) return;

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
      };

      const updateVisiblePage = () => {
        if (cancelled || isJumpingRef.current) return;
        if (debounceTimeout) clearTimeout(debounceTimeout);
        debounceTimeout = setTimeout(() => {
          requestAnimationFrame(computeAndSyncPage);
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
    }, [viewMode]);

    const goToPrevPage = () => setPageNum((p) => Math.max(1, p - 1));
    const goToNextPage = () => setPageNum((p) => Math.min(numPages, p + 1));
    const zoomOut = () => setScale((s) => Math.max(0.5, s - 0.05));
    const zoomIn = () => setScale((s) => s + 0.05);

    const fitToWidth = useCallback(() => {
      if (!pdf || numPages === 0) return;
      const container =
        viewMode === "single"
          ? singleContainerRef.current
          : continuousContainerRef.current;
      if (!container) return;
      const currentViewport = pageViewports.get(pageNum);
      if (!currentViewport) return;
      const originalWidth = currentViewport.width / scale;
      const padding = parseInt(
        window.getComputedStyle(container).paddingLeft || "24",
        10
      );
      const newScale = (container.clientWidth - padding * 2) / originalWidth;
      setScale(Math.max(0.1, Math.min(5, newScale)));
    }, [pdf, numPages, viewMode, pageNum, pageViewports, scale]);

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
              <Icon name="bookmark" size={16} />
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
                      disabled={
                        pageNum <= 1 ||
                        numPages === 0 ||
                        isLoading ||
                        !viewportsReady
                      }
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
                      disabled={!viewportsReady}
                      aria-label={t("pdf.pageNumber")}
                      title={t("pdf.pageNumberHint")}
                    />
                    <span> / {numPages}</span>
                    <button
                      className="icon-btn"
                      onClick={() => goToPage(pageNum + 1)}
                      disabled={
                        pageNum >= numPages ||
                        numPages === 0 ||
                        isLoading ||
                        !viewportsReady
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
            <span className="scale-info">{Math.round(scale * 100)}%</span>
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
                  onSelection={onSelection}
                  onGoToPage={goToPage}
                  annotations={annotations}
                  highlightedAnnotationId={highlightedAnnotationId}
                  onAnnotationUpdate={onAnnotationUpdate}
                  onAnnotationDelete={onAnnotationDelete}
                  onExplainClick={onExplainClick}
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
                    onSelection={onSelection}
                    onGoToPage={goToPage}
                    onVisibilityChange={handleVisibilityChange}
                    annotations={annotations}
                    highlightedAnnotationId={highlightedAnnotationId}
                    onAnnotationUpdate={onAnnotationUpdate}
                    onAnnotationDelete={onAnnotationDelete}
                    onExplainClick={onExplainClick}
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
