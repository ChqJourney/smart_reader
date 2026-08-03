import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import type { PhysicalPosition } from "@tauri-apps/api/dpi";

// 测试不关心 position 内容，集中断言一次类型。
const pos = { type: "Physical", x: 0, y: 0 } as unknown as PhysicalPosition;

// Capture the onDragDropEvent handler so tests can simulate system file drops.
const dragDropState = vi.hoisted(() => ({
  handler: null as null | ((event: { payload: DragDropEvent }) => void),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (cb: (event: { payload: DragDropEvent }) => void) => {
      dragDropState.handler = cb;
      return Promise.resolve(dragDropState.unlisten);
    },
  }),
}));

import { useFileDrop } from "./useFileDrop";

function emit(payload: DragDropEvent) {
  dragDropState.handler!({ payload });
}

describe("useFileDrop", () => {
  beforeEach(() => {
    dragDropState.handler = null;
    dragDropState.unlisten.mockClear();
  });

  it("registers the drag-drop listener once and unlistens on unmount", async () => {
    const { unmount } = renderHook(() =>
      useFileDrop({
        openPdfByPath: vi.fn().mockResolvedValue(null),
        addRecentFile: vi.fn(),
      })
    );
    await act(async () => {});
    expect(dragDropState.handler).not.toBeNull();
    unmount();
    expect(dragDropState.unlisten).toHaveBeenCalledTimes(1);
  });

  it("toggles isFileDragOver on enter / leave", async () => {
    const { result } = renderHook(() =>
      useFileDrop({
        openPdfByPath: vi.fn().mockResolvedValue(null),
        addRecentFile: vi.fn(),
      })
    );
    await act(async () => {});
    expect(result.current.isFileDragOver).toBe(false);

    act(() => emit({ type: "enter", paths: ["/test/a.pdf"], position: pos }));
    expect(result.current.isFileDragOver).toBe(true);

    act(() => emit({ type: "leave" }));
    expect(result.current.isFileDragOver).toBe(false);
  });

  it("resets isFileDragOver on drop", async () => {
    const { result } = renderHook(() =>
      useFileDrop({
        openPdfByPath: vi.fn().mockResolvedValue({ filePath: "/test/a.pdf" }),
        addRecentFile: vi.fn(),
      })
    );
    await act(async () => {});
    act(() => emit({ type: "enter", paths: ["/test/a.pdf"], position: pos }));
    expect(result.current.isFileDragOver).toBe(true);
    await act(async () =>
      emit({
        type: "drop",
        paths: ["/test/a.pdf"],
        position: pos,
      })
    );
    expect(result.current.isFileDragOver).toBe(false);
  });

  it("opens only PDF paths (case-insensitive) and records them as recent files", async () => {
    const openPdfByPath = vi
      .fn()
      .mockResolvedValue({ filePath: "/test/a.pdf" });
    const addRecentFile = vi.fn();
    renderHook(() => useFileDrop({ openPdfByPath, addRecentFile }));
    await act(async () => {});

    await act(async () =>
      emit({
        type: "drop",
        paths: ["/test/a.pdf", "C:\\docs\\B.PDF", "/test/notes.txt"],
        position: pos,
      })
    );

    expect(openPdfByPath).toHaveBeenCalledTimes(2);
    expect(openPdfByPath).toHaveBeenCalledWith("/test/a.pdf");
    expect(openPdfByPath).toHaveBeenCalledWith("C:\\docs\\B.PDF");
    expect(addRecentFile).toHaveBeenCalledTimes(2);
    expect(addRecentFile).toHaveBeenCalledWith("/test/a.pdf", "a.pdf");
    expect(addRecentFile).toHaveBeenCalledWith("C:\\docs\\B.PDF", "B.PDF");
  });

  it("does not record a recent file when the PDF fails to open", async () => {
    const openPdfByPath = vi.fn().mockResolvedValue(null);
    const addRecentFile = vi.fn();
    renderHook(() => useFileDrop({ openPdfByPath, addRecentFile }));
    await act(async () => {});

    await act(async () =>
      emit({
        type: "drop",
        paths: ["/test/broken.pdf"],
        position: pos,
      })
    );

    expect(openPdfByPath).toHaveBeenCalledTimes(1);
    expect(addRecentFile).not.toHaveBeenCalled();
  });

  it("uses the latest callbacks without re-registering the listener", async () => {
    const first = vi.fn().mockResolvedValue(null);
    const second = vi.fn().mockResolvedValue(null);
    const { rerender } = renderHook(
      ({ openPdfByPath }) =>
        useFileDrop({ openPdfByPath, addRecentFile: vi.fn() }),
      { initialProps: { openPdfByPath: first } }
    );
    await act(async () => {});
    const handler = dragDropState.handler;

    rerender({ openPdfByPath: second });
    // listener 没有因回调变化而重新注册
    expect(dragDropState.handler).toBe(handler);

    await act(async () =>
      emit({
        type: "drop",
        paths: ["/test/a.pdf"],
        position: pos,
      })
    );
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("/test/a.pdf");
  });
});
