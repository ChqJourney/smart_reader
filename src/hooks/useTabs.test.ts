import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useTabs } from "./useTabs";
import { showMessage } from "../services/dialog";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../services/dialog", () => ({
  showMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/logs", () => ({
  error: vi.fn(),
  info: vi.fn(),
}));

const { invoke } = await import("@tauri-apps/api/core");
const mockInvoke = invoke as ReturnType<typeof vi.fn>;

function setupMockInvoke() {
  mockInvoke.mockImplementation(
    (command: string, args?: Record<string, any>) => {
      switch (command) {
        case "authorizePdfPath":
        case "authorize_pdf_path":
          return Promise.resolve(undefined);
        case "read_pdf_bytes":
          return Promise.resolve(new ArrayBuffer(8));
        case "get_pdf_hash":
          return Promise.resolve(`hash-${args?.filePath}`);
        case "get_pdf_file_size":
          return Promise.resolve(1024 * 1024); // 1MB
        default:
          return Promise.reject(
            new Error(`No mock handler for command: ${command}`)
          );
      }
    }
  );
}

describe("useTabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMockInvoke();
  });

  it("opens different PDFs as separate tabs", async () => {
    const { result } = renderHook(() => useTabs());

    await act(async () => {
      await result.current.openPdfByPath("/test/a.pdf");
    });
    await act(async () => {
      await result.current.openPdfByPath("/test/b.pdf");
    });

    expect(result.current.tabs).toHaveLength(2);
  });

  it("does not duplicate the same PDF when opened sequentially", async () => {
    const { result } = renderHook(() => useTabs());

    await act(async () => {
      await result.current.openPdfByPath("/test/file.pdf");
    });
    await act(async () => {
      await result.current.openPdfByPath("/test/file.pdf");
    });

    expect(result.current.tabs).toHaveLength(1);
    // Re-activating the existing tab sets pendingGotoPage for restoration.
    expect(result.current.activeTab?.pendingGotoPage).toBe(1);
  });

  it("deduplicates concurrent opens for the same path", async () => {
    const { result } = renderHook(() => useTabs());

    // Delay the backend so both calls overlap and must share the in-flight promise.
    let resolveHash: (value: string) => void;
    const hashPromise = new Promise<string>((resolve) => {
      resolveHash = resolve;
    });
    mockInvoke.mockImplementation(
      (command: string, args?: Record<string, any>) => {
        switch (command) {
          case "authorize_pdf_path":
            return Promise.resolve(undefined);
          case "read_pdf_bytes":
            return Promise.resolve(new ArrayBuffer(8));
          case "get_pdf_hash":
            return hashPromise.then(() => `hash-${args?.filePath}`);
          case "get_pdf_file_size":
            return Promise.resolve(1024 * 1024);
          default:
            return Promise.reject(
              new Error(`No mock handler for command: ${command}`)
            );
        }
      }
    );

    const [tab1, tab2] = await act(async () => {
      const p1 = result.current.openPdfByPath("/test/file.pdf");
      const p2 = result.current.openPdfByPath("/test/file.pdf");
      resolveHash!("done");
      return Promise.all([p1, p2]);
    });

    await waitFor(() => {
      expect(result.current.tabs).toHaveLength(1);
    });
    expect(tab1).toEqual(tab2);
    expect(mockInvoke).toHaveBeenCalledTimes(4); // authorize + bytes + hash + size，每个路径只各一次
  });

  it("counts authorize and hash calls correctly for concurrent same-path opens", async () => {
    const { result } = renderHook(() => useTabs());

    let resolveHash: (value: string) => void;
    const hashPromise = new Promise<string>((resolve) => {
      resolveHash = resolve;
    });
    mockInvoke.mockImplementation(
      (command: string, args?: Record<string, any>) => {
        switch (command) {
          case "authorize_pdf_path":
            return Promise.resolve(undefined);
          case "read_pdf_bytes":
            return Promise.resolve(new ArrayBuffer(8));
          case "get_pdf_hash":
            return hashPromise.then(() => `hash-${args?.filePath}`);
          case "get_pdf_file_size":
            return Promise.resolve(1024 * 1024);
          default:
            return Promise.reject(
              new Error(`No mock handler for command: ${command}`)
            );
        }
      }
    );

    await act(async () => {
      const p1 = result.current.openPdfByPath("/test/file.pdf");
      const p2 = result.current.openPdfByPath("/test/file.pdf");
      resolveHash!("done");
      await Promise.all([p1, p2]);
    });

    const authorizeCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "authorize_pdf_path"
    );
    const bytesCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "read_pdf_bytes"
    );
    const hashCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "get_pdf_hash"
    );
    const sizeCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "get_pdf_file_size"
    );
    expect(authorizeCalls).toHaveLength(1);
    expect(bytesCalls).toHaveLength(1);
    expect(hashCalls).toHaveLength(1);
    expect(sizeCalls).toHaveLength(1);
  });

  it("hands freshly-read bytes to cachePdfBytes and tracks openingPaths", async () => {
    const cachePdfBytes = vi.fn();
    const { result } = renderHook(() => useTabs({ cachePdfBytes }));

    let resolveBytes: (value: ArrayBuffer) => void;
    const bytesPromise = new Promise<ArrayBuffer>((resolve) => {
      resolveBytes = resolve;
    });
    mockInvoke.mockImplementation(
      (command: string, args?: Record<string, any>) => {
        switch (command) {
          case "authorize_pdf_path":
            return Promise.resolve(undefined);
          case "read_pdf_bytes":
            return bytesPromise;
          case "get_pdf_hash":
            return Promise.resolve(`hash-${args?.filePath}`);
          case "get_pdf_file_size":
            return Promise.resolve(1024 * 1024);
          default:
            return Promise.reject(
              new Error(`No mock handler for command: ${command}`)
            );
        }
      }
    );

    let openPromise: Promise<unknown>;
    act(() => {
      openPromise = result.current.openPdfByPath("/test/slow.pdf");
    });
    // 读取在飞期间 openingPaths 暴露该路径（全局「正在打开」反馈数据源）。
    await waitFor(() => {
      expect(result.current.openingPaths).toEqual(["/test/slow.pdf"]);
    });

    await act(async () => {
      resolveBytes!(new ArrayBuffer(8));
      await openPromise;
    });

    expect(result.current.openingPaths).toEqual([]);
    expect(cachePdfBytes).toHaveBeenCalledTimes(1);
    expect(cachePdfBytes.mock.calls[0][0]).toBe("/test/slow.pdf");
    expect(cachePdfBytes.mock.calls[0][1]).toBeInstanceOf(Uint8Array);
    expect(result.current.tabs).toHaveLength(1);
  });

  it("reopening an already-open path skips all file I/O", async () => {
    const { result } = renderHook(() => useTabs());

    await act(async () => {
      await result.current.openPdfByPath("/test/a.pdf");
    });
    mockInvoke.mockClear();

    await act(async () => {
      const tab = await result.current.openPdfByPath("/test/a.pdf");
      expect(tab?.filePath).toBe("/test/a.pdf");
    });

    // 路径去重优先于任何 I/O：重复拖入已打开的文件不再读盘/算 hash。
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(result.current.tabs).toHaveLength(1);
  });

  it("shows an error message instead of failing silently", async () => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "authorize_pdf_path":
          return Promise.resolve(undefined);
        case "read_pdf_bytes":
          return Promise.reject(new Error("network location disconnected"));
        default:
          return Promise.reject(
            new Error(`No mock handler for command: ${command}`)
          );
      }
    });
    const { result } = renderHook(() => useTabs());

    let tab: unknown;
    await act(async () => {
      tab = await result.current.openPdfByPath("/test/gone.pdf");
    });

    expect(tab).toBeNull();
    expect(showMessage).toHaveBeenCalledTimes(1);
    expect(result.current.openingPaths).toEqual([]);
  });

  it("stores and clears per-tab selection", async () => {
    const { result } = renderHook(() => useTabs());

    let tabId: string;
    await act(async () => {
      const tab = await result.current.openPdfByPath("/test/file.pdf");
      tabId = tab!.id;
    });

    const selection = {
      text: "selected",
      x: 10,
      y: 20,
      pdfX: 5,
      pdfY: 6,
      page: 2,
    };

    act(() => {
      result.current.setTabSelection(tabId!, selection);
    });

    expect(result.current.activeTab?.selection).toEqual(selection);

    act(() => {
      result.current.clearTabSelection(tabId!);
    });

    expect(result.current.activeTab?.selection).toBeNull();
  });

  it("stores and clears per-tab highlighted annotation", async () => {
    const { result } = renderHook(() => useTabs());

    let tabId: string;
    await act(async () => {
      const tab = await result.current.openPdfByPath("/test/file.pdf");
      tabId = tab!.id;
    });

    act(() => {
      result.current.setTabHighlightedAnnotationId(tabId!, "anno-1");
    });

    expect(result.current.activeTab?.highlightedAnnotationId).toBe("anno-1");

    act(() => {
      result.current.setTabHighlightedAnnotationId(tabId!, null);
    });

    expect(result.current.activeTab?.highlightedAnnotationId).toBeNull();
  });

  it("persists viewer state including scrollTop and pending goto page", async () => {
    const { result } = renderHook(() => useTabs());

    let tabId: string;
    await act(async () => {
      const tab = await result.current.openPdfByPath("/test/file.pdf");
      tabId = tab!.id;
    });

    act(() => {
      result.current.handleViewerStateChange(
        {
          pageNum: 5,
          scale: 2,
          viewMode: "continuous",
          scrollTop: 1200,
        },
        tabId!
      );
    });

    expect(result.current.activeTab?.pageNum).toBe(5);
    expect(result.current.activeTab?.scale).toBe(2);
    expect(result.current.activeTab?.viewMode).toBe("continuous");
    expect(result.current.activeTab?.scrollTop).toBe(1200);

    act(() => {
      result.current.gotoTabPage(tabId!, 8);
    });

    expect(result.current.activeTab?.pageNum).toBe(8);
    expect(result.current.activeTab?.pendingGotoPage).toBe(8);
    // Intentional navigation clears the saved scrollTop: the mount-restore
    // path would otherwise re-apply the stale offset after the jump and snap
    // the viewer back to the previous reading spot (fix #4b).
    expect(result.current.activeTab?.scrollTop).toBeUndefined();

    act(() => {
      result.current.clearTabPendingGotoPage(tabId!);
    });

    expect(result.current.activeTab?.pendingGotoPage).toBeUndefined();
  });

  it("ignores gotoTabPage with an unknown tabId and keeps activeTabId intact", async () => {
    const { result } = renderHook(() => useTabs());

    let tabId: string;
    await act(async () => {
      const tab = await result.current.openPdfByPath("/test/file.pdf");
      tabId = tab!.id;
    });

    act(() => {
      // 持久化会话 sources 里的旧 tabId（tab 重开/重启后失效）：不得把
      // activeTabId 置为不存在的 id，否则 keep-alive 树里所有 viewer 都因
      // isActive=false 被隐藏，阅读区整体消失。
      result.current.gotoTabPage("stale-tab-id", 3);
    });

    expect(result.current.activeTabId).toBe(tabId!);
    expect(result.current.activeTab?.pageNum).not.toBe(3);
    // openPdfByPath 激活时会把 pendingGotoPage 置为 1，不得被这次无效
    // 跳转改写为目标页码。
    expect(result.current.activeTab?.pendingGotoPage).toBe(1);
  });

  it("sets pendingGotoPage from saved pageNum when activating a tab", async () => {
    const { result } = renderHook(() => useTabs());

    let tabId: string;
    await act(async () => {
      const tab = await result.current.openPdfByPath("/test/file.pdf");
      tabId = tab!.id;
    });

    act(() => {
      result.current.handleViewerStateChange(
        { pageNum: 7, scale: 1.5, viewMode: "continuous" },
        tabId!
      );
    });

    expect(result.current.activeTab?.pageNum).toBe(7);

    // Open a second tab and switch back to the first one.
    await act(async () => {
      await result.current.openPdfByPath("/test/other.pdf");
    });

    act(() => {
      result.current.handleTabClick(tabId!);
    });

    expect(result.current.activeTab?.id).toBe(tabId!);
    expect(result.current.activeTab?.pageNum).toBe(7);
    expect(result.current.activeTab?.pendingGotoPage).toBe(7);
  });

  it("defaults pendingGotoPage to 1 when no pageNum has been saved", async () => {
    const { result } = renderHook(() => useTabs());

    let tabId: string;
    await act(async () => {
      const tab = await result.current.openPdfByPath("/test/file.pdf");
      tabId = tab!.id;
    });

    // Simulate the viewer mounting, consuming pendingGotoPage, and never
    // reporting state (e.g. the user left the tab at the default position).
    act(() => {
      result.current.clearTabPendingGotoPage(tabId!);
    });
    expect(result.current.activeTab?.pageNum).toBeUndefined();
    expect(result.current.activeTab?.pendingGotoPage).toBeUndefined();

    // Open a second tab and switch back to the first one.
    await act(async () => {
      await result.current.openPdfByPath("/test/other.pdf");
    });

    act(() => {
      result.current.handleTabClick(tabId!);
    });

    expect(result.current.activeTab?.id).toBe(tabId!);
    expect(result.current.activeTab?.pendingGotoPage).toBe(1);
  });

  it("preserves a background tab's page after selecting text in another tab", async () => {
    const { result } = renderHook(() => useTabs());

    let tabA: string;
    let tabB: string;
    await act(async () => {
      const tab = await result.current.openPdfByPath("/test/a.pdf");
      tabA = tab!.id;
    });
    await act(async () => {
      const tab = await result.current.openPdfByPath("/test/b.pdf");
      tabB = tab!.id;
    });

    // Tab B is active; simulate scrolling to page 5 and clearing pendingGotoPage.
    act(() => {
      result.current.handleViewerStateChange(
        { pageNum: 5, scale: 1.5, viewMode: "continuous", scrollTop: 1200 },
        tabB!
      );
      result.current.clearTabPendingGotoPage(tabB!);
    });
    expect(result.current.tabs.find((t) => t.id === tabB!)?.pageNum).toBe(5);

    // Switch to tab A, simulate a text selection, then switch back to tab B.
    act(() => {
      result.current.handleTabClick(tabA!);
    });
    act(() => {
      result.current.setTabSelection(tabA!, {
        text: "selected",
        x: 10,
        y: 20,
        pdfX: 5,
        pdfY: 6,
        page: 2,
      });
    });
    act(() => {
      result.current.handleTabClick(tabB!);
    });

    const restoredTab = result.current.tabs.find((t) => t.id === tabB!);
    expect(restoredTab?.pageNum).toBe(5);
    expect(restoredTab?.pendingGotoPage).toBe(5);
  });

  it("jumps to a background tab's page without activating it when activate is false", async () => {
    const { result } = renderHook(() => useTabs());

    let tabA: string;
    let tabB: string;
    await act(async () => {
      const tab = await result.current.openPdfByPath("/test/a.pdf");
      tabA = tab!.id;
    });
    await act(async () => {
      const tab = await result.current.openPdfByPath("/test/b.pdf");
      tabB = tab!.id;
    });

    // tabB 为 active；对 tabA 做静默跳页（分屏下副屏跳转的场景）
    act(() => {
      result.current.gotoTabPage(tabA!, 4, { activate: false });
    });

    expect(result.current.activeTabId).toBe(tabB!);
    const backgroundTab = result.current.tabs.find((t) => t.id === tabA!);
    expect(backgroundTab?.pageNum).toBe(4);
    expect(backgroundTab?.pendingGotoPage).toBe(4);
    expect(backgroundTab?.scrollTop).toBeUndefined();

    // 默认行为不变：不带 options 时仍然激活目标 tab
    act(() => {
      result.current.gotoTabPage(tabA!, 6);
    });
    expect(result.current.activeTabId).toBe(tabA!);
  });

  // 返回值引用稳定：状态未变化时 rerender 必须复用同一对象，
  // 否则 App 层依赖它的 useCallback 会每次渲染重建（击穿 PdfPage memo）。
  it("returns a stable object reference across re-renders without state change", () => {
    const { result, rerender } = renderHook(() => useTabs());

    const first = result.current;
    rerender();
    rerender();

    expect(result.current).toBe(first);
  });
});

