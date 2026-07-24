import { describe, it, expect } from "vitest";
import { pctToPage, scrollTopToPage } from "./pageRail";
import type { PageViewportInfo } from "../hooks/useViewportManager";

const PAGE_SPACING = 24;

function vp(height: number, scale = 1): PageViewportInfo {
  return { width: height / 2, height, scale };
}

function uniformViewports(
  numPages: number,
  height: number,
  scale = 1
): Map<number, PageViewportInfo> {
  const map = new Map<number, PageViewportInfo>();
  for (let p = 1; p <= numPages; p++) map.set(p, vp(height, scale));
  return map;
}

describe("pctToPage", () => {
  it("maps 0 → first page and 1 → last page", () => {
    expect(pctToPage(0, 240)).toBe(1);
    expect(pctToPage(1, 240)).toBe(240);
  });

  it("rounds to the nearest page", () => {
    // pct 0.5 on 11 pages → page 6
    expect(pctToPage(0.5, 11)).toBe(6);
  });

  it("clamps out-of-range pct", () => {
    expect(pctToPage(-0.5, 100)).toBe(1);
    expect(pctToPage(1.5, 100)).toBe(100);
  });

  it("returns 1 when numPages <= 1", () => {
    expect(pctToPage(0.7, 1)).toBe(1);
    expect(pctToPage(0.7, 0)).toBe(1);
  });
});

describe("scrollTopToPage", () => {
  it("finds the page containing the target scrollTop", () => {
    const vps = uniformViewports(10, 100);
    // Page 1 spans [0, 100), page 2 starts at 124.
    expect(scrollTopToPage(0, vps, 1, 10)).toBe(1);
    expect(scrollTopToPage(99, vps, 1, 10)).toBe(1);
    expect(scrollTopToPage(124, vps, 1, 10)).toBe(2);
    expect(scrollTopToPage(2 * (100 + PAGE_SPACING), vps, 1, 10)).toBe(3);
  });

  it("clamps to the last page beyond the document end", () => {
    const vps = uniformViewports(10, 100);
    expect(scrollTopToPage(99999, vps, 1, 10)).toBe(10);
  });

  it("returns 1 when numPages <= 1", () => {
    expect(scrollTopToPage(50, new Map(), 1, 1)).toBe(1);
  });

  it("rescales entries stored at a stale scale", () => {
    // Entries stored at scale 1 (height 100), live scale 2 → live height 200.
    const vps = uniformViewports(10, 100, 1);
    // Page 2 live span starts at 200 + 24.
    expect(scrollTopToPage(224, vps, 2, 10)).toBe(2);
  });

  it("falls back to the average loaded height for missing viewports", () => {
    // Only pages 1-2 loaded at height 100; target far beyond → estimate with
    // stride 124: page n starts at (n-1)*124. 4*124=496 → page 5.
    const vps = uniformViewports(2, 100);
    expect(scrollTopToPage(496, vps, 1, 60)).toBe(5);
  });

  it("handles an empty viewport map without crashing", () => {
    // All heights 0 → every target lands on page 1 (or numPages at the end).
    expect(scrollTopToPage(0, new Map(), 1, 60)).toBe(1);
    expect(scrollTopToPage(9999, new Map(), 1, 60)).toBe(60);
  });
});
