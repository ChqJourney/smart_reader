import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { mockTauriInvoke } from "../test/mocks/tauri";

describe("useRecentFiles", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("loads recent files from backend", async () => {
    mockTauriInvoke({
      load_recent_files: () => [
        { path: "/a.pdf", fileName: "a.pdf", openedAt: 1 },
      ],
    });
    const { useRecentFiles } = await import("../hooks/useRecentFiles");
    const { result } = renderHook(() => useRecentFiles());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.recentFiles).toEqual([
      { path: "/a.pdf", fileName: "a.pdf", openedAt: 1 },
    ]);
  });

  it("adds recent file to front and persists", async () => {
    const saved: any[] = [];
    mockTauriInvoke({
      load_recent_files: () => [],
      save_recent_files: (args) => {
        saved.push(args.files);
        return null;
      },
    });
    const { useRecentFiles } = await import("../hooks/useRecentFiles");
    const { result } = renderHook(() => useRecentFiles());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.addRecentFile("/new.pdf", "new.pdf"));
    expect(result.current.recentFiles[0]).toMatchObject({
      path: "/new.pdf",
      fileName: "new.pdf",
    });
    expect(saved.length).toBeGreaterThan(0);
    expect(saved[saved.length - 1][0]).toMatchObject({
      path: "/new.pdf",
      fileName: "new.pdf",
    });
  });

  it("moves existing file to front when re-added", async () => {
    mockTauriInvoke({
      load_recent_files: () => [
        { path: "/a.pdf", fileName: "a.pdf", openedAt: 1 },
        { path: "/b.pdf", fileName: "b.pdf", openedAt: 2 },
      ],
      save_recent_files: () => null,
    });
    const { useRecentFiles } = await import("../hooks/useRecentFiles");
    const { result } = renderHook(() => useRecentFiles());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.addRecentFile("/b.pdf", "b.pdf"));
    expect(result.current.recentFiles[0].path).toBe("/b.pdf");
    expect(result.current.recentFiles).toHaveLength(2);
  });

  it("trims list to 20 items", async () => {
    const existing = Array.from({ length: 20 }, (_, i) => ({
      path: `/${i}.pdf`,
      fileName: `${i}.pdf`,
      openedAt: i,
    }));
    let saved: any = null;
    mockTauriInvoke({
      load_recent_files: () => existing,
      save_recent_files: (args) => {
        saved = args.files;
        return null;
      },
    });
    const { useRecentFiles } = await import("../hooks/useRecentFiles");
    const { result } = renderHook(() => useRecentFiles());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.addRecentFile("/new.pdf", "new.pdf"));
    expect(result.current.recentFiles).toHaveLength(20);
    expect(result.current.recentFiles[0].path).toBe("/new.pdf");
    expect(saved).toHaveLength(20);
    expect(saved.some((f: any) => f.path === "/19.pdf")).toBe(false);
  });

  it("clears recent files", async () => {
    let saved: any = null;
    mockTauriInvoke({
      load_recent_files: () => [
        { path: "/a.pdf", fileName: "a.pdf", openedAt: 1 },
      ],
      save_recent_files: (args) => {
        saved = args.files;
        return null;
      },
    });
    const { useRecentFiles } = await import("../hooks/useRecentFiles");
    const { result } = renderHook(() => useRecentFiles());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.clearRecentFiles());
    expect(result.current.recentFiles).toEqual([]);
    expect(saved).toEqual([]);
  });
});
