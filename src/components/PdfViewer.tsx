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
import Icon from "./Icon";
import PdfPage from "./PdfPage";
import "./PdfViewer.css";

import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export interface PageViewportInfo {
  width: number;
  height: number;
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

    const singleContainerRef = useRef<HTMLDivElement>(null);
    const continuousContainerRef = useRef<HTMLDivElement>(null);
    const pageWrapperRefs = useRef<(HTMLDivElement | null)[]>([]);
    const pageVisibilityRatios = useRef<Map<number, number>>(new Map());
    const pageInputRef = useRef<HTMLInputElement>(null);
    const isJumpingRef = useRef(false);
    const jumpScrollCleanupRef = useRef<(() => void) | null>(null);
    const lastStateRef = useRef<PdfViewerState>({
      pageNum: initialState?.pageNum ?? 1,
      scale: initialState?.scale ?? 1.5,
      viewMode: initialState?.viewMode ?? "continuous",
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
            console.error("Error loading PDF:", err);
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

    // Keyboard navigation
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (!pdf || numPages === 0) return;

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
    }, [pdf, numPages, viewMode]);

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
            console.error(`Failed to get viewport for page ${i}:`, err);
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

      let ticking = false;
      let cancelled = false;

      const updateVisiblePage = () => {
        const container = continuousContainerRef.current;
        if (!container) return;
        if (cancelled || isJumpingRef.current) return;
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          ticking = false;
          if (cancelled || isJumpingRef.current) return;

          const containerRect = container.getBoundingClientRect();

          let bestPage = pageNum;
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

          if (bestPage !== pageNum) {
            setPageNum(bestPage);
          }
        });
      };

      container.addEventListener("scroll", updateVisiblePage);
      // Also recompute when the container is resized.
      const resizeObserver = new ResizeObserver(updateVisiblePage);
      resizeObserver.observe(container);

      return () => {
        cancelled = true;
        container.removeEventListener("scroll", updateVisiblePage);
        resizeObserver.disconnect();
      };
    }, [viewMode, pageNum]);

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
                <Icon name="hide-left" size={16} />
              </button>
            )}
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

        <div
          className={`pdf-canvas-container ${viewMode === "continuous" ? "continuous" : ""}`}
          ref={
            viewMode === "single" ? singleContainerRef : continuousContainerRef
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
                annotations={annotations}
                highlightedAnnotationId={highlightedAnnotationId}
                onAnnotationUpdate={onAnnotationUpdate}
                onAnnotationDelete={onAnnotationDelete}
                onExplainClick={onExplainClick}
                hoverTranslate={hoverTranslate}
                settings={settings}
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
                  onVisibilityChange={handleVisibilityChange}
                  annotations={annotations}
                  highlightedAnnotationId={highlightedAnnotationId}
                  onAnnotationUpdate={onAnnotationUpdate}
                  onAnnotationDelete={onAnnotationDelete}
                  onExplainClick={onExplainClick}
                  hoverTranslate={hoverTranslate}
                  settings={settings}
                  containerRef={setPageWrapperRef(p)}
                />
              ))
            )
          ) : (
            <p className="pdf-placeholder">
              {isLoading ? t("pdf.loadingPdf") : t("pdf.selectPdfToView")}
            </p>
          )}
        </div>
      </div>
    );
  }
);

export default PdfViewer;
