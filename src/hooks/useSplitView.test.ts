import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSplitView } from "./useSplitView";

describe("useSplitView", () => {
  it("starts in single view", () => {
    const { result } = renderHook(() => useSplitView());
    expect(result.current.isSplitView).toBe(false);
    expect(result.current.secondaryTabId).toBeNull();
  });

  it("enters split view with secondary tab", () => {
    const { result } = renderHook(() => useSplitView());
    act(() => result.current.enterSplitView("tab-2"));
    expect(result.current.isSplitView).toBe(true);
    expect(result.current.secondaryTabId).toBe("tab-2");
  });

  it("exits split view and clears secondary tab", () => {
    const { result } = renderHook(() => useSplitView());
    act(() => result.current.enterSplitView("tab-2"));
    act(() => result.current.exitSplitView());
    expect(result.current.isSplitView).toBe(false);
    expect(result.current.secondaryTabId).toBeNull();
  });
});
