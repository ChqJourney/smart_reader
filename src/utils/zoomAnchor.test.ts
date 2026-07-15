import { describe, it, expect } from "vitest";
import {
  findTopVisiblePage,
  findPageAtY,
  toPdfOffset,
  computeRestoredScrollTop,
} from "./zoomAnchor";

describe("findTopVisiblePage", () => {
  it("returns the page spanning the viewport top with the correct offset", () => {
    const pages = [
      { page: 1, top: 0, bottom: 300 },
      { page: 2, top: 324, bottom: 624 }, // 24px gap
      { page: 3, top: 648, bottom: 948 },
    ];
    // viewport top inside page 2
    const r = findTopVisiblePage(pages, 400);
    expect(r).toEqual({ page: 2, offsetPx: 76 });
  });

  it("returns the first page when viewport top is inside it", () => {
    const pages = [
      { page: 1, top: 0, bottom: 300 },
      { page: 2, top: 324, bottom: 624 },
    ];
    expect(findTopVisiblePage(pages, 120)).toEqual({ page: 1, offsetPx: 120 });
  });

  it("clamps offset to 0 when viewport top is above the first page (top padding)", () => {
    const pages = [{ page: 1, top: 24, bottom: 324 }];
    // container top above page top (scrolled to very top with padding)
    expect(findTopVisiblePage(pages, 0)).toEqual({ page: 1, offsetPx: 0 });
  });

  it("falls back to the next page when viewport top is in a gap between pages", () => {
    const pages = [
      { page: 1, top: 0, bottom: 300 },
      { page: 2, top: 324, bottom: 624 },
    ];
    // viewport top at 310 (between page1.bottom=300 and page2.top=324)
    const r = findTopVisiblePage(pages, 310);
    expect(r).toEqual({ page: 2, offsetPx: 0 });
  });

  it("returns the last page when viewport top is past all pages", () => {
    const pages = [
      { page: 1, top: 0, bottom: 300 },
      { page: 2, top: 324, bottom: 624 },
    ];
    const r = findTopVisiblePage(pages, 9999);
    expect(r).toEqual({ page: 2, offsetPx: 624 - 324 }); // bottom - top
  });

  it("returns null for an empty page list", () => {
    expect(findTopVisiblePage([], 100)).toBeNull();
  });
});

describe("findPageAtY", () => {
  const pages = [
    { page: 1, top: 0, bottom: 300 },
    { page: 2, top: 324, bottom: 624 },
    { page: 3, top: 648, bottom: 948 },
  ];

  it("returns the page containing the given Y with the offset from its top", () => {
    expect(findPageAtY(pages, 400)).toEqual({ page: 2, offsetPx: 76 });
    expect(findPageAtY(pages, 50)).toEqual({ page: 1, offsetPx: 50 });
  });

  it("returns null when Y is in a gap between pages", () => {
    expect(findPageAtY(pages, 310)).toBeNull();
  });

  it("returns null when Y is outside all pages", () => {
    expect(findPageAtY(pages, -10)).toBeNull();
    expect(findPageAtY(pages, 9999)).toBeNull();
  });

  it("returns null for an empty page list", () => {
    expect(findPageAtY([], 100)).toBeNull();
  });
});

describe("toPdfOffset", () => {
  it("converts a pixel offset to PDF-space using the old scale", () => {
    expect(toPdfOffset(100, 1.5)).toBeCloseTo(100 / 1.5, 10);
  });

  it("returns 0 for a 0 pixel offset", () => {
    expect(toPdfOffset(0, 2)).toBe(0);
  });
});

describe("computeRestoredScrollTop", () => {
  it("restores the anchor point to the viewport top (button zoom)", () => {
    // pdfOffset 50, newScale 2 -> 100 px into the new page
    expect(computeRestoredScrollTop(1000, 50, 2)).toBe(1100);
  });

  it("offsets by the cursor position for cursor-anchored zoom", () => {
    // anchor point should land 200px below viewport top (under cursor)
    expect(computeRestoredScrollTop(1000, 50, 2, 200)).toBe(900);
  });

  it("handles a zero pdf offset (page-top anchor)", () => {
    expect(computeRestoredScrollTop(500, 0, 3)).toBe(500);
  });
});
