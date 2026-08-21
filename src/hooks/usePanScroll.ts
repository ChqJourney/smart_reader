import { useCallback } from "react";
import { useDrag } from "./useDrag";

/**
 * Space 按住期间的临时 pan（手型工具：左键拖拽滚动画布）。
 *
 * 设计要点：
 * - 不触碰文本选区链路：active 时 mousedown 由 useDrag 内部 preventDefault，
 *   浏览器原生选择无法开始；拖动中容器再加 .panning（user-select:none）双保险。
 * - mousedown 在 capture 阶段处理并 stopPropagation：PdfPage 的自定义选区
 *   在子元素的 bubble 阶段启动，capture 拦截才能抢在它之前吞掉事件，
 *   否则 pan 拖动时会同时画出选择框、松手还会误报选区。
 * - 仅内容溢出时才启动拖拽；未溢出时放行 mousedown（不拦截、不吞事件），
 *   文字选择、批注标记点击等默认行为完全不受影响。
 * - 拖拽只是直写 scrollTop/scrollLeft，页码由 useScrollPageSync 的停息重算
 *   收敛，与滚轮滚动走同一条路径，无需额外同步。
 * - 拖动途中松开 Space（active 变 false）不打断本次拖拽，直到 mouseup 收尾。
 */
export interface UsePanScrollOptions {
  /** 返回当前滚动容器（单页/连续模式切换时 ref 目标会变，故用 getter）。 */
  getContainer: () => HTMLElement | null;
  /** 是否处于 pan 态（按住 Space 且当前屏为焦点屏）。 */
  active: boolean;
}

export interface UsePanScrollResult {
  isPanning: boolean;
  /**
   * 展开到滚动容器上。必须用 capture 阶段（见上方设计要点）。
   */
  handlers: { onMouseDownCapture: (e: React.MouseEvent) => void };
}

export function usePanScroll({
  getContainer,
  active,
}: UsePanScrollOptions): UsePanScrollResult {
  const { isDragging, handlers: dragHandlers } = useDrag({
    enabled: active,
    onMove: (dx, dy) => {
      const el = getContainer();
      if (!el) return;
      // 手型工具惯例：内容跟随光标，光标右移 = 视口左移。
      el.scrollLeft -= dx;
      el.scrollTop -= dy;
    },
  });

  const onMouseDownCapture = useCallback(
    (e: React.MouseEvent) => {
      if (!active) return;
      if (e.button !== 0) return;
      const el = getContainer();
      if (!el) return;
      // 未溢出时放行：拖拽什么都不发生，也不压制默认行为。
      const overflowX = el.scrollWidth > el.clientWidth;
      const overflowY = el.scrollHeight > el.clientHeight;
      if (!overflowX && !overflowY) return;
      e.stopPropagation();
      dragHandlers.onMouseDown(e);
    },
    [active, getContainer, dragHandlers]
  );

  return { isPanning: isDragging, handlers: { onMouseDownCapture } };
}
