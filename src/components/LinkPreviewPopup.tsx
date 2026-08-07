import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import * as pdfjsLib from "pdfjs-dist";
import { error as logError } from "../services/logs";
import { useDrag } from "../hooks/useDrag";
import { LinkPreviewState } from "../hooks/useLinkPreviews";
import Icon from "./Icon";
import "./LinkPreviewPopup.css";

const MIN_WIDTH = 260;
const MIN_HEIGHT = 200;
/** 定位到 dest 后向上留出的边距，让条款上方留一点上下文。 */
const DEST_TOP_MARGIN = 12;

interface LinkPreviewPopupProps {
  pdf: pdfjsLib.PDFDocumentProxy;
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
 * 可右下角调大小、内容区原生滚动。位置/尺寸为组件本地状态——弹出后
 * 外部不再关心几何信息，无需回写 hook。
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
  const renderTaskRef = useRef<pdfjsLib.RenderTask | undefined>(undefined);
  const hasAutoScrolledRef = useRef(false);
  const boundsRef = useRef(bounds);
  useEffect(() => {
    boundsRef.current = bounds;
  }, [bounds]);

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
          scale: contentWidth / baseViewport.width,
        });

        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        // CSS 宽度 100%（见样式表），位图尺寸按 DPR 给足清晰度。

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
  }, [pdf, preview.page, preview.destY, committedWidth]);

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
      <div className="link-preview-body" ref={bodyRef}>
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
