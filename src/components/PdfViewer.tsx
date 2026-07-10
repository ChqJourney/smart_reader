import {
  useEffect,
  useRef,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import * as pdfjsLib from "pdfjs-dist";
import { Annotation } from "../services/annotations";
import PdfAnnotations from "./PdfAnnotations";
import Icon from "./Icon";

// @ts-ignore - pdfjs-dist worker import with ?url
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

interface TextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

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
  onSelection?: (
    text: string,
    page: number,
    position: { x: number; y: number; pdfX: number; pdfY: number; width?: number; height?: number }
  ) => void;
  onToggleVisibility?: () => void;
  initialState?: Partial<PdfViewerState>;
  onStateChange?: (state: PdfViewerState) => void;
  annotations?: Annotation[];
  highlightedAnnotationId?: string | null;
  onAnnotationUpdate?: (id: string, patch: Partial<Omit<Annotation, "id">>) => void;
  onAnnotationDelete?: (id: string) => void;
  onExplainClick?: (id: string) => void;
}

const CLICK_DRAG_THRESHOLD = 10; // px
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
    return targetRect.top - containerRect.top + container.scrollTop - CONTAINER_PADDING_TOP;
  }

  // Last resort: accumulate whatever viewport info we have.
  let top = 0;
  for (let i = 1; i < targetPage; i++) {
    const vp = pageViewports.get(i);
    top += (vp?.height ?? 0) + PAGE_SPACING;
  }
  return top;
}

interface PdfPageProps {
  pdf: pdfjsLib.PDFDocumentProxy;
  pageNum: number;
  scale: number;
  shouldRender: boolean;
  pageViewports?: Map<number, PageViewportInfo>;
  onSelection?: (
    text: string,
    page: number,
    position: { x: number; y: number; pdfX: number; pdfY: number; width?: number; height?: number }
  ) => void;
  onVisibilityChange?: (pageNum: number, ratio: number) => void;
  annotations?: Annotation[];
  highlightedAnnotationId?: string | null;
  onAnnotationUpdate?: (id: string, patch: Partial<Omit<Annotation, "id">>) => void;
  onAnnotationDelete?: (id: string) => void;
  onExplainClick?: (id: string) => void;
  containerRef?: React.Ref<HTMLDivElement>;
}

