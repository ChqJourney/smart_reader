/**
 * Coordinate conversion utilities.
 *
 * PDF rendering involves three coordinate systems that are constantly
 * converted between (see docs/PDF_RENDERING_AND_OVERLAYS.md §3):
 *
 *  - PDF original space: scale-independent, used for persisted annotation
 *    positions (`annotation.position.x/y`).
 *  - Wrapper space: pixel coordinates inside `.pdf-page-wrapper` (= PDF
 *    original * scale), used by all in-page overlays/highlights.
 *  - Screen space: `clientX/clientY`, only used by SelectionToolbar
 *    (`position: fixed`).
 *
 * Historically every consumer recomputed `* scale` / `/ scale` /
 * `client - rect.left` inline, which made the coordinate assumptions implicit
 * and easy to get wrong. These pure functions centralize the conversions so
 * the intent is explicit and unit-testable.
 */

export interface Point {
  x: number;
  y: number;
}

/**
 * Convert a point from PDF original space to wrapper space (rendering).
 * `wrapper = pdf * scale`.
 */
export function pdfToWrapper(p: Point, scale: number): Point {
  return { x: p.x * scale, y: p.y * scale };
}

/**
 * Convert a point from wrapper space to PDF original space (persistence).
 * `pdf = wrapper / scale`. Returns `{0,0}` for non-positive scale to avoid
 * `Infinity`/`NaN` poisoning downstream state.
 */
export function wrapperToPdf(p: Point, scale: number): Point {
  if (scale <= 0) return { x: 0, y: 0 };
  return { x: p.x / scale, y: p.y / scale };
}

/**
 * Convert a screen (`clientX/clientY`) position to wrapper space given the
 * wrapper's bounding rect. Used to locate a selection/mouse inside a page.
 */
export function clientToWrapper(
  clientX: number,
  clientY: number,
  rect: DOMRect
): Point {
  return { x: clientX - rect.left, y: clientY - rect.top };
}

/**
 * Convert a screen (`clientX/clientY`) position all the way to PDF original
 * space. Composes `clientToWrapper` + `wrapperToPdf`. Convenience for the
 * selection-report path (`PdfPage.onSelection`).
 */
export function clientToPdf(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  scale: number
): Point {
  const wrapper = clientToWrapper(clientX, clientY, rect);
  return wrapperToPdf(wrapper, scale);
}

/**
 * Convert a wrapper-space delta (e.g. accumulated drag in pixels) to a PDF
 * original delta. Used when persisting drag moves so the stored position is
 * scale-independent.
 */
export function wrapperDeltaToPdf(dx: number, dy: number, scale: number): Point {
  return wrapperToPdf({ x: dx, y: dy }, scale);
}