describe("useTabs 休眠（hibernation）", () => {
  const MB = 1024 * 1024;
  // jsdom UA 不含 windows/mac → 走默认字节预算 400MB（×2 系数记账）。
  const FILE_SIZE = 100 * MB; // 每个文件记账 200MB，3 个文件即超预算
  let now: number;

  function mockFileSize(size: number) {
    mockInvoke.mockImplementation(
      (command: string, args?: Record<string, any>) => {
        switch (command) {
          case "authorize_pdf_path":
            return Promise.resolve(undefined);
          case "read_pdf_bytes":
            return Promise.resolve(new ArrayBuffer(8));
          case "get_pdf_hash":
            return Promise.resolve(`hash-${args?.filePath}`);
          case "get_pdf_file_size":
            return Promise.resolve(size);
          default:
            return Promise.reject(
              new Error(`No mock handler for command: ${command}`)
            );
        }
      }
    );
  }

  async function openPath(result: any, path: string) {
    let tab: any;
    await act(async () => {
      tab = await result.current.openPdfByPath(path);
    });
    return tab;
  }

  beforeEach(() => {
    now = 1_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mockFileSize(FILE_SIZE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("addTab 超预算时休眠最久未激活的隐藏 tab 并清空其选区", async () => {
    const { result } = renderHook(() => useTabs());

    const tabA = await openPath(result, "/test/a.pdf");
    act(() => {
      result.current.setTabSelection(tabA!.id, {
        text: "s",
        x: 0,
        y: 0,
        pdfX: 0,
        pdfY: 0,
        page: 1,
      });
      result.current.handleViewerStateChange(
        { pageNum: 3, scale: 1.5, viewMode: "continuous" },
        tabA!.id
      );
    });

    now += 10 * 60 * 1000;
    await openPath(result, "/test/b.pdf");
    // a+b 记账 400MB，未超预算，不休眠
    expect(result.current.tabs.every((t) => !t.hibernated)).toBe(true);

    now += 10 * 60 * 1000;
    await openPath(result, "/test/c.pdf");

    const tabs = result.current.tabs;
    expect(tabs).toHaveLength(3);
    expect(tabs[0].hibernated).toBe(true); // a 最久未激活
    expect(tabs[0].selection).toBeNull();
    expect(tabs[1].hibernated).toBeFalsy();
    expect(tabs[2].hibernated).toBeFalsy();
    expect(result.current.activeTab?.filePath).toBe("/test/c.pdf");
  });

  it("5 分钟保护窗口内的 tab 不可休眠，超预算放行", async () => {
    const { result } = renderHook(() => useTabs());

    await openPath(result, "/test/a.pdf");
    await openPath(result, "/test/b.pdf");
    await openPath(result, "/test/c.pdf"); // 600MB 超预算，但全部在保护窗口内

    expect(result.current.tabs).toHaveLength(3);
    expect(result.current.tabs.every((t) => !t.hibernated)).toBe(true);
  });

  it("activateTab 唤醒休眠 tab：hibernated 复位与 pendingGotoPage 同拍设置，并按预算休眠他人", async () => {
    const { result } = renderHook(() => useTabs());

    const tabA = await openPath(result, "/test/a.pdf");
    act(() => {
      result.current.handleViewerStateChange(
        { pageNum: 3, scale: 1.5, viewMode: "continuous" },
        tabA!.id
      );
    });
    now += 10 * 60 * 1000;
    await openPath(result, "/test/b.pdf");
    now += 10 * 60 * 1000;
    await openPath(result, "/test/c.pdf");
    expect(result.current.tabs[0].hibernated).toBe(true);

    now += 10 * 60 * 1000;
    act(() => {
      result.current.handleTabClick(tabA!.id);
    });

    const tabs = result.current.tabs;
    const woken = tabs.find((t) => t.id === tabA!.id)!;
    expect(result.current.activeTabId).toBe(tabA!.id);
    expect(woken.hibernated).toBe(false);
    // 复位与 pendingGotoPage 同一次 setTabs 完成，挂载时 initialState 已就绪
    expect(woken.pendingGotoPage).toBe(3);
    // 唤醒后 a+b+c 记账 600MB 超预算 → b 成为最久未激活的候选被休眠
    expect(tabs[1].hibernated).toBe(true);
    expect(tabs[2].hibernated).toBeFalsy();
  });

  it("wakeTab 唤醒但不激活（分屏副屏场景）", async () => {
    const { result } = renderHook(() => useTabs());

    const tabA = await openPath(result, "/test/a.pdf");
    now += 10 * 60 * 1000;
    await openPath(result, "/test/b.pdf");
    now += 10 * 60 * 1000;
    const tabC = await openPath(result, "/test/c.pdf");
    expect(result.current.tabs[0].hibernated).toBe(true);

    now += 10 * 60 * 1000;
    act(() => {
      result.current.wakeTab(tabA!.id);
    });

    const woken = result.current.tabs.find((t) => t.id === tabA!.id)!;
    expect(woken.hibernated).toBe(false);
    expect(woken.pendingGotoPage).toBe(1);
    // 不激活：active 仍是 c
    expect(result.current.activeTabId).toBe(tabC!.id);
  });

  it("注入上下文：流式会话中的 tab 与分屏 secondary 受保护", async () => {
    const ctx = {
      current: {
        secondaryTabId: null as string | null,
        streamingTabIds: new Set<string>(),
      },
    };
    const { result } = renderHook(() =>
      useTabs({ getHibernationContext: () => ctx.current })
    );

    const tabA = await openPath(result, "/test/a.pdf");
    now += 10 * 60 * 1000;
    const tabB = await openPath(result, "/test/b.pdf");
    // a 有流式会话、b 是分屏 secondary
    ctx.current.streamingTabIds = new Set([tabA!.id]);
    ctx.current.secondaryTabId = tabB!.id;

    now += 10 * 60 * 1000;
    await openPath(result, "/test/c.pdf");

    // 唯一可选候选是 c 之外…… a/b 均受保护，候选耗尽放行
    expect(result.current.tabs.every((t) => !t.hibernated)).toBe(true);

    // 撤掉保护后再次超预算：a 最老被休眠
    ctx.current.streamingTabIds = new Set();
    ctx.current.secondaryTabId = null;
    now += 10 * 60 * 1000;
    await openPath(result, "/test/d.pdf");
    expect(result.current.tabs[0].hibernated).toBe(true);
  });

  it("关闭非活跃的休眠 tab：直接删记录", async () => {
    const { result } = renderHook(() => useTabs());

    const tabA = await openPath(result, "/test/a.pdf");
    now += 10 * 60 * 1000;
    await openPath(result, "/test/b.pdf");
    now += 10 * 60 * 1000;
    await openPath(result, "/test/c.pdf");
    expect(result.current.tabs[0].hibernated).toBe(true);

    const onClose = vi.fn();
    act(() => {
      result.current.handleCloseTab(
        { stopPropagation: vi.fn() } as any,
        tabA!.id,
        onClose
      );
    });
    expect(onClose).toHaveBeenCalled();
    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.tabs.map((t) => t.id)).not.toContain(tabA!.id);
  });

  it("关闭活跃 tab 时顶替的休眠 tab 被唤醒", async () => {
    mockFileSize(300 * MB); // 单文件记账 600MB，两个存活即超预算
    const { result } = renderHook(() => useTabs());

    await openPath(result, "/test/a.pdf");
    now += 10 * 60 * 1000;
    const tabB = await openPath(result, "/test/b.pdf"); // a 是 active 受保护，暂不休眠
    act(() => {
      result.current.handleViewerStateChange(
        { pageNum: 7, scale: 1.5, viewMode: "continuous" },
        tabB!.id
      );
    });
    now += 10 * 60 * 1000;
    const tabC = await openPath(result, "/test/c.pdf"); // a 被休眠
    now += 10 * 60 * 1000;
    const tabD = await openPath(result, "/test/d.pdf"); // b 被休眠（c 是 active 受保护）

    expect(result.current.tabs.map((t) => !!t.hibernated)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(result.current.activeTabId).toBe(tabD!.id);

    // 先关掉非活跃的 c，使休眠的 b 成为 active d 的前一个 tab
    act(() => {
      result.current.handleCloseTab(
        { stopPropagation: vi.fn() } as any,
        tabC!.id
      );
    });
    expect(result.current.activeTabId).toBe(tabD!.id);

    act(() => {
      result.current.handleCloseTab(
        { stopPropagation: vi.fn() } as any,
        tabD!.id
      );
    });

    // 按索引顶替激活的 b 处于休眠：同拍唤醒并恢复页码
    expect(result.current.activeTabId).toBe(tabB!.id);
    expect(result.current.activeTab?.hibernated).toBe(false);
    expect(result.current.activeTab?.pendingGotoPage).toBe(7);
  });

  it("存活 viewer 数超 15 时即使字节充足也休眠", async () => {
    mockFileSize(1 * MB);
    const { result } = renderHook(() => useTabs());

    for (let i = 0; i < 16; i++) {
      now += 10 * 60 * 1000;
      await openPath(result, `/test/f${i}.pdf`);
    }

    const alive = result.current.tabs.filter((t) => !t.hibernated);
    expect(alive.length).toBeLessThanOrEqual(15);
    expect(result.current.tabs[0].hibernated).toBe(true);
  });

  it("100 个 tab 硬上限兜底：拒绝继续打开", async () => {
    mockFileSize(1 * MB);
    const { result } = renderHook(() => useTabs());

    for (let i = 0; i < 100; i++) {
      await openPath(result, `/test/f${i}.pdf`);
    }
    expect(result.current.tabs).toHaveLength(100);

    let overflow: any;
    await act(async () => {
      overflow = await result.current.openPdfByPath("/test/overflow.pdf");
    });
    expect(overflow).toBeNull();
    expect(result.current.tabs).toHaveLength(100);
  });
});
