import { useLayoutEffect, useState } from "react";
import { clampPopupPosition, TransformPx } from "../utils/popupPosition";

/**
 * CSS transform spec for absolutely-positioned popups inside a page wrapper.
 * Most popups use `translate(-50%, 12px)` so the marker sits at the popup's
 * top-center.
 */
export interface PopupTransformSpec {
  /** Horizontal translation as a percentage of the popup width (e.g. -50). */
  xPercent: number;
  /** Vertical translation in pixels (e.g. 12). */
  yPx: number;
}

export const DEFAULT_POPUP_TRANSFORM: PopupTransformSpec = {
  xPercent: -50,
  yPx: 12,
};

/**
 * Track the enclosing `.pdf-page-wrapper` size and return a clamped `left/top`
 * for an absolutely-positioned popup so it stays fully inside the page after
 * initial mount, content changes, dragging, zoom, or async viewport load.
 *
 * Why a ResizeObserver: on tab activation the wrapper starts as a 400px
 * placeholder while the page viewport loads asynchronously. Clamping once at
 * mount would lock the popup against placeholder dimensions; re-clamping on
 * wrapper resize keeps it correct without requiring user interaction.
 */
export function useClampedPopupPosition(
  popupRef: React.RefObject<HTMLElement | null>,
  left: number,
  top: number,
  transform: PopupTransformSpec = DEFAULT_POPUP_TRANSFORM,
  extraDeps: React.DependencyList = []
): { x: number; y: number } {
  const [pos, setPos] = useState({ x: left, y: top });
  const [wrapperSize, setWrapperSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = popupRef.current;
    if (!el) return;
    const wrapper = el.closest(".pdf-page-wrapper") as HTMLElement | null;
    if (!wrapper) return;
    const measure = () =>
      setWrapperSize({
        width: wrapper.offsetWidth,
        height: wrapper.offsetHeight,
      });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrapper);
    return () => ro.disconnect();
  }, [popupRef]);

  useLayoutEffect(() => {
    const el = popupRef.current;
    if (!el) return;
    const popupW = el.offsetWidth;
    const popupH = el.offsetHeight;
    const transformPx: TransformPx = {
      x: (transform.xPercent / 100) * popupW,
      y: transform.yPx,
    };
    setPos(
      clampPopupPosition(
        left,
        top,
        popupW,
        popupH,
        wrapperSize.width,
        wrapperSize.height,
        transformPx
      )
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, top, wrapperSize, transform.xPercent, transform.yPx, ...extraDeps]);

  return pos;
}