function PdfPage({ pdf, pageNum, scale, shouldRender, pageViewports, onSelection, onVisibilityChange, annotations, highlightedAnnotationId, onAnnotationUpdate, onAnnotationDelete, onExplainClick, containerRef }: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const textItemsRef = useRef<TextItem[]>([]);
  const [viewport, setViewport] = useState<PageViewportInfo | null>(pageViewports?.get(pageNum) ?? null);
  const [selectionRect, setSelectionRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [selectedItems, setSelectedItems] = useState<TextItem[]>([]);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | undefined>(undefined);
  const hasRenderedRef = useRef(false);

  const setWrapperRef = useCallback((node: HTMLDivElement | null) => {
    wrapperRef.current = node;
    if (typeof containerRef === "function") {
      containerRef(node);
    } else if (containerRef) {
      (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    }
  }, [containerRef]);

  // Get viewport size for placeholder and set wrapper dimensions early.
  // Prefer the parent's pre-computed pageViewports so the DOM layout is stable
  // before every child finishes its own async viewport lookup.
  useEffect(() => {
    const parentViewport = pageViewports?.get(pageNum);
    if (parentViewport) {
      setViewport(parentViewport);
      return;
    }

    let isCancelled = false;
    const getViewport = async () => {
      try {
        const page = await pdf.getPage(pageNum);
        if (isCancelled) return;
        const vp = page.getViewport({ scale });
        const info = { width: vp.width, height: vp.height };
        setViewport(info);
        if (wrapperRef.current) {
          wrapperRef.current.style.width = `${info.width}px`;
          wrapperRef.current.style.height = `${info.height}px`;
          wrapperRef.current.style.minHeight = "";
        }
      } catch (err) {
        console.error(`Failed to get viewport for page ${pageNum}:`, err);
      }
    };
    getViewport();
    return () => {
      isCancelled = true;
    };
  }, [pdf, pageNum, scale, pageViewports]);

  // Render page when it should be rendered
  useEffect(() => {
    if (!shouldRender || !viewport || !canvasRef.current || !wrapperRef.current) return;

    let isCancelled = false;

    const render = async () => {
      try {
        const page = await pdf.getPage(pageNum);
        if (isCancelled) return;

        const canvas = canvasRef.current!;
        const wrapper = wrapperRef.current!;
        const pageViewport = page.getViewport({ scale });

        wrapper.style.width = `${viewport.width}px`;
        wrapper.style.height = `${viewport.height}px`;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(pageViewport.width * dpr);
        canvas.height = Math.floor(pageViewport.height * dpr);
        canvas.style.width = `${pageViewport.width}px`;
        canvas.style.height = `${pageViewport.height}px`;

        const context = canvas.getContext("2d")!;
        context.setTransform(dpr, 0, 0, dpr, 0, 0);

        renderTaskRef.current = page.render({
          canvasContext: context,
          viewport: pageViewport,
        });

        await renderTaskRef.current.promise;
        if (isCancelled) return;

        const textContent = await page.getTextContent();
        if (isCancelled) return;

        const items: TextItem[] = (textContent.items as any[])
          .filter((item: any) => item.str?.trim())
          .map((item: any) => {
            const [x, y] = pageViewport.convertToViewportPoint(item.transform[4], item.transform[5]);
            const width = item.width * pageViewport.scale;
            const height = (item.height || 10) * pageViewport.scale;
            return {
              text: item.str,
              x,
              y: y - height,
              width,
              height,
            };
          });

        textItemsRef.current = items;
        hasRenderedRef.current = true;
      } catch (err) {
        if (!isCancelled) {
          console.error(`Failed to render page ${pageNum}:`, err);
        }
      }
    };

    render();

    return () => {
      isCancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [pdf, pageNum, scale, viewport, shouldRender]);

  // IntersectionObserver for visibility
  useEffect(() => {
    if (!wrapperRef.current || !onVisibilityChange) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          onVisibilityChange(pageNum, entry.intersectionRatio);
        });
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] }
    );

    observer.observe(wrapperRef.current);

    return () => {
      observer.disconnect();
    };
  }, [pageNum, onVisibilityChange]);

  const getMousePosInWrapper = (e: React.MouseEvent) => {
    if (!wrapperRef.current) return { x: 0, y: 0 };
    const rect = wrapperRef.current.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  const findItemsInRect = (rect: { x1: number; y1: number; x2: number; y2: number }) => {
    const items = textItemsRef.current.filter((item) => {
      return !(
        item.x + item.width < rect.x1 ||
        item.x > rect.x2 ||
        item.y + item.height < rect.y1 ||
        item.y > rect.y2
      );
    });

    const lineThreshold = 4;
    items.sort((a, b) => {
      if (Math.abs(a.y - b.y) < lineThreshold) return a.x - b.x;
      return a.y - b.y;
    });

    return items;
  };

  const findItemsNearPoint = (x: number, y: number) => {
    const items = textItemsRef.current;

    let clicked = items.find(
      (item) => x >= item.x && x <= item.x + item.width && y >= item.y && y <= item.y + item.height
    );

    if (!clicked) {
      let minDist = Infinity;
      for (const item of items) {
        const cx = item.x + item.width / 2;
        const cy = item.y + item.height / 2;
        const dist = Math.hypot(x - cx, y - cy);
        if (dist < 20 && dist < minDist) {
          minDist = dist;
          clicked = item;
        }
      }
    }

    if (!clicked) return [];

    const lineThreshold = 8;
    const lineItems = items.filter((item) => Math.abs(item.y - clicked.y) < lineThreshold);
    lineItems.sort((a, b) => a.x - b.x);
    return lineItems;
  };

  const buildTextFromItems = (items: TextItem[]) => {
    if (items.length === 0) return "";

    const lineThreshold = 4;
    const lines: string[][] = [];
    let currentLine: TextItem[] = [];
    let currentY = items[0].y;

    for (const item of items) {
      if (Math.abs(item.y - currentY) < lineThreshold) {
        currentLine.push(item);
      } else {
        if (currentLine.length > 0) lines.push(currentLine.map((i) => i.text));
        currentLine = [item];
        currentY = item.y;
      }
    }
    if (currentLine.length > 0) lines.push(currentLine.map((i) => i.text));

    return lines.map((line) => line.join(" ")).join("\n");
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    const pos = getMousePosInWrapper(e);
    isDraggingRef.current = true;
    dragStartRef.current = pos;
    setSelectionRect(null);
    setSelectedItems([]);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDraggingRef.current || !dragStartRef.current) return;

    const pos = getMousePosInWrapper(e);
    const start = dragStartRef.current;

    const x = Math.min(start.x, pos.x);
    const y = Math.min(start.y, pos.y);
    const width = Math.abs(pos.x - start.x);
    const height = Math.abs(pos.y - start.y);

    setSelectionRect({ x, y, width, height });
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (!isDraggingRef.current || !dragStartRef.current) return;

    const pos = getMousePosInWrapper(e);
    const start = dragStartRef.current;
    const dx = pos.x - start.x;
    const dy = pos.y - start.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    let selectedItems: TextItem[] = [];

    if (distance < CLICK_DRAG_THRESHOLD) {
      selectedItems = findItemsNearPoint(start.x, start.y);
    } else {
      const x1 = Math.min(start.x, pos.x);
      const y1 = Math.min(start.y, pos.y);
      const x2 = Math.max(start.x, pos.x);
      const y2 = Math.max(start.y, pos.y);
      selectedItems = findItemsInRect({ x1, y1, x2, y2 });
    }

    const text = buildTextFromItems(selectedItems).trim();

    isDraggingRef.current = false;
    dragStartRef.current = null;
    setSelectionRect(null);
    setSelectedItems(selectedItems);

    if (text && onSelection) {
      const rect = wrapperRef.current!.getBoundingClientRect();
      const bbox = selectedItems.reduce(
        (acc, item) => ({
          minX: Math.min(acc.minX, item.x),
          minY: Math.min(acc.minY, item.y),
          maxX: Math.max(acc.maxX, item.x + item.width),
          maxY: Math.max(acc.maxY, item.y + item.height),
        }),
        { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
      );

      onSelection(text, pageNum, {
        x: e.clientX,
        y: e.clientY,
        pdfX: (e.clientX - rect.left) / scale,
        pdfY: (e.clientY - rect.top) / scale,
        width: bbox.maxX > bbox.minX ? (bbox.maxX - bbox.minX) / scale : undefined,
        height: bbox.maxY > bbox.minY ? (bbox.maxY - bbox.minY) / scale : undefined,
      });
    }
  };

  return (
    <div
      ref={setWrapperRef}
      className="pdf-page-wrapper"
      data-page={pageNum}
      style={{
        width: viewport?.width ?? "auto",
        height: viewport?.height ?? "auto",
        minHeight: viewport ? undefined : "400px",
      }}
    >
      <canvas ref={canvasRef} />
      <div
        ref={overlayRef}
        className="pdf-selection-overlay"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          isDraggingRef.current = false;
          dragStartRef.current = null;
          setSelectionRect(null);
        }}
      />
      {selectionRect && (
        <div
          className="pdf-selection-rect"
          style={{
            left: selectionRect.x,
            top: selectionRect.y,
            width: selectionRect.width,
            height: selectionRect.height,
          }}
        />
      )}
      {selectedItems.length > 0 && (() => {
        const bounds = selectedItems.reduce(
          (acc, item) => ({
            minX: Math.min(acc.minX, item.x),
            minY: Math.min(acc.minY, item.y),
            maxX: Math.max(acc.maxX, item.x + item.width),
            maxY: Math.max(acc.maxY, item.y + item.height),
          }),
          { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
        );
        return (
          <div
            className="pdf-text-highlight"
            style={{
              left: bounds.minX,
              top: bounds.minY,
              width: bounds.maxX - bounds.minX,
              height: bounds.maxY - bounds.minY,
            }}
          />
        );
      })()}
      <PdfAnnotations
        annotations={annotations || []}
        pageNum={pageNum}
        scale={scale}
        highlightedId={highlightedAnnotationId}
        onUpdate={onAnnotationUpdate || (() => {})}
        onDelete={onAnnotationDelete || (() => {})}
        onExplainClick={onExplainClick || (() => {})}
      />
    </div>
  );
}

