import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useTabRestore } from "./useTabRestore";
import type { PageViewportInfo } from "./useViewportManager";

const SCALE = 1.5;

function makeContainer() {
  const el = document.createElement("div");
  (el as any).scrollTop = 0;
  return el as unknown as HTMLDivElement;
}

/** Viewport entries for pages [from..to], computed at SCALE. */
function makeViewports(
  from: number,
  to: number
): Map<number, PageViewportInfo> {
  const map = new Map<number, PageViewportInfo>();
  for (let p = from; p <= to; p++) {
    map.set(p, { width: 200 * SCALE, height: 300 * SCALE, scale: SCALE });
  }
  return map;
}

function makeOptions(overrides?: {
  initialState?: Parameters<typeof useTabRestore>[0]["initialState"];
  pdf?: unknown;
  numPages?: number;
  isLoading?: boolean;
  viewMode?: "single" | "continuous";
  pageViewports?: Map<number, PageViewportInfo>;
  tabId?: string;
}) {
  const container = makeContainer();
  const numPages = overrides?.numPages ?? 5;
  // Default: every page's viewport is known (small-document situation).
  const pageViewports = overrides?.pageViewports ?? makeViewports(1, numPages);
  const isJumpingRef = { current: false };
  return {
    opts: {
      initialState: overrides?.initialState,
      pdf: (
        overrides && "pdf" in overrides ? overrides.pdf : { dummy: true }
      ) as never,
      numPages,
      isLoading: overrides?.isLoading ?? false,
      viewMode: overrides?.viewMode ?? "continuous",
      pageViewports,
      tabId: overrides?.tabId ?? "tab-1",
      goToPage: vi.fn(),
      onClearPendingGotoPage: vi.fn(),
      continuousContainerRef: { current: container },
      isJumpingRef,
      setPageNum: vi.fn(),
      setScale: vi.fn(),
      setViewMode: vi.fn(),
    },
    container,
    pageViewports,
    isJumpingRef,
  };
}

