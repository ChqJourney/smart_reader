import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { pctToPage, scrollTopToPage } from "../utils/pageRail";
import type { PageViewportInfo } from "../hooks/useViewportManager";
import "./PageRail.css";

interface PageRailProps {
  viewMode: "single" | "continuous";
  pageNum: number;
  numPages: number;
  continuousContainerRef: RefObject<HTMLDivElement | null>;
  pageViewportsRef: RefObject<Map<number, PageViewportInfo>>;
  scaleRef: RefObject<number>;
  goToPage: (page: number) => void;
}

/**
 * 右侧页码滑轨：替换原生垂直滚动条（CSS 隐藏），拖动时显示页码 tooltip。
 *
 * - 连续模式：thumb 位置 = scrollTop / maxScroll；拖动直接写容器 scrollTop
 *   （用户滚动，不走 goToPage 的 jump lock），页码由 useScrollPageSync 即时
 *   同步，tooltip 用 scrollTopToPage 反查保证不滞后。
 * - 单页模式：thumb 位置 = (pageNum - 1) / (numPages - 1)；拖动按 pct 映射
 *   页码调 goToPage。
 * thumb / tooltip 均通过 ref 直接写 DOM，避免滚动/拖动高频触发 React 渲染。
 */
export default function PageRail({
  viewMode,
  pageNum,
  numPages,
  continuousContainerRef,
  pageViewportsRef,
  scaleRef,
  goToPage,
}: PageRailProps) {
  const { t } = useTranslation();
  const railRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  // 非受控 DOM 写入辅助。
  const setThumb = useCallback((pct: number) => {
    const clamped = Math.max(0, Math.min(1, pct));
    if (fillRef.current) fillRef.current.style.height = `${clamped * 100}%`;
    if (thumbRef.current) thumbRef.current.style.top = `${clamped * 100}%`;
  }, []);
  const setTip = useCallback(
    (page: number) => {
      if (tipRef.current) tipRef.current.textContent = `${page} / ${numPages}`;
    },
    [numPages]
  );

  // 外部状态（滚动 / 翻页 / 模式切换）→ thumb 位置同步。
  // 连续模式同时挂 scroll 监听（rAF 节流），滚动过程中 thumb 实时跟随。
  useEffect(() => {
    if (numPages <= 1) return;
    setTip(pageNum);

    if (viewMode === "single") {
      setThumb((pageNum - 1) / (numPages - 1));
      return;
    }

    const container = continuousContainerRef.current;
    if (!container) return;

    const syncFromScroll = () => {
      const max = container.scrollHeight - container.clientHeight;
      setThumb(max > 0 ? container.scrollTop / max : 0);
    };
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!draggingRef.current) syncFromScroll();
      });
    };
    syncFromScroll();
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [viewMode, pageNum, numPages, continuousContainerRef, setThumb, setTip]);

  // 拖动：pct → 连续模式写 scrollTop / 单页模式 goToPage。
  const applyClientY = (clientY: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    if (rect.height <= 0) return;
    const pct = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    setThumb(pct);

    if (viewMode === "continuous") {
      const container = continuousContainerRef.current;
      if (!container) return;
      const max = container.scrollHeight - container.clientHeight;
      const targetTop = pct * max;
      container.scrollTop = targetTop;
      setTip(
        scrollTopToPage(
          targetTop,
          pageViewportsRef.current ?? new Map(),
          scaleRef.current ?? 1,
          numPages
        )
      );
    } else {
      const page = pctToPage(pct, numPages);
      goToPage(page);
      setTip(page);
    }
  };

  const endDrag = () => {
    draggingRef.current = false;
    railRef.current?.classList.remove("dragging");
  };

  if (numPages <= 1) return null;

  return (
    <div
      ref={railRef}
      className="page-rail"
      role="slider"
      aria-label={t("pdf.pageRail")}
      aria-valuemin={1}
      aria-valuemax={numPages}
      aria-valuenow={pageNum}
      tabIndex={-1}
      onPointerDown={(e) => {
        e.preventDefault();
        draggingRef.current = true;
        railRef.current?.classList.add("dragging");
        railRef.current?.setPointerCapture(e.pointerId);
        applyClientY(e.clientY);
      }}
      onPointerMove={(e) => {
        if (draggingRef.current) applyClientY(e.clientY);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div ref={trackRef} className="page-rail-track">
        <div ref={fillRef} className="page-rail-fill" />
        <div ref={thumbRef} className="page-rail-thumb" />
      </div>
      <div ref={tipRef} className="page-rail-tip" />
    </div>
  );
}
