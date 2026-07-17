import { describe, it, expect } from "vitest";
import {
  computeFitToWidthScale,
  computeCenteredScrollLeft,
} from "./fitToWidth";

describe("computeFitToWidthScale", () => {
  it("computes the scale that fits the page width to the container", () => {
    // true width = 800/1 = 800; available = 1000 - 48 = 952; scale = 952/800
    const s = computeFitToWidthScale({
      viewportWidth: 800,
      entryScale: 1,
      containerClientWidth: 1000,
      sidePaddingPx: 24,
    });
    expect(s).toBeCloseTo(952 / 800, 10);
  });

  it("uses entryScale (not a stale live scale) to derive the true width", () => {
    // Viewport was computed at scale 0.5 (width 400 = trueWidth 800 * 0.5).
    // The live `scale` state might already be 1.5 during a zoom transition, but
    // the entry is still for 0.5. Dividing by entryScale (0.5) gives the
    // correct true width 800, not the wrong 400/1.5 ~= 267.
    const s = computeFitToWidthScale({
      viewportWidth: 400,
      entryScale: 0.5,
      containerClientWidth: 1000,
      sidePaddingPx: 24,
    });
    // Same true width (800) -> same fit scale as the scale-1 case.
    expect(s).toBeCloseTo(952 / 800, 10);
  });

  it("returns the same fit scale regardless of which scale the entry was stored at", () => {
    const base = computeFitToWidthScale({
      viewportWidth: 800,
      entryScale: 1,
      containerClientWidth: 1000,
      sidePaddingPx: 24,
    });
    const fromZoomed = computeFitToWidthScale({
      viewportWidth: 1600,
      entryScale: 2,
      containerClientWidth: 1000,
      sidePaddingPx: 24,
    });
    expect(fromZoomed).toBeCloseTo(base, 10);
  });

  it("returns 0 for non-positive entry scale or viewport width", () => {
    expect(
      computeFitToWidthScale({
        viewportWidth: 800,
        entryScale: 0,
        containerClientWidth: 1000,
        sidePaddingPx: 24,
      })
    ).toBe(0);
    expect(
      computeFitToWidthScale({
        viewportWidth: 0,
        entryScale: 1,
        containerClientWidth: 1000,
        sidePaddingPx: 24,
      })
    ).toBe(0);
  });
});

describe("computeCenteredScrollLeft", () => {
  const baseInput = {
    scrollLeft: 0,
    wrapperLeft: 0,
    wrapperWidth: 800,
    containerLeft: 0,
    containerWidth: 800,
    maxScrollLeft: 0,
  };

  it("returns 0 when the content does not overflow horizontally", () => {
    expect(computeCenteredScrollLeft(baseInput)).toBe(0);
  });

  it("keeps an exactly-fitting page at scrollLeft 0 even when other pages overflow (fit-to-width left-shift regression)", () => {
    // The reported bug: after fit-to-width, off-screen pages still rendered
    // WIDER than the container (stale-scale sizes / mixed page sizes), so
    // scrollWidth > clientWidth and centering the CONTENT pushed the fitted
    // page left by (scrollWidth - clientWidth) / 2. The current page fills
    // the container exactly (wrapperLeft === containerLeft, widths equal), so
    // its center already matches the container center → scrollLeft stays 0.
    expect(
      computeCenteredScrollLeft({
        scrollLeft: 130,
        wrapperLeft: -130, // page's left edge is flush with the container's
        wrapperWidth: 800,
        containerLeft: 0,
        containerWidth: 800,
        maxScrollLeft: 260, // some off-screen page is 260px wider
      })
    ).toBe(0);
  });

  it("scrolls right to center a page that sits right of the container center", () => {
    expect(
      computeCenteredScrollLeft({
        scrollLeft: 0,
        wrapperLeft: 200, // wrapper center = 200 + 300 = 500 vs container 400
        wrapperWidth: 600,
        containerLeft: 0,
        containerWidth: 800,
        maxScrollLeft: 400,
      })
    ).toBe(100);
  });

  it("clamps the result to [0, maxScrollLeft]", () => {
    expect(
      computeCenteredScrollLeft({
        scrollLeft: 0,
        wrapperLeft: -500,
        wrapperWidth: 600,
        containerLeft: 0,
        containerWidth: 800,
        maxScrollLeft: 400,
      })
    ).toBe(0);
    expect(
      computeCenteredScrollLeft({
        scrollLeft: 390,
        wrapperLeft: -390 + 500, // far right
        wrapperWidth: 600,
        containerLeft: 0,
        containerWidth: 800,
        maxScrollLeft: 400,
      })
    ).toBe(400);
  });
});
