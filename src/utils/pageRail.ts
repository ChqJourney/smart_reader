import type { PageViewportInfo } from "../hooks/useViewportManager";

// 与 PdfViewer.tsx 中的版式常量保持一致：连续模式页间距。
const PAGE_SPACING = 24;

/**
 * 单页模式滑轨映射：pct ∈ [0, 1] → 页码 ∈ [1, numPages]。
 * 越界 pct 会被 clamp，numPages <= 1 时恒为 1。
 */
export function pctToPage(pct: number, numPages: number): number {
  if (numPages <= 1) return 1;
  const clamped = Math.max(0, Math.min(1, pct));
  return Math.max(
    1,
    Math.min(numPages, Math.round(1 + clamped * (numPages - 1)))
  );
}

/**
 * 连续模式滑轨拖动时的页码反查：给定目标 scrollTop，返回它落在哪一页。
 *
 * 逻辑镜像 PdfViewer.computeContinuousScrollTop：按 viewport 累积高度
 * （含页间距）确定每页的纵向区间，找到包含 targetTop 的页。viewport 条目
 * 记录的是自身 scale 下的尺寸，需 rescale 到当前 scale（同
 * computeContinuousScrollTop 的 liveHeight）。
 *
 * viewport 数据不完整（大文档未全部预加载）时，缺失页按已加载页的平均
 * 高度估算，保证拖动全程都有确定性的页码提示。
 */
export function scrollTopToPage(
  targetTop: number,
  pageViewports: Map<number, PageViewportInfo>,
  scale: number,
  numPages: number
): number {
  if (numPages <= 1) return 1;
  if (targetTop <= 0) return 1;

  const liveHeight = (vp: PageViewportInfo) =>
    vp.scale === scale ? vp.height : vp.height * (scale / vp.scale);

  // 缺失 viewport 的页用已加载页的平均高度估算。
  let loadedSum = 0;
  let loadedCount = 0;
  pageViewports.forEach((vp) => {
    loadedSum += liveHeight(vp);
    loadedCount += 1;
  });
  const fallbackHeight = loadedCount > 0 ? loadedSum / loadedCount : 0;

  let top = 0;
  for (let page = 1; page <= numPages; page++) {
    const vp = pageViewports.get(page);
    const height = vp ? liveHeight(vp) : fallbackHeight;
    const pageEnd = top + height;
    if (targetTop < pageEnd || page === numPages) {
      return page;
    }
    top = pageEnd + PAGE_SPACING;
  }
  return numPages;
}
