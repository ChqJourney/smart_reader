import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useTabs } from "./useTabs";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../services/dialog", () => ({
  showMessage: vi.fn(),
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
        case "get_pdf_hash":
          return Promise.resolve(`hash-${args?.filePath}`);
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
          case "get_pdf_hash":
            return hashPromise.then(() => `hash-${args?.filePath}`);
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
    expect(mockInvoke).toHaveBeenCalledTimes(2); // authorize + hash only once each path
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
          case "get_pdf_hash":
            return hashPromise.then(() => `hash-${args?.filePath}`);
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
    const hashCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "get_pdf_hash"
    );
    expect(authorizeCalls).toHaveLength(1);
    expect(hashCalls).toHaveLength(1);
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
});
