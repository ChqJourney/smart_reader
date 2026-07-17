import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useScrollPageSync } from "./useScrollPageSync";

/**
 * jsdom does not perform layout, so getBoundingClientRect returns all-zero
 * rects by default. These tests stub the container and page wrappers with
 * explicit geometry so the page-detection math (top-edge-closest) is
 * exercised deterministically.
 */

function makeEl(rect: { top: number; bottom: number }) {
  const el = document.createElement("div");
  (el as any).getBoundingClientRect = () => ({
    top: rect.top,
    bottom: rect.bottom,
    left: 0,
    right: 800,
    width: 800,
    height: rect.bottom - rect.top,
    x: 0,
    y: rect.top,
    toJSON: () => ({}),
  });
  (el as any).scrollTop = 0;
  // Keep native addEventListener/removeEventListener so dispatchEvent actually
  // invokes the registered listener; tests spy on them to assert calls.
  return el as unknown as HTMLDivElement;
}

function makeOptions() {
  const container = makeEl({ top: 0, bottom: 600 });
  const page1 = makeEl({ top: 0, bottom: 300 });
  const page2 = makeEl({ top: 324, bottom: 624 });
  const page3 = makeEl({ top: 648, bottom: 948 });
  const pageWrapperRefs = {
    current: [page1, page2, page3],
  } as React.MutableRefObject<(HTMLDivElement | null)[]>;

  return {
    base: {
      viewMode: "continuous" as const,
      scale: 1.5,
      onStateChange: vi.fn(),
      continuousContainerRef: { current: container },
      pageWrapperRefs,
      pageNumRef: { current: 1 },
      setPageNum: vi.fn(),
      isJumpingRef: { current: false },
      isZoomingRef: { current: false },
    },
    container,
    page1,
    page2,
    page3,
  };
}

describe("useScrollPageSync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not attach a scroll listener in single mode", () => {
    const { base, container } = makeOptions();
    const addSpy = vi.spyOn(container, "addEventListener");
    renderHook(() =>
      useScrollPageSync({ ...base, viewMode: "single" })
    );
    // In single mode the effect returns early before addEventListener.
    expect(addSpy).not.toHaveBeenCalledWith("scroll", expect.any(Function));
  });

  it("attaches a scroll listener in continuous mode", () => {
    const { base, container } = makeOptions();
    const addSpy = vi.spyOn(container, "addEventListener");
    renderHook(() => useScrollPageSync(base));
    expect(addSpy).toHaveBeenCalledWith("scroll", expect.any(Function));
  });

  it("removes the scroll listener on unmount", () => {
    const { base, container } = makeOptions();
    const removeSpy = vi.spyOn(container, "removeEventListener");
    const { unmount } = renderHook(() => useScrollPageSync(base));
    unmount();
    expect(removeSpy).toHaveBeenCalledWith("scroll", expect.any(Function));
  });

  it("detects the page closest to the viewport top on scroll", () => {
    const { base, container, page1, page2 } = makeOptions();
    renderHook(() => useScrollPageSync(base));

    // Scroll so page2's top (324) is closest to viewport top (0): shift
    // page1 fully above and page2 to top=0.
    (page1 as any).getBoundingClientRect = () => ({
      top: -300, bottom: 0, left: 0, right: 800, width: 800, height: 300,
      x: 0, y: -300, toJSON: () => ({}),
    });
    (page2 as any).getBoundingClientRect = () => ({
      top: 0, bottom: 300, left: 0, right: 800, width: 800, height: 300,
      x: 0, y: 0, toJSON: () => ({}),
    });

    // Dispatch a scroll event; the effect's listener reads live geometry.
    container.dispatchEvent(new Event("scroll"));

    // setPageNum should have been called with page 2 (top=0, closest to 0).
    expect(base.setPageNum).toHaveBeenCalledTimes(1);
    const updater = base.setPageNum.mock.calls[0][0];
    expect(updater(1)).toBe(2);
  });

  it("suppresses detection while isJumpingRef is true", () => {
    const { base, container } = makeOptions();
    base.isJumpingRef.current = true;
    renderHook(() => useScrollPageSync(base));

    container.dispatchEvent(new Event("scroll"));
    expect(base.setPageNum).not.toHaveBeenCalled();
  });

  it("suppresses detection while isZoomingRef is true", () => {
    const { base, container } = makeOptions();
    base.isZoomingRef.current = true;
    renderHook(() => useScrollPageSync(base));

    container.dispatchEvent(new Event("scroll"));
    expect(base.setPageNum).not.toHaveBeenCalled();
  });

  it("does not change pageNum when the detected page equals the current page", () => {
    const { base, container } = makeOptions();
    // page1 spans the viewport top (0..300), pageNumRef.current = 1 → no change.
    renderHook(() => useScrollPageSync(base));
    container.dispatchEvent(new Event("scroll"));
    // setPageNum IS called (the functional updater), but the updater returns
    // the same value (bail-out).
    expect(base.setPageNum).toHaveBeenCalledTimes(1);
    const updater = base.setPageNum.mock.calls[0][0];
    expect(updater(1)).toBe(1); // no-op bail-out
  });

  it("keeps the current page when the challenger is closer by less than the dead-zone margin (page-boundary jitter)", () => {
    // Regression for the "page number keeps changing after zoom" bug: the
    // viewport top sits right at the page 1/2 boundary, so page2's top edge
    // is a few px closer than page1's. The dead zone must keep page 1.
    const { base, container, page1, page2 } = makeOptions();
    (page1 as any).getBoundingClientRect = () => ({
      top: -6, bottom: 294, left: 0, right: 800, width: 800, height: 300,
      x: 0, y: -6, toJSON: () => ({}),
    });
    (page2 as any).getBoundingClientRect = () => ({
      top: 2, bottom: 302, left: 0, right: 800, width: 800, height: 300,
      x: 0, y: 2, toJSON: () => ({}),
    });
    renderHook(() => useScrollPageSync(base));

    container.dispatchEvent(new Event("scroll"));

    const updater = base.setPageNum.mock.calls[0][0];
    // page2 wins the raw comparison (2 < 6) but by less than the 12px margin.
    expect(updater(1)).toBe(1);
  });

  it("switches pages once the challenger beats the current page by more than the margin", () => {
    const { base, container, page1, page2 } = makeOptions();
    (page1 as any).getBoundingClientRect = () => ({
      top: -20, bottom: 280, left: 0, right: 800, width: 800, height: 300,
      x: 0, y: -20, toJSON: () => ({}),
    });
    (page2 as any).getBoundingClientRect = () => ({
      top: 2, bottom: 302, left: 0, right: 800, width: 800, height: 300,
      x: 0, y: 2, toJSON: () => ({}),
    });
    renderHook(() => useScrollPageSync(base));

    container.dispatchEvent(new Event("scroll"));

    const updater = base.setPageNum.mock.calls[0][0];
    // 20 - 2 = 18 > 12: a genuine page transition still happens promptly.
    expect(updater(1)).toBe(2);
  });
});
