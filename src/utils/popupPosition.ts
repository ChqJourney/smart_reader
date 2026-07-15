/**
 * Popup position clamping utilities.
 *
 * Popups (translate / explain / stash) are absolutely positioned inside a
 * `.pdf-page-wrapper` and may carry a CSS `transform: translate(...)`. The
 * transform shifts the visual box relative to the `left`/`top` CSS values, so
 * boundary clamping must account for the resolved pixel translation, not just
 * the raw box geometry.
 */

export interface TransformPx {
  /** Resolved horizontal translation in px (e.g. -50% of popup width). */
  x: number;
  /** Resolved vertical translation in px (e.g. 12). */
  y: number;
}

export interface ClampedPosition {
  x: number;
  y: number;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return value; // degenerate range: don't force a value
  const clamped = Math.max(min, Math.min(max, value));
  // Normalize -0 to 0 so callers get stable numeric output.
  return clamped === 0 ? 0 : clamped;
}

/**
 * Clamp a popup's `left`/`top` so its visual box (after the given CSS transform)
 * stays fully inside the wrapper rectangle.
 *
 * Visual box edges after transform:
 *   left   = left + transformPx.x
 *   right  = left + transformPx.x + popupW
 *   top    = top  + transformPx.y
 *   bottom = top  + transformPx.y + popupH
 *
 * Allowed CSS range so visual box stays within [0, wrapperW] x [0, wrapperH]:
 *   left in [-transformPx.x, wrapperW - popupW - transformPx.x]
 *   top  in [-transformPx.y, wrapperH - popupH - transformPx.y]
 *
 * When the wrapper dimensions are 0 (not measured yet) or the popup is larger
 * than the wrapper (degenerate range), the original position is returned
 * unchanged rather than forcing it off-screen.
 */
export function clampPopupPosition(
  left: number,
  top: number,
  popupW: number,
  popupH: number,
  wrapperW: number,
  wrapperH: number,
  transformPx: TransformPx
): ClampedPosition {
  if (wrapperW <= 0 || wrapperH <= 0) {
    return { x: left, y: top };
  }

  const minX = -transformPx.x;
  const maxX = wrapperW - popupW - transformPx.x;
  const minY = -transformPx.y;
  const maxY = wrapperH - popupH - transformPx.y;

  return {
    x: clamp(left, minX, maxX),
    y: clamp(top, minY, maxY),
  };
}

/**
 * Resolve a CSS transform string of the form `translate(<x>, <y>)` where each
 * component is either a percentage of the popup dimension (e.g. "-50%") or a
 * fixed pixel value (e.g. "12px") into concrete pixel offsets.
 *
 * Returns `{ x: 0, y: 0 }` when the transform cannot be parsed.
 */
export function resolveTransformPx(
  transform: string | undefined,
  popupW: number,
  popupH: number
): TransformPx {
  if (!transform) return { x: 0, y: 0 };
  const match = transform.match(
    /translate\(\s*(-?[\d.]+)(%|px)?\s*,\s*(-?[\d.]+)(%|px)?\s*\)/
  );
  if (!match) return { x: 0, y: 0 };

  const xVal = parseFloat(match[1]);
  const xUnit = match[2] ?? "px";
  const yVal = parseFloat(match[3]);
  const yUnit = match[4] ?? "px";

  return {
    x: xUnit === "%" ? (xVal / 100) * popupW : xVal,
    y: yUnit === "%" ? (yVal / 100) * popupH : yVal,
  };
}
