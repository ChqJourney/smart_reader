import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSearchDomain } from "./useSearchDomain";

interface MockItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function makeMockPdf(pages: MockItem[][]) {
  const pageMocks = pages.map((items) => ({
    getViewport: vi.fn(() => ({
      scale: 1,
      // identity transform for testability: returns inputs unchanged
      convertToViewportPoint: vi.fn((x: number, y: number) => [x, y]),
    })),
    getTextContent: vi.fn(async () => ({
      items: items.map((it) => ({
        str: it.str,
        transform: [1, 0, 0, 1, it.x, it.y],
        width: it.width,
        height: it.height,
      })),
    })),
  }));
  return {
    getPage: vi.fn(async (p: number) => pageMocks[p - 1]),
  };
}

function renderSearch(
  pdf: ReturnType<typeof makeMockPdf>,
  numPages: number,
  scale: number,
  goToPageRef: { current: ((page: number) => void) | null },
  currentPageRef: { current: number | null }
) {
  return renderHook(
    (props: { pdf: unknown; numPages: number; scale: number }) =>
      useSearchDomain({
        pdf: props.pdf as never,
        numPages: props.numPages,
        scale: props.scale,
        currentPageRef: currentPageRef as never,
        goToPageRef: goToPageRef as never,
      }),
    { initialProps: { pdf, numPages, scale } }
  );
}

