import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as pdfjsLib from "pdfjs-dist";
import type { TextItem as PdfjsTextItem } from "pdfjs-dist/types/src/display/api";
import type { PageViewportInfo } from "./PdfViewer";
import { Annotation } from "../services/annotations";
import { AppSettings } from "../services/settings";
import { error } from "../services/logs";
import PdfAnnotations from "./PdfAnnotations";
import { useWordLookup } from "../hooks/useWordLookup";
import WordTooltip from "./WordTooltip";
import "./PdfPage.css";

const LINE_GROUPING_THRESHOLD = 4;
const CLICK_LINE_THRESHOLD = 8;
const CLICK_DRAG_THRESHOLD = 10; // px

interface TextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SearchHighlight {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  isActive: boolean;
}

interface LinkAnnotation {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  url?: string;
  dest?: unknown;
}

interface PdfPageProps {
  pdf: pdfjsLib.PDFDocumentProxy;
  pageNum: number;
  scale: number;
  shouldRender: boolean;
  pageViewports?: Map<number, PageViewportInfo>;
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
  onGoToPage?: (page: number) => void;
  onVisibilityChange?: (pageNum: number, ratio: number) => void;
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
  containerRef?: React.Ref<HTMLDivElement>;
  searchHighlights?: SearchHighlight[];
}

