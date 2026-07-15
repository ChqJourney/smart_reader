import { describe, it, expect } from "vitest";
import { computeFitToWidthScale } from "./fitToWidth";

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
