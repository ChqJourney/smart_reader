import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { error as logError } from "../services/logs";
import { useDrag } from "../hooks/useDrag";
import { usePanScroll } from "../hooks/usePanScroll";
import { LinkPreviewState } from "../hooks/useLinkPreviews";
import Icon from "./Icon";
import "./LinkPreviewPopup.css";

const MIN_WIDTH = 260;
const MIN_HEIGHT = 200;
/** 定位到 dest 后向上留出的边距，让条款上方留一点上下文。 */
const DEST_TOP_MARGIN = 12;
/** 内容缩放范围与步进（相对 fit-to-width 基础 scale 的倍率）。 */
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP_RATIO = 1.2;
/** Ctrl/Cmd+滚轮缩放的累积阈值与停息窗口，与主 viewer 手势参数一致。 */
const WHEEL_DELTA_THRESHOLD = 100;
const WHEEL_RESET_MS = 150;

interface LinkPreviewPopupProps {
  pdf: PDFDocumentProxy;
  preview: LinkPreviewState;
  onGoToPage: (page: number) => void;
  onTogglePin: (id: string) => void;
  onClose: (id: string) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

/**
 * 条款链接悬停预览小窗（画中画）。复用 viewer 的 PDF 代理渲染目标页
 * （pdf.js 支持同一文档并发渲染不同页，无需另开文档），窗口可拖动、
 * 可右下角调大小、内容区原生滚动，内容可缩放（头部 ± 按钮或
 * Ctrl/Cmd+滚轮）并可左键拖拽平移（手型，仅溢出时生效）。
 * 位置/尺寸/缩放为组件本地状态——弹出后外部不再关心几何信息，无需回写 hook。
 */
function LinkPreviewPopup({
  pdf,
  preview,
  onGoToPage,
  onTogglePin,
  onClose,
  onMouseEnter,
  onMouseLeave,
}: LinkPreviewPopupProps) {
  const { t } = useTranslation();
  const [bounds, setBounds] = useState({
    x: preview.x,
    y: preview.y,
    width: preview.width,
    height: preview.height,
  });
  // 渲染分辨率跟随「拖动结束时的宽度」：拖动过程中 canvas 仅 CSS 拉伸
  // （瞬时、略糊），松手后才按新宽度重新 render，避免每像素一次全页渲染。
  const [committedWidth, setCommittedWidth] = useState(preview.width);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading"
  );
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<RenderTask | undefined>(undefined);
  const hasAutoScrolledRef = useRef(false);
  const boundsRef = useRef(bounds);
  useEffect(() => {
    boundsRef.current = bounds;
  }, [bounds]);