function PdfPage({
  pdf,
  pageNum,
  scale,
  shouldRender,
  pageViewports,
  fileHash,
  onSelection,
  onGoToPage,
  onVisibilityChange,
  annotations,
  highlightedAnnotationId,
  onAnnotationUpdate,
  onAnnotationDelete,
  onExplainClick,
  hoverTranslate,
  settings,
  containerRef,
  searchHighlights,
}: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const textItemsRef = useRef<TextItem[]>([]);
  const linkAnnotationsRef = useRef<LinkAnnotation[]>([]);
  const pendingLinkRef = useRef<LinkAnnotation | null>(null);
  const [linkAnnotations, setLinkAnnotations] = useState<LinkAnnotation[]>([]);
  const [viewport, setViewport] = useState<PageViewportInfo | null>(
    pageViewports?.get(pageNum) ?? null
  );
  const [selectionRect, setSelectionRect] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const [selectedItems, setSelectedItems] = useState<TextItem[]>([]);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | undefined>(undefined);
  const hasRenderedRef = useRef(false);
  const [tooltip, showTooltip, hideTooltip] = useWordLookup(
    !!hoverTranslate,
    500
  );

  const setWrapperRef = useCallback(
    (node: HTMLDivElement | null) => {
      wrapperRef.current = node;
      if (typeof containerRef === "function") {
        containerRef(node);
      } else if (containerRef) {
        (
          containerRef as React.MutableRefObject<HTMLDivElement | null>
        ).current = node;
      }
    },
    [containerRef]
  );

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
        // Drive wrapper size purely through React state + the controlled style
        // prop below. Direct imperative style writes used to race React's
        // controlled `style` and caused size flicker while `viewport` was null.
        setViewport({ width: vp.width, height: vp.height });
      } catch (err) {
        error(`Failed to get viewport for page ${pageNum}: ${err}`);
      }
    };
    getViewport();
    return () => {
      isCancelled = true;
    };
  }, [pdf, pageNum, scale, pageViewports]);

  // Render page when it should be rendered
  useEffect(() => {
    if (!shouldRender || !viewport || !canvasRef.current || !wrapperRef.current)
      return;

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

        const items: TextItem[] = textContent.items
          .filter((item): item is PdfjsTextItem => "str" in item)
          .filter((item) => item.str.trim())
          .map((item) => {
            const [x, y] = pageViewport.convertToViewportPoint(
              item.transform[4],
              item.transform[5]
            );
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

        try {
          const annotationData = await page.getAnnotations();
          if (isCancelled) return;

          const links: LinkAnnotation[] = annotationData
            .filter((a: unknown) => {
              const anno = a as { subtype?: string; annotationType?: number };
              return anno.subtype === "Link" || anno.annotationType === 2;
            })
            .map((a: unknown, index: number) => {
              const anno = a as {
                rect: number[];
                url?: string;
                dest?: unknown;
                action?: string;
              };
              const [x1, y1, x2, y2] = anno.rect;
              const [vx1, vy1] = pageViewport.convertToViewportPoint(x1, y1);
              const [vx2, vy2] = pageViewport.convertToViewportPoint(x2, y2);
              const minX = Math.min(vx1, vx2);
              const maxX = Math.max(vx1, vx2);
              const minY = Math.min(vy1, vy2);
              const maxY = Math.max(vy1, vy2);
              return {
                id: `link-${pageNum}-${index}`,
                x: minX,
                y: minY,
                width: maxX - minX,
                height: maxY - minY,
                url: anno.url,
                dest: anno.dest,
              };
            });

          linkAnnotationsRef.current = links;
          setLinkAnnotations(links);
        } catch (err) {
          if (!isCancelled) {
            error(
              `Failed to load link annotations for page ${pageNum}: ${err}`
            );
          }
        }
      } catch (err) {
        if (!isCancelled) {
          error(`Failed to render page ${pageNum}: ${err}`);
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

  const findItemsInRect = (rect: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }) => {
    const items = textItemsRef.current.filter((item) => {
      return !(
        item.x + item.width < rect.x1 ||
        item.x > rect.x2 ||
        item.y + item.height < rect.y1 ||
        item.y > rect.y2
      );
    });

    const lineThreshold = LINE_GROUPING_THRESHOLD;
    items.sort((a, b) => {
      if (Math.abs(a.y - b.y) < lineThreshold) return a.x - b.x;
      return a.y - b.y;
    });

    return items;
  };

  const findItemsNearPoint = (x: number, y: number) => {
    const items = textItemsRef.current;

    let clicked = items.find(
      (item) =>
        x >= item.x &&
        x <= item.x + item.width &&
        y >= item.y &&
        y <= item.y + item.height
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

    const lineThreshold = CLICK_LINE_THRESHOLD;
    const lineItems = items.filter(
      (item) => Math.abs(item.y - clicked.y) < lineThreshold
    );
    lineItems.sort((a, b) => a.x - b.x);
    return lineItems;
  };

  const buildTextFromItems = (items: TextItem[]) => {
    if (items.length === 0) return "";

    const lineThreshold = LINE_GROUPING_THRESHOLD;
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

  const extractWordFromText = (text: string, index: number): string | null => {
    if (index < 0 || index >= text.length) return null;
    const wordChars = /[a-zA-Z0-9'\-]/;
    if (!wordChars.test(text[index])) return null;

    let start = index;
    while (start > 0 && wordChars.test(text[start - 1])) start--;

    let end = index;
    while (end < text.length - 1 && wordChars.test(text[end + 1])) end++;

    const word = text.slice(start, end + 1);
    if (!/^[a-zA-Z][a-zA-Z0-9'\-]*$/.test(word) || word.length < 2) return null;
    return word;
  };

  const extractWordAtPoint = (x: number, y: number): string | null => {
    const items = textItemsRef.current;
    const item = items.find(
      (i) => x >= i.x && x <= i.x + i.width && y >= i.y && y <= i.y + i.height
    );
    if (!item || item.width <= 0) return null;

    const ratio = Math.max(0, Math.min(1, (x - item.x) / item.width));
    const charIndex = Math.floor(ratio * item.text.length);
    return extractWordFromText(item.text, charIndex);
  };

  const findLinkAtPoint = (x: number, y: number): LinkAnnotation | null => {
    return (
      linkAnnotationsRef.current.find(
        (link) =>
          x >= link.x &&
          x <= link.x + link.width &&
          y >= link.y &&
          y <= link.y + link.height
      ) || null
    );
  };

  const handleLinkClick = async (link: LinkAnnotation) => {
    if (link.url) {
      try {
        await invoke("open_path", { path: link.url });
      } catch (err) {
        error(`Failed to open link URL: ${err}`);
      }
    } else if (link.dest) {
      try {
        const dest =
          typeof link.dest === "string"
            ? await pdf.getDestination(link.dest)
            : link.dest;
        if (!dest || !Array.isArray(dest)) return;
        const ref = dest[0];
        const pageIndex = await pdf.getPageIndex(ref);
        onGoToPage?.(pageIndex + 1);
      } catch (err) {
        error(`Failed to navigate to link destination: ${err}`);
      }
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    hideTooltip();
    const pos = getMousePosInWrapper(e);
    pendingLinkRef.current = findLinkAtPoint(pos.x, pos.y);
    isDraggingRef.current = true;
    dragStartRef.current = pos;
    setSelectionRect(null);
    setSelectedItems([]);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const pos = getMousePosInWrapper(e);

    if (overlayRef.current) {
      overlayRef.current.style.cursor = findLinkAtPoint(pos.x, pos.y)
        ? "pointer"
        : "crosshair";
    }

    if (isDraggingRef.current && dragStartRef.current) {
      const start = dragStartRef.current;
      const dx = pos.x - start.x;
      const dy = pos.y - start.y;
      if (pendingLinkRef.current && Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD) {
        pendingLinkRef.current = null;
      }
      const x = Math.min(start.x, pos.x);
      const y = Math.min(start.y, pos.y);
      const width = Math.abs(pos.x - start.x);
      const height = Math.abs(pos.y - start.y);
      setSelectionRect({ x, y, width, height });
      return;
    }

    if (hoverTranslate) {
      const word = extractWordAtPoint(pos.x, pos.y);
      if (word) {
        showTooltip(word, pos.x, pos.y - 4);
      } else {
        hideTooltip();
      }
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (!isDraggingRef.current || !dragStartRef.current) return;

    const pos = getMousePosInWrapper(e);
    const start = dragStartRef.current;
    const dx = pos.x - start.x;
    const dy = pos.y - start.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < CLICK_DRAG_THRESHOLD && pendingLinkRef.current) {
      const link = pendingLinkRef.current;
      pendingLinkRef.current = null;
      isDraggingRef.current = false;
      dragStartRef.current = null;
      setSelectionRect(null);
      handleLinkClick(link);
      return;
    }

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
    pendingLinkRef.current = null;
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
        width:
          bbox.maxX > bbox.minX ? (bbox.maxX - bbox.minX) / scale : undefined,
        height:
          bbox.maxY > bbox.minY ? (bbox.maxY - bbox.minY) / scale : undefined,
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
      {searchHighlights?.map((highlight) => (
        <div
          key={highlight.id}
          className={`pdf-search-highlight ${highlight.isActive ? "active" : ""}`}
          style={{
            left: highlight.x,
            top: highlight.y,
            width: highlight.width,
            height: highlight.height,
          }}
        />
      ))}
      <div className="pdf-link-layer" aria-hidden="true">
        {linkAnnotations.map((link) => (
          <div
            key={link.id}
            className="pdf-link-indicator"
            style={{
              left: link.x,
              top: link.y,
              width: link.width,
              height: link.height,
            }}
          />
        ))}
      </div>
      <div
        ref={overlayRef}
        className="pdf-selection-overlay"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          hideTooltip();
          isDraggingRef.current = false;
          dragStartRef.current = null;
          pendingLinkRef.current = null;
          setSelectionRect(null);
          if (overlayRef.current) {
            overlayRef.current.style.cursor = "crosshair";
          }
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
      {selectedItems.length > 0 &&
        (() => {
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
        fileHash={fileHash || ""}
        highlightedId={highlightedAnnotationId}
        onUpdate={onAnnotationUpdate || (() => {})}
        onDelete={onAnnotationDelete || (() => {})}
        onExplainClick={onExplainClick || (() => {})}
        settings={settings}
      />
      {tooltip.visible && (
        <WordTooltip
          word={tooltip.word}
          entry={tooltip.entry}
          loading={tooltip.loading}
          x={tooltip.x}
          y={tooltip.y}
        />
      )}
    </div>
  );
}

export default PdfPage;