const PdfViewer = forwardRef<PdfViewerHandle, PdfViewerProps>(function PdfViewer(
  {
    filePath,
    onSelection,
    onToggleVisibility,
    initialState,
    onStateChange,
    annotations,
    highlightedAnnotationId,
    onAnnotationUpdate,
    onAnnotationDelete,
    onExplainClick,
  },
  ref
) {
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pageNum, setPageNum] = useState(initialState?.pageNum ?? 1);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(initialState?.scale ?? 1.5);
  const [error, setError] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [viewMode, setViewMode] = useState<"single" | "continuous">(initialState?.viewMode ?? "continuous");
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set());
  const [pageViewports, setPageViewports] = useState<Map<number, PageViewportInfo>>(new Map());
  const [pageInput, setPageInput] = useState(String(pageNum));
  const [viewportsReady, setViewportsReady] = useState(false);

  const singleContainerRef = useRef<HTMLDivElement>(null);
  const continuousContainerRef = useRef<HTMLDivElement>(null);
  const pageWrapperRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pageVisibilityRatios = useRef<Map<number, number>>(new Map());
  const pageInputRef = useRef<HTMLInputElement>(null);
  const isJumpingRef = useRef(false);
  const lastStateRef = useRef<PdfViewerState>({
    pageNum: initialState?.pageNum ?? 1,
    scale: initialState?.scale ?? 1.5,
    viewMode: initialState?.viewMode ?? "continuous",
  });

  // Expose imperative goToPage for external triggers (e.g. annotation goto)
  useImperativeHandle(ref, () => ({
    goToPage: (target: number) => goToPage(target),
  }));

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
    if (initialState?.viewMode !== undefined) setViewMode(initialState.viewMode);
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
        const bytes = await invoke<ArrayBuffer>("read_pdf_bytes", { filePath });
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
        if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "PageDown") {
          e.preventDefault();
          setPageNum((p) => Math.min(numPages, p + 1));
        } else if (e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "PageUp") {
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
          container.scrollBy({ top: container.clientHeight * 0.9, behavior: "smooth" });
        } else if (e.key === "PageUp") {
          e.preventDefault();
          container.scrollBy({ top: -container.clientHeight * 0.9, behavior: "smooth" });
        } else if (e.key === "Home") {
          e.preventDefault();
          container.scrollTo({ top: 0, behavior: "smooth" });
        } else if (e.key === "End") {
          e.preventDefault();
          container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pdf, numPages, viewMode]);

  const handleVisibilityChange = useCallback((page: number, ratio: number) => {
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
  }, []);

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

  const goToPage = useCallback((target: number) => {
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
      const handleScroll = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          isJumpingRef.current = false;
          container.removeEventListener("scroll", handleScroll);
        }, 150);
      };
      timeout = setTimeout(() => {
        isJumpingRef.current = false;
        container.removeEventListener("scroll", handleScroll);
      }, 300);
      container.addEventListener("scroll", handleScroll);
    }
  }, [numPages, viewMode, pageViewports, viewportsReady]);

  const handlePageInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/\D/g, "");
    setPageInput(value);
  };

  const handlePageInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
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
          if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) return;

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
    const container = viewMode === "single" ? singleContainerRef.current : continuousContainerRef.current;
    if (!container) return;
    const currentViewport = pageViewports.get(pageNum);
    if (!currentViewport) return;
    const originalWidth = currentViewport.width / scale;
    const padding = parseInt(window.getComputedStyle(container).paddingLeft || "24", 10);
    const newScale = (container.clientWidth - padding * 2) / originalWidth;
    setScale(Math.max(0.1, Math.min(5, newScale)));
  }, [pdf, numPages, viewMode, pageNum, pageViewports, scale]);

  // Stable ref callback for continuous-mode page wrappers
  const pageWrapperRefCallbacks = useRef<Map<number, (el: HTMLDivElement | null) => void>>(new Map());
  const setPageWrapperRef = useCallback((page: number) => {
    if (!pageWrapperRefCallbacks.current.has(page)) {
      pageWrapperRefCallbacks.current.set(page, (el: HTMLDivElement | null) => {
        pageWrapperRefs.current[page - 1] = el;
      });
    }
    return pageWrapperRefCallbacks.current.get(page)!;
  }, []);

  // Determine which pages to render: visible + adjacent
  const renderPages = new Set<number>();
  visiblePages.forEach((page) => {
    renderPages.add(page);
    if (page > 1) renderPages.add(page - 1);
    if (page < numPages) renderPages.add(page + 1);
  });
  // Always render current page in single mode
  if (viewMode === "single") {
    renderPages.add(pageNum);
  }

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
              aria-label="隐藏 PDF 面板"
              title="隐藏 PDF 面板"
            >
              <Icon name="hide-left" size={16} />
            </button>
          )}
          <button
            onClick={() => setViewMode((m) => (m === "single" ? "continuous" : "single"))}
            className="icon-btn pdf-mode-toggle"
            disabled={numPages === 0 || isLoading}
            aria-label={viewMode === "single" ? "切换为连续阅读" : "切换为单页阅读"}
            title={viewMode === "single" ? "切换为连续阅读" : "切换为单页阅读"}
          >
            <Icon name={viewMode === "single" ? "continuous-page" : "single-page"} size={16} />
          </button>
        </div>

        <div className="pdf-controls-center">
          {viewMode === "single" && (
            <>
              <button
                className="icon-btn"
                onClick={goToPrevPage}
                disabled={pageNum <= 1 || numPages === 0}
                aria-label="上一页"
                title="上一页"
              >
                <Icon name="page-prev" size={16} />
              </button>
              <span className="page-info">
                {isLoading ? (
                  "Loading..."
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
                      aria-label="页码"
                      title="输入页码并按回车跳转"
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
                aria-label="下一页"
                title="下一页"
              >
                <Icon name="page-next" size={16} />
              </button>
            </>
          )}
          {viewMode === "continuous" && (
            <span className="page-info">
              {isLoading ? (
                "Loading..."
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
                    aria-label="页码"
                    title="输入页码并按回车跳转"
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
            aria-label="适合宽度"
            title="适合宽度"
          >
            <Icon name="fit-to-width" size={16} />
          </button>
          <button
            className="icon-btn"
            onClick={zoomOut}
            disabled={numPages === 0 || isLoading}
            aria-label="缩小"
            title="缩小"
          >
            <Icon name="zoom-out" size={16} />
          </button>
          <button
            className="icon-btn"
            onClick={zoomIn}
            disabled={numPages === 0 || isLoading}
            aria-label="放大"
            title="放大"
          >
            <Icon name="zoom-in" size={16} />
          </button>
          <span className="scale-info">{Math.round(scale * 100)}%</span>
        </div>
      </div>

      <div
        className={`pdf-canvas-container ${viewMode === "continuous" ? "continuous" : ""}`}
        ref={viewMode === "single" ? singleContainerRef : continuousContainerRef}
        tabIndex={0}
      >
        {numPages > 0 ? (
          viewMode === "single" ? (
            <PdfPage
              pdf={pdf!}
              pageNum={pageNum}
              scale={scale}
              shouldRender={renderPages.has(pageNum)}
              onSelection={onSelection}
              annotations={annotations}
              highlightedAnnotationId={highlightedAnnotationId}
              onAnnotationUpdate={onAnnotationUpdate}
              onAnnotationDelete={onAnnotationDelete}
              onExplainClick={onExplainClick}
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
                onSelection={onSelection}
                onVisibilityChange={handleVisibilityChange}
                annotations={annotations}
                highlightedAnnotationId={highlightedAnnotationId}
                onAnnotationUpdate={onAnnotationUpdate}
                onAnnotationDelete={onAnnotationDelete}
                onExplainClick={onExplainClick}
                containerRef={setPageWrapperRef(p)}
              />
            ))
          )
        ) : (
          <p className="pdf-placeholder">{isLoading ? "Loading PDF..." : "Select a PDF to view"}</p>
        )}
      </div>
    </div>
  );
});

export default PdfViewer;
