/**
 * Fit-to-width helpers.
 *
 * The viewport entries stored in `pageViewports` are sized for a specific scale
 * (`viewportsForScale`), which is not necessarily the React `scale` state
 * during a zoom transition (the map is kept across scale changes to avoid a
 * 400px-placeholder layout collapse). Dividing a viewport width by the current
 * `scale` instead of the scale the entry was computed for yields a wrong
 * "true" PDF width and therefore a wrong fit scale — the page ends up wider
 * than the container and appears shifted left after horizontal centering.
 */

export interface FitToWidthInput {
  /** Viewport width entry (sized for `entryScale`). */
  viewportWidth: number;
  /** Scale at which the viewport entry was computed. */
  entryScale: number;
  /** Available content width inside the scroll container. */
  containerClientWidth: number;
  /** Horizontal padding on each side of the container. */
  sidePaddingPx: number;
}

/**
 * Compute the scale that makes a page fit the container width.
 *
 * trueWidth = viewportWidth / entryScale  (independent of the live `scale`)
 * targetScale = (containerClientWidth - 2 * sidePaddingPx) / trueWidth
 */
export function computeFitToWidthScale({
  viewportWidth,
  entryScale,
  containerClientWidth,
  sidePaddingPx,
}: FitToWidthInput): number {
  if (entryScale <= 0 || viewportWidth <= 0) return 0;
  const trueWidth = viewportWidth / entryScale;
  const available = containerClientWidth - sidePaddingPx * 2;
  return available / trueWidth;
}

export interface CenterScrollLeftInput {
  /** Current horizontal scroll position of the container. */
  scrollLeft: number;
  /** Viewport-relative left edge of the current page's wrapper. */
  wrapperLeft: number;
  /** Rendered width of the current page's wrapper. */
  wrapperWidth: number;
  /** Viewport-relative left edge of the scroll container. */
  containerLeft: number;
  /** Visible content width of the scroll container (clientWidth). */
  containerWidth: number;
  /** scrollWidth - clientWidth of the container (<= 0 means no overflow). */
  maxScrollLeft: number;
}

/**
 * Compute the scrollLeft that centers the CURRENT page in the container.
 *
 * Centering the page (rather than the whole scrollable content) is immune to
 * off-screen pages that are wider than the container — stale-scale pages of a
 * large document after a zoom-out, or landscape pages in a mixed-size PDF.
 * With the continuous mode's `margin: 0 auto` layout a page that fits exactly
 * resolves to scrollLeft 0, i.e. no horizontal shift at all.
 */
export function computeCenteredScrollLeft({
  scrollLeft,
  wrapperLeft,
  wrapperWidth,
  containerLeft,
  containerWidth,
  maxScrollLeft,
}: CenterScrollLeftInput): number {
  if (maxScrollLeft <= 0) return 0;
  const wrapperCenter = wrapperLeft + wrapperWidth / 2;
  const containerCenter = containerLeft + containerWidth / 2;
  const target = scrollLeft + (wrapperCenter - containerCenter);
  return Math.max(0, Math.min(maxScrollLeft, target));
}
