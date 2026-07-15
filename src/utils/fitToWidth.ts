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