  // 内容缩放倍率（相对 fit-to-width）。缩放前把当前滚动位置记为内容比例，
  // 重渲完成后按比例恢复——否则每次缩放都会把视图顶回条款位置或原点。
  // zoomRef 与 zoom state 同步（zoom 只经 applyZoom 变更）：缩放撞边界
  // （clamp 后值不变）时不记锚点、不触发无效重渲。
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const pendingScrollRatioRef = useRef<number | null>(null);
  const applyZoom = useCallback((step: (z: number) => number) => {
    const clamped = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, step(zoomRef.current))
    );
    // 连续步进累积的浮点漂移（1.2×1.2/1.2/1.2≈1+ε）会让 zoom 永远回不到
    // 精确的 1，导致 canvas 停在像素定宽而丢失 CSS 100% 的窗口跟随拉伸；
    // 接近 1 时吸附回 1。
    const next = Math.abs(clamped - 1) < 0.01 ? 1 : clamped;
    if (next === zoomRef.current) return;
    zoomRef.current = next;
    const body = bodyRef.current;
    if (body && body.scrollHeight > 0) {
      pendingScrollRatioRef.current = body.scrollTop / body.scrollHeight;
    }
    setZoom(next);
  }, []);
  const zoomIn = useCallback(
    () => applyZoom((z) => z * ZOOM_STEP_RATIO),
    [applyZoom]
  );
  const zoomOut = useCallback(
    () => applyZoom((z) => z / ZOOM_STEP_RATIO),
    [applyZoom]
  );

  // Ctrl/Cmd + 滚轮缩放，与主 viewer 手势一致：累积 delta 过阈值才步进，
  // 方向反转重置累积，停息后清零。预览 portal 到 body，与主视图的 wheel
  // 监听互不相干，preventDefault 仅阻止内容区原生滚动。
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let acc = 0;
    let lastDirection = 0;
    let resetTimeout: ReturnType<typeof setTimeout> | null = null;
    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const direction = e.deltaY > 0 ? 1 : -1;
      if (lastDirection !== 0 && lastDirection !== direction) {
        acc = 0;
      }
      lastDirection = direction;
      acc += e.deltaY;
      if (Math.abs(acc) >= WHEEL_DELTA_THRESHOLD) {
        const steps = Math.floor(Math.abs(acc) / WHEEL_DELTA_THRESHOLD);
        for (let i = 0; i < steps; i++) {
          if (direction > 0) {
            zoomOut();
          } else {
            zoomIn();
          }
        }
        acc = acc % WHEEL_DELTA_THRESHOLD;
      }
      if (resetTimeout) clearTimeout(resetTimeout);
      resetTimeout = setTimeout(() => {
        acc = 0;
        lastDirection = 0;
      }, WHEEL_RESET_MS);
    };
    body.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      body.removeEventListener("wheel", handleWheel);
      if (resetTimeout) clearTimeout(resetTimeout);
    };
  }, [zoomIn, zoomOut]);

  const handleDragMove = useCallback((dx: number, dy: number) => {
    setBounds((b) => ({
      ...b,
      x: Math.max(8 - b.width + 80, Math.min(b.x + dx, window.innerWidth - 80)),
      y: Math.max(8, Math.min(b.y + dy, window.innerHeight - 40)),
    }));
  }, []);
  const { handlers: dragHandlers } = useDrag({ onMove: handleDragMove });

  const handleResizeMove = useCallback((dx: number, dy: number) => {
    setBounds((b) => ({
      ...b,
      width: Math.max(
        MIN_WIDTH,
        Math.min(b.width + dx, window.innerWidth - b.x - 8)
      ),
      height: Math.max(
        MIN_HEIGHT,
        Math.min(b.height + dy, window.innerHeight - b.y - 8)
      ),
    }));
  }, []);
  const handleResizeEnd = useCallback(() => {
    setCommittedWidth(boundsRef.current.width);
  }, []);
  const { handlers: resizeHandlers } = useDrag({
    onMove: handleResizeMove,
    onEnd: handleResizeEnd,
  });

  // 内容区左键拖拽平移（手型工具）。预览体只有 canvas、无文本选区链路，
  // 无需 Space 修饰，常开即可；仅内容溢出时启动（usePanScroll 内置门控），
  // 直写 scrollTop/scrollLeft。capture 阶段拦截，与头部拖动/右下角调大小
  // 的 mousedown 互不干扰（它们在不同元素上）。
  const { isPanning, handlers: panHandlers } = usePanScroll({
    getContainer: () => bodyRef.current,
    active: true,
  });

  // 渲染目标页：按窗口内容宽度 fit-to-width，初次渲染完成后滚动到 dest Y。
  // 不调 page.cleanup()——页面代理与 viewer 共享，viewer 的 PdfPage 自行
  // 管理其渲染资源的释放节奏。
  useEffect(() => {
    let isCancelled = false;
    setStatus("loading");

    const render = async () => {
      try {
        const page = await pdf.getPage(preview.page);
        if (isCancelled) return;

        const canvas = canvasRef.current;
        const body = bodyRef.current;
        if (!canvas || !body) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const contentWidth = body.clientWidth || committedWidth;
        const viewport = page.getViewport({
          scale: (contentWidth / baseViewport.width) * zoom,
        });

        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        // zoom=1 时不设内联宽度，由 CSS width:100% 跟随窗口（resize 拖动中
        // 的即时拉伸反馈）；放大后按视口像素定宽，超出部分走内容区原生滚动。
        // 位图尺寸按 DPR 给足清晰度。
        canvas.style.width = zoom === 1 ? "" : `${viewport.width}px`;

        const context = canvas.getContext("2d");
        if (!context) return;
        context.setTransform(dpr, 0, 0, dpr, 0, 0);

        renderTaskRef.current = page.render({
          canvasContext: context,
          viewport,
        });
        await renderTaskRef.current.promise;
        if (isCancelled) return;

        setStatus("ready");

        // 只在初次渲染后自动定位到条款位置；之后用户滚动/调大小不再重置。
        if (!hasAutoScrolledRef.current) {
          hasAutoScrolledRef.current = true;
          const [, vy] =
            preview.destY !== null
              ? viewport.convertToViewportPoint(0, preview.destY)
              : [0, 0];
          body.scrollTop = Math.max(0, vy - DEST_TOP_MARGIN);
        } else if (pendingScrollRatioRef.current !== null) {
          // 缩放重渲：按比例恢复滚动位置，保持视野大致停留在原内容处。
          const ratio = pendingScrollRatioRef.current;
          pendingScrollRatioRef.current = null;
          body.scrollTop = ratio * body.scrollHeight;
        }
      } catch (err) {
        if (!isCancelled) {
          logError(
            `Failed to render link preview page ${preview.page}: ${err}`
          );
          setStatus("error");
        }
      }
    };

    void render();

    return () => {
      isCancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [pdf, preview.page, preview.destY, committedWidth, zoom]);

  return createPortal(
    <div
      className={`link-preview-popup ${preview.pinned ? "pinned" : ""}`}
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      role="dialog"
      aria-label={t("linkPreview.title", { page: preview.page })}
    >
      <div className="link-preview-header" {...dragHandlers}>
        <button
          className="link-preview-title"
          onClick={() => onGoToPage(preview.page)}
          onMouseDown={(e) => e.stopPropagation()}
          title={t("linkPreview.goToPage", { page: preview.page })}
        >
          {t("linkPreview.title", { page: preview.page })}
        </button>
        <div className="link-preview-actions">
          <button
            className="icon-btn link-preview-zoom-out"
            onClick={zoomOut}
            disabled={zoom <= MIN_ZOOM}
            onMouseDown={(e) => e.stopPropagation()}
            aria-label={t("linkPreview.zoomOut")}
            title={t("linkPreview.zoomOut")}
          >
            <Icon name="zoom-out" size={14} />
          </button>
          <button
            className="icon-btn link-preview-zoom-in"
            onClick={zoomIn}
            disabled={zoom >= MAX_ZOOM}
            onMouseDown={(e) => e.stopPropagation()}
            aria-label={t("linkPreview.zoomIn")}
            title={t("linkPreview.zoomIn")}
          >
            <Icon name="zoom-in" size={14} />
          </button>
          <button
            className={`icon-btn link-preview-pin ${preview.pinned ? "active" : ""}`}
            onClick={() => onTogglePin(preview.id)}
            onMouseDown={(e) => e.stopPropagation()}
            aria-label={t(
              preview.pinned ? "linkPreview.unpin" : "linkPreview.pin"
            )}
            title={t(preview.pinned ? "linkPreview.unpin" : "linkPreview.pin")}
          >
            <Icon name="pin" size={14} />
          </button>
          <button
            className="icon-btn link-preview-close"
            onClick={() => onClose(preview.id)}
            onMouseDown={(e) => e.stopPropagation()}
            aria-label={t("linkPreview.close")}
            title={t("linkPreview.close")}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>
      <div
        className={`link-preview-body${isPanning ? " panning" : ""}`}
        ref={bodyRef}
        {...panHandlers}
      >
        <canvas ref={canvasRef} />
        {status === "loading" && (
          <div className="link-preview-status">{t("linkPreview.loading")}</div>
        )}
        {status === "error" && (
          <div className="link-preview-status error">
            {t("linkPreview.loadFailed")}
          </div>
        )}
      </div>
      <div
        className="link-preview-resize"
        {...resizeHandlers}
        aria-hidden="true"
      />
    </div>,
    document.body
  );
}

export default LinkPreviewPopup;
