import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { error as logError } from "../services/logs";

/**
 * 条款链接悬停预览（画中画）状态管理。
 *
 * 交互模型：
 * - PdfPage 命中带内部 dest 的链接注释时上报 hover（onLinkHover），
 *   持续悬停 LINK_PREVIEW_HOVER_DELAY_MS 后弹出预览小窗。
 * - 同一目标（页码 + dest Y）去重：已存在 pinned/transient 预览时不重复创建。
 * - transient（未固化）预览同时只存在一个：弹新预览时关掉上一个；
 *   鼠标离开链接后 LINK_PREVIEW_CLOSE_GRACE_MS 宽限期内未进入窗口则关闭。
 * - pinned（固化）预览不随鼠标移出关闭，可多个并存，总数上限
 *   MAX_LINK_PREVIEWS；全部固化且达上限时不再创建新预览。
 * - 生命周期跟随挂载它的 PdfViewer（keep-alive 切 tab 保留、关 tab 销毁），
 *   不做跨会话持久化。
 */

export const LINK_PREVIEW_HOVER_DELAY_MS = 2000;
export const LINK_PREVIEW_CLOSE_GRACE_MS = 400;
export const MAX_LINK_PREVIEWS = 10;
export const LINK_PREVIEW_DEFAULT_WIDTH = 520;
export const LINK_PREVIEW_DEFAULT_HEIGHT = 400;

/** PdfPage 上报的链接悬停信息（仅内部 dest 链接，外部 url 不上报）。 */
export interface LinkHoverInfo {
  dest: unknown;
  clientX: number;
  clientY: number;
}

export interface LinkPreviewTarget {
  /** 目标页码（1-based）。 */
  page: number;
  /** dest 的 Y 坐标（PDF 用户空间，原点在左下）；null 表示页首。 */
  destY: number | null;
}

export interface LinkPreviewState extends LinkPreviewTarget {
  id: string;
  /** 去重键：`${page}:${destY}`。 */
  key: string;
  /** 初始位置（client 坐标）与尺寸，弹出后由组件本地管理拖动/调大小。 */
  x: number;
  y: number;
  width: number;
  height: number;
  pinned: boolean;
}

/**
 * 从 dest 数组提取目标 Y 坐标。条款链接最常见的是 XYZ（显式坐标）与
 * FitH（整页宽对齐到某高度），其余形态（Fit / FitR / 具名引用页）退化为页首。
 */
export function extractDestY(dest: unknown[]): number | null {
  const named = dest[1] as { name?: string } | undefined;
  const name = named?.name;
  if (name === "XYZ") {
    return typeof dest[3] === "number" ? dest[3] : null;
  }
  if (name === "FitH" || name === "FitBH") {
    return typeof dest[2] === "number" ? dest[2] : null;
  }
  return null;
}

/**
 * 解析链接 dest 为目标页 + Y 坐标。dest 可能是具名字符串（需
 * getDestination 查表）或直接数组；解析失败（坏引用、外部文件跳转）返回 null。
 */
export async function resolveLinkDest(
  pdf: pdfjsLib.PDFDocumentProxy,
  rawDest: unknown
): Promise<LinkPreviewTarget | null> {
  try {
    const dest =
      typeof rawDest === "string" ? await pdf.getDestination(rawDest) : rawDest;
    if (!dest || !Array.isArray(dest)) return null;
    const ref = dest[0];
    if (ref === null || ref === undefined) return null;
    const pageIndex = await pdf.getPageIndex(ref);
    return { page: pageIndex + 1, destY: extractDestY(dest) };
  } catch (err) {
    logError(`Failed to resolve link preview destination: ${err}`);
    return null;
  }
}

function previewKey(target: LinkPreviewTarget): string {
  return `${target.page}:${target.destY === null ? "top" : Math.round(target.destY)}`;
}

/** 初始位置：链接右下方，clamp 在视口内。 */
function initialPosition(
  clientX: number,
  clientY: number
): {
  x: number;
  y: number;
} {
  const x = Math.max(
    8,
    Math.min(clientX + 16, window.innerWidth - LINK_PREVIEW_DEFAULT_WIDTH - 8)
  );
  const y = Math.max(
    8,
    Math.min(clientY + 16, window.innerHeight - LINK_PREVIEW_DEFAULT_HEIGHT - 8)
  );
  return { x, y };
}

