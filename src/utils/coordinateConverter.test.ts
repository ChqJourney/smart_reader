import { describe, it, expect } from "vitest";
import {
  pdfToWrapper,
  wrapperToPdf,
  clientToWrapper,
  clientToPdf,
  wrapperDeltaToPdf,
} from "./coordinateConverter";

const rect = (left: number, top: number) =>
  ({ left, top, right: 0, bottom: 0, width: 0, height: 0, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

describe("coordinateConverter", () => {
  describe("pdfToWrapper", () => {
    it("scales PDF coordinates to wrapper pixels", () => {
      expect(pdfToWrapper({ x: 10, y: 20 }, 1.5)).toEqual({ x: 15, y: 30 });
    });

    it("is identity at scale 1", () => {
      expect(pdfToWrapper({ x: 7, y: 9 }, 1)).toEqual({ x: 7, y: 9 });
    });

    it("handles zero scale as zero output", () => {
      expect(pdfToWrapper({ x: 10, y: 20 }, 0)).toEqual({ x: 0, y: 0 });
    });
  });

  describe("wrapperToPdf", () => {
    it("divides wrapper pixels by scale", () => {
      expect(wrapperToPdf({ x: 15, y: 30 }, 1.5)).toEqual({ x: 10, y: 20 });
    });

    it("returns 0 for non-positive scale to avoid Infinity/NaN", () => {
      expect(wrapperToPdf({ x: 15, y: 30 }, 0)).toEqual({ x: 0, y: 0 });
      expect(wrapperToPdf({ x: 15, y: 30 }, -2)).toEqual({ x: 0, y: 0 });
    });
  });

  describe("clientToWrapper", () => {
    it("subtracts the rect origin", () => {
      expect(clientToWrapper(100, 200, rect(30, 40))).toEqual({ x: 70, y: 160 });
    });

    it("handles client inside a scrolled wrapper", () => {
      expect(clientToWrapper(50, 60, rect(10, 20))).toEqual({ x: 40, y: 40 });
    });
  });

  describe("clientToPdf", () => {
    it("composes clientToWrapper + wrapperToPdf", () => {
      // wrapper = (100-20, 200-30) = (80, 170); pdf = /2 = (40, 85)
      expect(clientToPdf(100, 200, rect(20, 30), 2)).toEqual({ x: 40, y: 85 });
    });

    it("returns 0 when scale is non-positive", () => {
      expect(clientToPdf(100, 200, rect(20, 30), 0)).toEqual({ x: 0, y: 0 });
    });
  });

  describe("wrapperDeltaToPdf", () => {
    it("scales a drag delta back to PDF space", () => {
      expect(wrapperDeltaToPdf(10, 20, 2)).toEqual({ x: 5, y: 10 });
    });

    it("returns 0 for non-positive scale", () => {
      expect(wrapperDeltaToPdf(10, 20, 0)).toEqual({ x: 0, y: 0 });
    });
  });

  describe("round-trip", () => {
    it("pdfToWrapper then wrapperToPdf recovers the original point", () => {
      const p = { x: 42.5, y: -7.3 };
      const scale = 1.37;
      const back = wrapperToPdf(pdfToWrapper(p, scale), scale);
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    });
  });
});