describe("useSearchDomain", () => {
  it("builds index with PDF-space coords when searchOpen + query", async () => {
    const pdf = makeMockPdf([
      [{ str: "hello world", x: 10, y: 20, width: 50, height: 12 }],
    ]);
    const goToPageRef = { current: vi.fn() as ((p: number) => void) | null };
    const currentPageRef = { current: 1 };
    const { result } = renderSearch(pdf, 1, 1, goToPageRef, currentPageRef);

    act(() => {
      result.current.setSearchOpen(true);
      result.current.setSearchQuery("hello");
    });

    await waitFor(() => {
      expect(result.current.searchMatches.length).toBe(1);
    });

    const m = result.current.searchMatches[0];
    // convertToViewportPoint(10,20)=[10,20]; pdfY = 20 - height(12) = 8
    expect(m.pdfX).toBe(10);
    expect(m.pdfY).toBe(8);
    expect(m.pdfWidth).toBe(50);
    expect(m.pdfHeight).toBe(12);
    expect(m.page).toBe(1);
  });

  it("finds a phrase spanning item boundaries and highlights every contributing item", async () => {
    const pdf = makeMockPdf([
      [
        { str: "shall", x: 10, y: 20, width: 24, height: 12 },
        { str: "comply", x: 38, y: 20, width: 30, height: 12 },
      ],
    ]);
    const goToPageRef = { current: vi.fn() as ((p: number) => void) | null };
    const currentPageRef = { current: 1 };
    const { result } = renderSearch(pdf, 1, 1, goToPageRef, currentPageRef);

    act(() => {
      result.current.setSearchOpen(true);
      result.current.setSearchQuery("shall comply");
    });

    await waitFor(() => expect(result.current.searchMatches).toHaveLength(1));
    const highlights = result.current.searchHighlightsByPage.get(1)!;
    expect(highlights).toHaveLength(2);
    expect(highlights.map((highlight) => highlight.x)).toEqual([10, 38]);
    expect(highlights.map((highlight) => highlight.width)).toEqual([24, 30]);
  });

  it("finds a phrase spanning a line break and word-by-word items", async () => {
    const pdf = makeMockPdf([
      [
        { str: "rated", x: 10, y: 20, width: 25, height: 12 },
        { str: "voltage", x: 10, y: 40, width: 35, height: 12 },
        { str: "shall", x: 10, y: 60, width: 24, height: 12 },
        { str: "comply", x: 38, y: 60, width: 30, height: 12 },
      ],
    ]);
    const goToPageRef = { current: vi.fn() as ((p: number) => void) | null };
    const currentPageRef = { current: 1 };
    const { result } = renderSearch(pdf, 1, 1, goToPageRef, currentPageRef);

    act(() => {
      result.current.setSearchOpen(true);
      result.current.setSearchQuery("rated voltage");
    });
    await waitFor(() => expect(result.current.searchMatches).toHaveLength(1));

    act(() => result.current.setSearchQuery("shall comply"));
    await waitFor(() => expect(result.current.searchMatches).toHaveLength(1));
  });

  it("does not inject a space when PDF.js splits one word into adjacent items", async () => {
    const pdf = makeMockPdf([
      [
        { str: "com", x: 10, y: 20, width: 18, height: 12 },
        { str: "ply", x: 28, y: 20, width: 18, height: 12 },
      ],
    ]);
    const goToPageRef = { current: vi.fn() as ((p: number) => void) | null };
    const currentPageRef = { current: 1 };
    const { result } = renderSearch(pdf, 1, 1, goToPageRef, currentPageRef);

    act(() => {
      result.current.setSearchOpen(true);
      result.current.setSearchQuery("comply");
    });

    await waitFor(() => expect(result.current.searchMatches).toHaveLength(1));
    expect(result.current.searchHighlightsByPage.get(1)).toHaveLength(2);
  });

  it("does NOT rebuild the index when scale changes (9.1/9.6)", async () => {
    const pdf = makeMockPdf([
      [{ str: "hello", x: 10, y: 20, width: 50, height: 12 }],
    ]);
    const goToPageRef = { current: vi.fn() as ((p: number) => void) | null };
    const currentPageRef = { current: 1 };
    const { result, rerender } = renderSearch(pdf, 1, 1, goToPageRef, currentPageRef);

    act(() => {
      result.current.setSearchOpen(true);
      result.current.setSearchQuery("hello");
    });
    await waitFor(() => expect(result.current.searchMatches.length).toBe(1));
    expect(pdf.getPage).toHaveBeenCalledTimes(1);

    // Zoom: scale 1 -> 2. The index must remain stable, no re-scan.
    rerender({ pdf, numPages: 1, scale: 2 });
    await waitFor(() => {
      expect(result.current.searchMatches.length).toBe(1);
    });
    expect(result.current.searchMatches[0].pdfX).toBe(10); // still PDF space
    expect(pdf.getPage).toHaveBeenCalledTimes(1); // NOT re-scanned
  });

  it("renders highlights scaled to wrapper coords (×scale)", async () => {
    const pdf = makeMockPdf([
      [{ str: "hello", x: 10, y: 20, width: 50, height: 12 }],
    ]);
    const goToPageRef = { current: vi.fn() as ((p: number) => void) | null };
    const currentPageRef = { current: 1 };
    const { result, rerender } = renderSearch(pdf, 1, 1, goToPageRef, currentPageRef);

    act(() => {
      result.current.setSearchOpen(true);
      result.current.setSearchQuery("hello");
    });
    await waitFor(() => expect(result.current.searchMatches.length).toBe(1));

    const h1 = result.current.searchHighlightsByPage.get(1)![0];
    expect(h1.x).toBe(10);
    expect(h1.width).toBe(50);
    expect(h1.isActive).toBe(true);

    rerender({ pdf, numPages: 1, scale: 2 });
    const h2 = result.current.searchHighlightsByPage.get(1)![0];
    expect(h2.x).toBe(20); // ×2
    expect(h2.width).toBe(100);
    expect(h2.y).toBe(16); // (20-12)*2 = 16
  });

  it("jumps to the active match via goToPageRef, not re-jumping on identity change (10.2)", async () => {
    const pdf = makeMockPdf([
      [{ str: "hello", x: 10, y: 20, width: 50, height: 12 }],
    ]);
    const goToPage1 = vi.fn();
    const goToPageRef = { current: goToPage1 as ((p: number) => void) | null };
    const currentPageRef = { current: 1 };
    const { result, rerender } = renderSearch(pdf, 1, 1, goToPageRef, currentPageRef);

    act(() => {
      result.current.setSearchOpen(true);
      result.current.setSearchQuery("hello");
    });
    await waitFor(() => expect(result.current.searchMatches.length).toBe(1));
    // active-match effect fires once for the initial active index
    await waitFor(() => expect(goToPage1).toHaveBeenCalledWith(1));

    // Simulate pageViewports updating → PdfViewer rebuilds goToPage (new
    // identity). The active effect must NOT re-run (deps unchanged).
    const goToPage2 = vi.fn();
    goToPageRef.current = goToPage2;
    rerender({ pdf, numPages: 1, scale: 1 });

    // Give any would-be effect a chance to fire
    await waitFor(() => expect(result.current.searchMatches.length).toBe(1));
    expect(goToPage2).not.toHaveBeenCalled();
    expect(goToPage1).toHaveBeenCalledTimes(1);
  });

  it("navigates matches with next/prev", async () => {
    const pdf = makeMockPdf([
      [
        { str: "hello a", x: 10, y: 20, width: 50, height: 12 },
        { str: "hello b", x: 10, y: 40, width: 50, height: 12 },
      ],
    ]);
    const goToPageRef = { current: vi.fn() as ((p: number) => void) | null };
    const currentPageRef = { current: 1 };
    const { result } = renderSearch(pdf, 1, 1, goToPageRef, currentPageRef);

    act(() => {
      result.current.setSearchOpen(true);
      result.current.setSearchQuery("hello");
    });
    await waitFor(() => expect(result.current.searchMatches.length).toBe(2));
    expect(result.current.searchActiveIndex).toBe(0);

    act(() => result.current.goToNextMatch());
    expect(result.current.searchActiveIndex).toBe(1);

    act(() => result.current.goToPrevMatch());
    expect(result.current.searchActiveIndex).toBe(0);
  });

  it("resets searchLoading when the query is cleared mid-build (fix #5)", async () => {
    // A build that hangs inside getTextContent so we can cancel it mid-flight.
    let resolveText: ((v: { items: unknown[] }) => void) | null = null;
    const hangingPage = {
      getViewport: vi.fn(() => ({
        scale: 1,
        convertToViewportPoint: vi.fn((x: number, y: number) => [x, y]),
      })),
      getTextContent: vi.fn(
        () =>
          new Promise<{ items: unknown[] }>((resolve) => {
            resolveText = resolve;
          })
      ),
    };
    const pdf = { getPage: vi.fn(async () => hangingPage) };
    const goToPageRef = { current: vi.fn() as ((p: number) => void) | null };
    const currentPageRef = { current: 1 };
    const { result } = renderSearch(
      pdf as never,
      1,
      1,
      goToPageRef,
      currentPageRef
    );

    act(() => {
      result.current.setSearchOpen(true);
      result.current.setSearchQuery("hello");
    });
    // Build starts after the 250ms debounce and blocks on getTextContent.
    await waitFor(() => expect(result.current.searchLoading).toBe(true));

    // Clearing the query cancels the build; the early-return branch must
    // reset the loading flag (a cancelled build skips its own reset).
    act(() => {
      result.current.setSearchQuery("");
    });
    expect(result.current.searchLoading).toBe(false);

    // Let the in-flight build resolve: it must not flip the flag back on.
    await act(async () => {
      resolveText?.({ items: [] });
      await Promise.resolve();
    });
    expect(result.current.searchLoading).toBe(false);
    expect(result.current.searchMatches.length).toBe(0);
  });
});
