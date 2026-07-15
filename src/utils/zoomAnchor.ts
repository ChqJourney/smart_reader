/**
 * Zoom scroll-anchor utilities.
 *
 * When the PDF scale changes, every page height scales proportionally, so a
 * fixed `scrollTop` (in pixels) ends up pointing at a different location in the
 * document. These helpers capture the visible location in PDF-space *before* the
 * scale change and recompute the `scrollTop` *after* the new layout settles, so
 * the same document point stays under the viewport top (or under the cursor).
 */

export interface PageRect {
  page: number;
  /** Viewport-relative top of the page wrapper. */
  top: number;
  /** Viewport-relative bottom of the page wrapper. */
  bottom: number;
}

export interface AnchorResult {
  page: number;
  /**
   * Distance from the anchor page's top to the viewport top, in pixels.
   * >= 0 when the page top is at or above the viewport top.
   */
  offsetPx: number;
}

/**
 * Find the page whose top edge is at or above the viewport top and whose bottom
 * is below the viewport top (the page "spanning" the viewport top). The pixel
 * offset from that page's top to the viewport top is returned.
 *
 * Edge cases:
 *  - Viewport top above the first page (top padding): returns the first page
 *    with offset 0.
 *  - Viewport top in a gap between pages: returns the next page with offset 0.
 *  - Viewport top past every page: returns the last page with its full height
 *    as offset.
 *  - Empty list: returns null.
 */
export function findTopVisiblePage(
  pages: PageRect[],
  viewportTop: number
): AnchorResult | null {
  if (pages.length === 0) return null;

  for (const p of pages) {
    if (p.top <= viewportTop && p.bottom > viewportTop) {
      return { page: p.page, offsetPx: viewportTop - p.top };
    }
  }

  // Viewport top is not inside any page. Pick the first page whose bottom is
  // below the viewport top (the first visible page when scrolled into padding or
  // a gap). Clamp offset to 0 since the page top is below the viewport top.
  const firstBelow = pages.find((p) => p.bottom > viewportTop);
  if (firstBelow) {
    return { page: firstBelow.page, offsetPx: 0 };
  }

  // Past the last page: anchor on the last page at its bottom.
  const last = pages[pages.length - 1];
  return { page: last.page, offsetPx: last.bottom - last.top };
}

/**
 * Find the page whose vertical extent contains the given viewport Y coordinate
 * (used for cursor-anchored Ctrl+wheel zoom). Returns null when Y falls in a
 * gap between pages or outside every page.
 */
export function findPageAtY(
  pages: PageRect[],
  clientY: number
): AnchorResult | null {
  for (const p of pages) {
    if (clientY >= p.top && clientY < p.bottom) {
      return { page: p.page, offsetPx: clientY - p.top };
    }
  }
  return null;
}

/**
 * Convert a pixel offset within a page to PDF-space (scale-independent).
 */
export function toPdfOffset(offsetPx: number, oldScale: number): number {
  if (oldScale <= 0) return 0;
  return offsetPx / oldScale;
}

/**
 * Recompute the scroll container's `scrollTop` so the captured PDF-space anchor
 * point lands at the desired position in the viewport.
 *
 * @param newPageScrollTop  scrollTop of the anchor page's top under the new scale
 * @param pdfOffset         PDF-space offset of the anchor point from the page top
 * @param newScale          scale after the zoom
 * @param anchorViewportOffsetPx  how far below the viewport top the anchor point
 *   should sit (0 = viewport top, used for button zoom; cursor-relative offset
 *   used for Ctrl+wheel zoom)
 */
export function computeRestoredScrollTop(
  newPageScrollTop: number,
  pdfOffset: number,
  newScale: number,
  anchorViewportOffsetPx = 0
): number {
  return newPageScrollTop + pdfOffset * newScale - anchorViewportOffsetPx;
}
