import { describe, it, expect } from "vitest";
import { clampPopupPosition, resolveTransformPx } from "./popupPosition";

describe("clampPopupPosition", () => {
  it("returns position unchanged when popup fits within wrapper (no transform)", () => {
    const r = clampPopupPosition(50, 60, 100, 80, 400, 600, { x: 0, y: 0 });
    expect(r).toEqual({ x: 50, y: 60 });
  });

  it("clamps to the right edge when popup overflows horizontally (no transform)", () => {
    // left 350 + width 100 = 450 > 400 -> clamp to 300
    const r = clampPopupPosition(350, 60, 100, 80, 400, 600, { x: 0, y: 0 });
    expect(r.x).toBe(300);
    expect(r.y).toBe(60);
  });

  it("clamps to the bottom edge when popup overflows vertically (no transform)", () => {
    const r = clampPopupPosition(50, 560, 100, 80, 400, 600, { x: 0, y: 0 });
    expect(r.x).toBe(50);
    expect(r.y).toBe(520);
  });

  it("clamps left/top to 0 when negative (no transform)", () => {
    const r = clampPopupPosition(-20, -30, 100, 80, 400, 600, { x: 0, y: 0 });
    expect(r).toEqual({ x: 0, y: 0 });
  });

  it("accounts for translateX(-50%): center point range is [pw/2, wrapperW - pw/2]", () => {
    // popup width 100, translateX = -50px (-50% of 100)
    const tx = { x: -50, y: 12 };
    // left edge = left - 50; right edge = left + 50
    // fully visible: left in [50, 350]
    // overflow right: left=380 -> right edge 430 > 400 -> clamp to 350
    const r = clampPopupPosition(380, 60, 100, 80, 400, 600, tx);
    expect(r.x).toBe(350);
    // overflow left: left=10 -> left edge -40 < 0 -> clamp to 50
    const r2 = clampPopupPosition(10, 60, 100, 80, 400, 600, tx);
    expect(r2.x).toBe(50);
  });

  it("accounts for translateY(12px): top range is [-12, wrapperH - popupH - 12]", () => {
    const tx = { x: -50, y: 12 };
    // top = 600 -> visual bottom = 600 + 12 + 80 = 692 > 600 -> clamp to 600 - 80 - 12 = 508
    const r = clampPopupPosition(200, 600, 100, 80, 400, 600, tx);
    expect(r.y).toBe(508);
  });

  it("returns unclamped position when wrapper dimensions are 0 (not ready)", () => {
    const r = clampPopupPosition(9999, 9999, 100, 80, 0, 0, { x: 0, y: 0 });
    expect(r).toEqual({ x: 9999, y: 9999 });
  });

  it("returns unclamped position when popup is larger than wrapper (degenerate)", () => {
    // popup 500x500 in wrapper 400x600 -> maxX < minX -> don't force negative
    const r = clampPopupPosition(200, 100, 500, 500, 400, 600, { x: 0, y: 0 });
    expect(r).toEqual({ x: 200, y: 100 });
  });

  it("keeps a centered popup that already fits unchanged with translate(-50%, 12px)", () => {
    const tx = { x: -50, y: 12 };
    // left=200, top=300, pw=100, ph=80, wrapper 400x600
    // visual left=150, right=250 (ok), visual top=312, bottom=392 (ok)
    const r = clampPopupPosition(200, 300, 100, 80, 400, 600, tx);
    expect(r).toEqual({ x: 200, y: 300 });
  });
});

describe("resolveTransformPx", () => {
  it("resolves translate(-50%, 12px) into pixel offsets", () => {
    expect(resolveTransformPx("translate(-50%, 12px)", 100, 80)).toEqual({
      x: -50,
      y: 12,
    });
  });

  it("resolves percentage Y against popup height", () => {
    expect(resolveTransformPx("translate(-50%, -100%)", 100, 80)).toEqual({
      x: -50,
      y: -80,
    });
  });

  it("treats unitless values as px", () => {
    expect(resolveTransformPx("translate(10, 20)", 100, 80)).toEqual({
      x: 10,
      y: 20,
    });
  });

  it("returns zero offsets for undefined / unparseable transforms", () => {
    expect(resolveTransformPx(undefined, 100, 80)).toEqual({ x: 0, y: 0 });
    expect(resolveTransformPx("scale(2)", 100, 80)).toEqual({ x: 0, y: 0 });
  });
});
