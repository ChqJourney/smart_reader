import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  useRightPanelLayout,
  type RightPanelLayout,
} from "./useRightPanelLayout";

describe("useRightPanelLayout", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it("initializes from provided layout", () => {
    const onLayoutChange = vi.fn();
    const { result } = renderHook(() =>
      useRightPanelLayout({ visible: false, width: 240 }, onLayoutChange)
    );

    expect(result.current.rightVisible).toBe(false);
    expect(result.current.rightPanelWidth).toBe(240);
  });

  it("syncs when initial layout changes", () => {
    const onLayoutChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ layout }: { layout: RightPanelLayout }) =>
        useRightPanelLayout(layout, onLayoutChange),
      {
        initialProps: { layout: { visible: true, width: 0 } },
      }
    );

    expect(result.current.rightVisible).toBe(true);

    rerender({ layout: { visible: false, width: 320 } });

    expect(result.current.rightVisible).toBe(false);
    expect(result.current.rightPanelWidth).toBe(320);
  });

  it("calls onLayoutChange when visibility toggles", () => {
    const onLayoutChange = vi.fn();
    const { result } = renderHook(() =>
      useRightPanelLayout({ visible: true, width: 240 }, onLayoutChange)
    );

    act(() => {
      result.current.toggleRight();
    });

    expect(onLayoutChange).toHaveBeenLastCalledWith({
      visible: false,
      width: 240,
    });
  });

  it("debounces width changes before calling onLayoutChange", async () => {
    const onLayoutChange = vi.fn();
    const { result } = renderHook(() =>
      useRightPanelLayout({ visible: true, width: 200 }, onLayoutChange)
    );

    act(() => {
      result.current.setRightPanelWidth(250);
    });

    expect(onLayoutChange).not.toHaveBeenCalledWith({
      visible: true,
      width: 250,
    });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    await waitFor(() =>
      expect(onLayoutChange).toHaveBeenLastCalledWith({
        visible: true,
        width: 250,
      })
    );
  });

  it("does not call onLayoutChange for zero width", () => {
    const onLayoutChange = vi.fn();
    renderHook(() =>
      useRightPanelLayout({ visible: true, width: 0 }, onLayoutChange)
    );

    act(() => {
      vi.advanceTimersByTime(500);
    });

    // The initial restore-default effect runs asynchronously; zero width
    // itself should not trigger a save.
    expect(
      onLayoutChange.mock.calls.some(([layout]) => layout.width === 0)
    ).toBe(false);
  });
});