describe("useTabRestore", () => {
  beforeEach(() => {
    // Fire rAF callbacks synchronously so lock releases are observable without
    // waiting for real frames.
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      }
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies initialState pageNum/scale/viewMode at mount", () => {
    const { opts } = makeOptions({
      initialState: { pageNum: 3, scale: 2.0, viewMode: "single" },
    });
    renderHook(() => useTabRestore(opts));

    expect(opts.setPageNum).toHaveBeenCalledWith(3);
    expect(opts.setScale).toHaveBeenCalledWith(2.0);
    expect(opts.setViewMode).toHaveBeenCalledWith("single");
  });

  it("does NOT re-apply pageNum/scale/viewMode when initialState changes after mount (stomp regression)", () => {
    // Regression for the "tab switch resets to page 1" bug: the tab record
    // round-trips through onStateChange; re-applying it after mount stomps
    // newer viewer state with stale record values (e.g. a record clobbered to
    // page 1 by a stray report during the restore window).
    const { opts } = makeOptions({
      initialState: { pageNum: 5, scale: 2.0, viewMode: "continuous" },
    });
    const { rerender } = renderHook(
      (props: { init?: Parameters<typeof useTabRestore>[0]["initialState"] }) =>
        useTabRestore({ ...opts, initialState: props.init }),
      { initialProps: { init: opts.initialState } }
    );

    expect(opts.setPageNum).toHaveBeenCalledTimes(1);
    expect(opts.setPageNum).toHaveBeenCalledWith(5);
    expect(opts.setScale).toHaveBeenCalledTimes(1);
    expect(opts.setViewMode).toHaveBeenCalledTimes(1);

    rerender({ init: { pageNum: 1, scale: 2.0, viewMode: "continuous" } });

    // Still exactly one application each — the clobbered record is ignored.
    expect(opts.setPageNum).toHaveBeenCalledTimes(1);
    expect(opts.setScale).toHaveBeenCalledTimes(1);
    expect(opts.setViewMode).toHaveBeenCalledTimes(1);
  });

  it("restores scrollTop when no pending goto page and pdf is ready", async () => {
    const { opts, container } = makeOptions({
      initialState: { scrollTop: 1234 },
      isLoading: false,
    });
    renderHook(() => useTabRestore(opts));

    await waitFor(() => {
      expect(container.scrollTop).toBe(1234);
    });
  });

  it("does not restore while pdf is loading, and holds the jump lock", () => {
    const { opts, container, isJumpingRef } = makeOptions({
      initialState: { scrollTop: 1234 },
      isLoading: true,
    });
    renderHook(() => useTabRestore(opts));
    expect(container.scrollTop).toBe(0);
    // The scroll page-sync must stay suppressed during the load window.
    expect(isJumpingRef.current).toBe(true);
  });

  it("does not restore when numPages is 0, and holds the jump lock", () => {
    const { opts, container, isJumpingRef } = makeOptions({
      initialState: { scrollTop: 1234 },
      numPages: 0,
      pageViewports: new Map(),
    });
    renderHook(() => useTabRestore(opts));
    expect(container.scrollTop).toBe(0);
    expect(isJumpingRef.current).toBe(true);
  });

  it("releases the jump lock after a no-pending restore", async () => {
    const { opts, container, isJumpingRef } = makeOptions({
      initialState: { scrollTop: 1234 },
      pdf: null, // start in the not-ready branch, then become ready
    });
    const { rerender } = renderHook(
      (props: { pdf: unknown }) =>
        useTabRestore({ ...opts, pdf: props.pdf as never }),
      { initialProps: { pdf: null as unknown } }
    );

    // Waiting for the document: lock held.
    expect(isJumpingRef.current).toBe(true);

    rerender({ pdf: { dummy: true } });

    await waitFor(() => {
      expect(container.scrollTop).toBe(1234);
    });
    // rAF is sync-mocked, so the release has already run.
    expect(isJumpingRef.current).toBe(false);
  });

  it("executes pending goto page once ALL viewports up to the target are known", async () => {
    const { opts } = makeOptions({
      initialState: { pendingGotoPage: 3, scrollTop: 500 },
      pageViewports: makeViewports(1, 3),
    });
    renderHook(() => useTabRestore(opts));

    await waitFor(() => {
      expect(opts.goToPage).toHaveBeenCalledWith(3);
    });
    expect(opts.onClearPendingGotoPage).toHaveBeenCalledWith("tab-1");
  });

  it("waits while ANY page up to the target is missing (large-doc exact jump)", async () => {
    // A jump whose target viewport exists but whose upper pages do not would
    // fall back to DOM geometry measured against placeholder heights and land
    // at the wrong position. The restore must wait for the full range.
    const partial = makeViewports(1, 1);
    partial.set(3, { width: 200 * SCALE, height: 300 * SCALE, scale: SCALE });
    const { opts } = makeOptions({
      initialState: { pendingGotoPage: 3, scrollTop: 500 },
      pageViewports: partial,
    });
    const { rerender } = renderHook(
      (props: { v: Map<number, PageViewportInfo> }) =>
        useTabRestore({ ...opts, pageViewports: props.v }),
      { initialProps: { v: partial } }
    );

    // Page 2's viewport is missing: no jump yet, lock still held.
    expect(opts.goToPage).not.toHaveBeenCalled();

    rerender({ v: makeViewports(1, 3) });

    await waitFor(() => {
      expect(opts.goToPage).toHaveBeenCalledWith(3);
    });
  });

  it("leaves the jump lock to goToPage after a continuous pending goto", async () => {
    // In continuous mode goToPage owns the jump lock lifecycle (it releases
    // once the programmatic scroll settles); the restore must NOT release it
    // itself or the page-sync would race the jump. Start with page 3's
    // viewport missing so the restore-window lock is engaged, then complete
    // the range: the lock must still be held after goToPage fires (the mock
    // does not release it — proving the hook didn't).
    const { opts, isJumpingRef } = makeOptions({
      initialState: { pendingGotoPage: 3, scrollTop: 500 },
      pageViewports: makeViewports(1, 2),
    });
    const { rerender } = renderHook(
      (props: { v: Map<number, PageViewportInfo> }) =>
        useTabRestore({ ...opts, pageViewports: props.v }),
      { initialProps: { v: makeViewports(1, 2) } }
    );

    expect(isJumpingRef.current).toBe(true);
    expect(opts.goToPage).not.toHaveBeenCalled();

    rerender({ v: makeViewports(1, 3) });

    await waitFor(() => {
      expect(opts.goToPage).toHaveBeenCalledWith(3);
    });
    expect(isJumpingRef.current).toBe(true);
  });

  it("executes goto in single mode regardless of viewport availability, and releases the lock", async () => {
    const { opts, isJumpingRef } = makeOptions({
      initialState: { pendingGotoPage: 2, scrollTop: 0 },
      viewMode: "single",
      pageViewports: new Map(),
    });
    renderHook(() => useTabRestore(opts));

    await waitFor(() => {
      expect(opts.goToPage).toHaveBeenCalledWith(2);
    });
    // goToPage does not manage the lock in single mode, so the restore
    // releases it (rAF is sync-mocked).
    expect(isJumpingRef.current).toBe(false);
  });

  it("restores only once per mount even if pageViewports changes", async () => {
    const { opts, container, pageViewports } = makeOptions({
      initialState: { scrollTop: 777 },
    });
    const { rerender } = renderHook(
      (props: { v: Map<number, PageViewportInfo> }) =>
        useTabRestore({ ...opts, pageViewports: props.v }),
      { initialProps: { v: pageViewports } }
    );

    await waitFor(() => {
      expect(container.scrollTop).toBe(777);
    });

    // Reset scrollTop to simulate a later user scroll, then trigger a re-run
    // with a new pageViewports identity. The restore must NOT re-apply.
    container.scrollTop = 99;
    const newMap = new Map(pageViewports);
    newMap.set(1, { width: 200 * SCALE, height: 300 * SCALE, scale: SCALE });
    rerender({ v: newMap });

    expect(container.scrollTop).toBe(99);
  });

  it("executes a pending goto that arrives AFTER the mount restore (active-tab navigation, fix #4a)", async () => {
    const { opts } = makeOptions({
      // Mount with only a scrollTop (plain tab restore), no pending goto.
      initialState: { scrollTop: 400 },
    });
    const { rerender } = renderHook(
      (props: { init?: Parameters<typeof useTabRestore>[0]["initialState"] }) =>
        useTabRestore({ ...opts, initialState: props.init }),
      { initialProps: { init: opts.initialState } }
    );

    // Mount restore completes (scrollTop applied once).
    const container = opts.continuousContainerRef.current!;
    await waitFor(() => {
      expect(container.scrollTop).toBe(400);
    });
    expect(opts.goToPage).not.toHaveBeenCalled();

    // A goto request arrives for the ALREADY-ACTIVE tab (e.g. clicking a
    // stash in the side panel): pendingGotoPage appears without a remount.
    rerender({ init: { scrollTop: 400, pendingGotoPage: 3 } });

    await waitFor(() => {
      expect(opts.goToPage).toHaveBeenCalledWith(3);
    });
    expect(opts.onClearPendingGotoPage).toHaveBeenCalledWith("tab-1");
    // The stale scrollTop must NOT be re-applied after the post-mount goto —
    // it would override the navigation target.
    expect(container.scrollTop).toBe(400); // unchanged: goToPage is a mock here
  });

  it("does not re-apply scrollTop for repeated post-mount gotos", async () => {
    const { opts } = makeOptions({
      initialState: { scrollTop: 250, pendingGotoPage: 3 },
    });
    const { rerender } = renderHook(
      (props: { init?: Parameters<typeof useTabRestore>[0]["initialState"] }) =>
        useTabRestore({ ...opts, initialState: props.init }),
      { initialProps: { init: opts.initialState } }
    );

    // Mount-time: goto executes AND the saved scrollTop is applied once.
    const container = opts.continuousContainerRef.current!;
    await waitFor(() => {
      expect(opts.goToPage).toHaveBeenCalledWith(3);
    });
    expect(container.scrollTop).toBe(250);

    // Second goto for the same tab (no remount): goto runs, scrollTop stays.
    container.scrollTop = 10; // pretend the user is somewhere else now
    rerender({ init: { scrollTop: 250, pendingGotoPage: 4 } });
    await waitFor(() => {
      expect(opts.goToPage).toHaveBeenCalledWith(4);
    });
    expect(container.scrollTop).toBe(10);
  });
});
