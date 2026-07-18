import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { mockTauriInvoke } from "../test/mocks/tauri";
import { normalizeRecentFiles, type RecentFile } from "./useRecentFiles";

function entry(path: string, openedAt: number, extra?: Partial<RecentFile>) {
  return { path, fileName: path.split("/").pop()!, openedAt, ...extra };
}

describe("normalizeRecentFiles", () => {
  it("puts pinned entries first, each group sorted by recency", () => {
    const files = [
      entry("/a.pdf", 3),
      entry("/b.pdf", 4, { pinned: true }),
      entry("/c.pdf", 5),
      entry("/d.pdf", 1, { pinned: true }),
    ];
    const result = normalizeRecentFiles(files);
    expect(result.map((f) => f.path)).toEqual([
      "/b.pdf",
      "/d.pdf",
      "/c.pdf",
      "/a.pdf",
    ]);
  });

  it("caps unpinned entries at 20", () => {
    const files = Array.from({ length: 25 }, (_, i) => entry(`/${i}.pdf`, i));
    const result = normalizeRecentFiles(files);
    expect(result).toHaveLength(20);
    // 最新的 20 条保留，最旧的被淘汰
    expect(result.some((f) => f.path === "/0.pdf")).toBe(false);
    expect(result[0].path).toBe("/24.pdf");
  });

  it("demotes over-cap pinned entries back into the unpinned pool", () => {
    const pinned = Array.from({ length: 11 }, (_, i) =>
      entry(`/p${i}.pdf`, i, { pinned: true })
    );
    const result = normalizeRecentFiles(pinned);
    const stillPinned = result.filter((f) => f.pinned);
    expect(stillPinned).toHaveLength(10);
    // 最旧的固定条目被降级，排在未固定区
    const demoted = result.find((f) => f.path === "/p0.pdf");
    expect(demoted?.pinned).toBe(false);
    expect(result.indexOf(demoted!)).toBe(10);
  });
});

describe("useRecentFiles", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function setup(
    initial: RecentFile[] = [],
    saved: { files: RecentFile[] }[] = []
  ) {
    mockTauriInvoke({
      load_recent_files: () => initial,
      save_recent_files: (args) => {
        saved.push(args);
        return null;
      },
    });
    const { useRecentFiles } = await import("../hooks/useRecentFiles");
    const hook = renderHook(() => useRecentFiles());
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    return hook;
  }

  it("loads recent files from backend", async () => {
    const { result } = await setup([entry("/a.pdf", 1)]);
    expect(result.current.recentFiles).toEqual([entry("/a.pdf", 1)]);
  });

  it("adds recent file to front and persists", async () => {
    const saved: { files: RecentFile[] }[] = [];
    const { result } = await setup([], saved);

    act(() => result.current.addRecentFile("/new.pdf", "new.pdf"));
    expect(result.current.recentFiles[0]).toMatchObject({
      path: "/new.pdf",
      fileName: "new.pdf",
    });
    expect(saved.length).toBeGreaterThan(0);
    expect(saved[saved.length - 1].files[0]).toMatchObject({
      path: "/new.pdf",
      fileName: "new.pdf",
    });
  });

  it("moves existing file to front when re-added", async () => {
    const { result } = await setup([entry("/a.pdf", 1), entry("/b.pdf", 2)]);

    act(() => result.current.addRecentFile("/b.pdf", "b.pdf"));
    expect(result.current.recentFiles[0].path).toBe("/b.pdf");
    expect(result.current.recentFiles).toHaveLength(2);
  });

  it("preserves pinned and lastPage when a file is re-added", async () => {
    const { result } = await setup([
      entry("/a.pdf", 1, { pinned: true, lastPage: 47 }),
    ]);

    act(() => result.current.addRecentFile("/a.pdf", "a.pdf"));
    const file = result.current.recentFiles[0];
    expect(file.pinned).toBe(true);
    expect(file.lastPage).toBe(47);
  });

  it("trims unpinned list to 20 items", async () => {
    const existing = Array.from({ length: 20 }, (_, i) =>
      entry(`/${i}.pdf`, i)
    );
    const saved: { files: RecentFile[] }[] = [];
    const { result } = await setup(existing, saved);

    act(() => result.current.addRecentFile("/new.pdf", "new.pdf"));
    expect(result.current.recentFiles).toHaveLength(20);
    expect(result.current.recentFiles[0].path).toBe("/new.pdf");
    expect(saved[saved.length - 1].files).toHaveLength(20);
    expect(saved[saved.length - 1].files.some((f) => f.path === "/0.pdf")).toBe(
      false
    );
  });

  it("toggles pin and keeps pinned entries on top", async () => {
    const saved: { files: RecentFile[] }[] = [];
    const { result } = await setup(
      [entry("/a.pdf", 2), entry("/b.pdf", 1)],
      saved
    );

    act(() => result.current.togglePinRecentFile("/b.pdf"));
    expect(result.current.recentFiles[0].path).toBe("/b.pdf");
    expect(result.current.recentFiles[0].pinned).toBe(true);
    expect(saved[saved.length - 1].files[0].pinned).toBe(true);

    act(() => result.current.togglePinRecentFile("/b.pdf"));
    expect(result.current.recentFiles[0].path).toBe("/a.pdf");
    expect(result.current.recentFiles[1].pinned).toBe(false);
  });

  it("removes a single entry and persists", async () => {
    const saved: { files: RecentFile[] }[] = [];
    const { result } = await setup(
      [entry("/a.pdf", 2), entry("/b.pdf", 1)],
      saved
    );

    act(() => result.current.removeRecentFile("/a.pdf"));
    expect(result.current.recentFiles.map((f) => f.path)).toEqual(["/b.pdf"]);
    expect(saved[saved.length - 1].files).toHaveLength(1);
  });

  it("updates lastPage without reordering", async () => {
    const saved: { files: RecentFile[] }[] = [];
    const { result } = await setup(
      [entry("/a.pdf", 2), entry("/b.pdf", 1)],
      saved
    );

    act(() => result.current.updateLastPage("/b.pdf", 112));
    expect(result.current.recentFiles.map((f) => f.path)).toEqual([
      "/a.pdf",
      "/b.pdf",
    ]);
    expect(result.current.recentFiles[1].lastPage).toBe(112);
    expect(
      saved[saved.length - 1].files.find((f) => f.path === "/b.pdf")?.lastPage
    ).toBe(112);
  });

  it("ignores lastPage updates for unknown paths or invalid pages", async () => {
    const saved: { files: RecentFile[] }[] = [];
    const { result } = await setup([entry("/a.pdf", 1)], saved);
    const savesBefore = saved.length;

    act(() => result.current.updateLastPage("/missing.pdf", 5));
    expect(result.current.recentFiles[0].lastPage).toBeUndefined();
    expect(saved.length).toBe(savesBefore);

    act(() => result.current.updateLastPage("/a.pdf", 0));
    expect(result.current.recentFiles[0].lastPage).toBeUndefined();
  });

  it("clears recent files", async () => {
    const saved: { files: RecentFile[] }[] = [];
    const { result } = await setup([entry("/a.pdf", 1)], saved);

    act(() => result.current.clearRecentFiles());
    expect(result.current.recentFiles).toEqual([]);
    expect(saved[saved.length - 1].files).toEqual([]);
  });
});