export interface UseLinkPreviewsResult {
  previews: LinkPreviewState[];
  /** PdfPage 悬停变化回调（内部 dest 链接 → 信息，否则 → null）。 */
  handleLinkHover: (hover: LinkHoverInfo | null) => void;
  /** 鼠标进入预览窗口：取消宽限关闭计时。 */
  handlePreviewEnter: () => void;
  /** 鼠标离开预览窗口：未固化则重新计时宽限关闭。 */
  handlePreviewLeave: () => void;
  togglePreviewPin: (id: string) => void;
  closePreview: (id: string) => void;
  /** 清空全部预览（设置开关关闭时调用）。 */
  closeAllPreviews: () => void;
}

export function useLinkPreviews({
  pdf,
}: {
  pdf: pdfjsLib.PDFDocumentProxy | null;
}): UseLinkPreviewsResult {
  const [previews, setPreviews] = useState<LinkPreviewState[]>([]);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idCounterRef = useRef(0);

  // Live refs：定时器回调读最新值，保证 handleLinkHover 引用稳定
  // （PdfPage 是 memo 组件，回调身份变化会让所有页重渲染）。
  const pdfRef = useRef(pdf);
  useEffect(() => {
    pdfRef.current = pdf;
  }, [pdf]);
  const previewsRef = useRef(previews);
  useEffect(() => {
    previewsRef.current = previews;
  }, [previews]);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleCloseTransient = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setPreviews((prev) => prev.filter((p) => p.pinned));
    }, LINK_PREVIEW_CLOSE_GRACE_MS);
  }, [clearCloseTimer]);

  const showPreview = useCallback(
    async (hover: LinkHoverInfo) => {
      const doc = pdfRef.current;
      if (!doc) return;
      const target = await resolveLinkDest(doc, hover.dest);
      if (!target) return;
      const key = previewKey(target);
      // 已存在同目标预览（无论固化与否）：不重复弹，仅取消可能的关闭计时。
      if (previewsRef.current.some((p) => p.key === key)) {
        clearCloseTimer();
        return;
      }
      const { x, y } = initialPosition(hover.clientX, hover.clientY);
      setPreviews((prev) => {
        // transient 预览同时只留一个；固化的全部保留。
        const pinned = prev.filter((p) => p.pinned);
        if (pinned.length >= MAX_LINK_PREVIEWS) return prev;
        idCounterRef.current += 1;
        return [
          ...pinned,
          {
            id: `link-preview-${idCounterRef.current}`,
            key,
            ...target,
            x,
            y,
            width: LINK_PREVIEW_DEFAULT_WIDTH,
            height: LINK_PREVIEW_DEFAULT_HEIGHT,
            pinned: false,
          },
        ];
      });
    },
    [clearCloseTimer]
  );

  const handleLinkHover = useCallback(
    (hover: LinkHoverInfo | null) => {
      clearHoverTimer();
      if (!hover) {
        scheduleCloseTransient();
        return;
      }
      // 悬停在链接上期间取消宽限关闭（用户从窗口移回链接的场景）。
      clearCloseTimer();
      hoverTimerRef.current = setTimeout(() => {
        hoverTimerRef.current = null;
        void showPreview(hover);
      }, LINK_PREVIEW_HOVER_DELAY_MS);
    },
    [clearHoverTimer, clearCloseTimer, scheduleCloseTransient, showPreview]
  );

  const handlePreviewEnter = useCallback(() => {
    clearCloseTimer();
  }, [clearCloseTimer]);

  const handlePreviewLeave = useCallback(() => {
    scheduleCloseTransient();
  }, [scheduleCloseTransient]);

  const togglePreviewPin = useCallback((id: string) => {
    setPreviews((prev) =>
      prev.map((p) => (p.id === id ? { ...p, pinned: !p.pinned } : p))
    );
  }, []);

  const closePreview = useCallback((id: string) => {
    setPreviews((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const closeAllPreviews = useCallback(() => {
    clearHoverTimer();
    clearCloseTimer();
    setPreviews((prev) => (prev.length === 0 ? prev : []));
  }, [clearHoverTimer, clearCloseTimer]);

  // 卸载时清理定时器，避免切 tab 销毁 viewer 后定时器写 unmounted state。
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
      if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    };
  }, []);

  return {
    previews,
    handleLinkHover,
    handlePreviewEnter,
    handlePreviewLeave,
    togglePreviewPin,
    closePreview,
    closeAllPreviews,
  };
}
