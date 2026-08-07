import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useLinkPreviews,
  resolveLinkDest,
  extractDestY,
  LINK_PREVIEW_HOVER_DELAY_MS,
  LINK_PREVIEW_CLOSE_GRACE_MS,
  MAX_LINK_PREVIEWS,
  LINK_PREVIEW_DEFAULT_WIDTH,
  type LinkHoverInfo,
} from "./useLinkPreviews";

vi.mock("../services/logs", () => ({
  error: vi.fn(),
}));

function makePdf() {
  return {
    getDestination: vi.fn(async (name: string) => {
      if (name === "named-19.4")
        return [{ num: 5 }, { name: "XYZ" }, 72, 700, 1];
      return null;
    }),
    getPageIndex: vi.fn(async (ref: { num: number }) => ref.num - 1),
  };
}

function makeHover(dest: unknown): LinkHoverInfo {
  return { dest, clientX: 100, clientY: 100 };
}

/** 条款号数组形态 dest：页 12、Y=640。 */
const ARRAY_DEST = [{ num: 12 }, { name: "XYZ" }, 72, 640, 1];

describe("extractDestY", () => {
  it("extracts Y from XYZ destinations", () => {
    expect(extractDestY([{ num: 1 }, { name: "XYZ" }, 72, 640, 1])).toBe(640);
  });

  it("extracts Y from FitH destinations", () => {
    expect(extractDestY([{ num: 1 }, { name: "FitH" }, 512])).toBe(512);
  });

  it("returns null for other destination forms (falls back to page top)", () => {
    expect(extractDestY([{ num: 1 }, { name: "Fit" }])).toBeNull();
    expect(
      extractDestY([{ num: 1 }, { name: "XYZ" }, null, null, null])
    ).toBeNull();
  });
});

describe("resolveLinkDest", () => {
  it("resolves array destinations to a 1-based page and Y", async () => {
    const pdf = makePdf();
    const target = await resolveLinkDest(pdf as never, ARRAY_DEST);
    expect(target).toEqual({ page: 12, destY: 640 });
  });

  it("resolves named (string) destinations via getDestination", async () => {
    const pdf = makePdf();
    const target = await resolveLinkDest(pdf as never, "named-19.4");
    expect(pdf.getDestination).toHaveBeenCalledWith("named-19.4");
    expect(target).toEqual({ page: 5, destY: 700 });
  });

  it("returns null for unresolvable destinations", async () => {
    const pdf = makePdf();
    expect(await resolveLinkDest(pdf as never, "missing")).toBeNull();
    expect(
      await resolveLinkDest(pdf as never, [null, { name: "XYZ" }])
    ).toBeNull();
  });
});

describe("useLinkPreviews", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(pdf = makePdf()) {
    return renderHook(() => useLinkPreviews({ pdf: pdf as never }));
  }

  it("shows a preview after hovering a link for the hover delay", async () => {
    const { result } = setup();
    act(() => result.current.handleLinkHover(makeHover(ARRAY_DEST)));
    await act(async () => {
      vi.advanceTimersByTime(LINK_PREVIEW_HOVER_DELAY_MS);
    });

    expect(result.current.previews).toHaveLength(1);
    const preview = result.current.previews[0];
    expect(preview.page).toBe(12);
    expect(preview.destY).toBe(640);
    expect(preview.pinned).toBe(false);
  });

  it("cancels the pending preview when the mouse leaves before the delay", async () => {
    const { result } = setup();
    act(() => result.current.handleLinkHover(makeHover(ARRAY_DEST)));
    act(() => {
      vi.advanceTimersByTime(LINK_PREVIEW_HOVER_DELAY_MS - 1);
    });
    act(() => result.current.handleLinkHover(null));
    await act(async () => {
      vi.advanceTimersByTime(LINK_PREVIEW_HOVER_DELAY_MS);
    });

    expect(result.current.previews).toHaveLength(0);
  });

  it("closes a transient preview after the close grace period", async () => {
    const { result } = setup();
    act(() => result.current.handleLinkHover(makeHover(ARRAY_DEST)));
    await act(async () => {
      vi.advanceTimersByTime(LINK_PREVIEW_HOVER_DELAY_MS);
    });
    expect(result.current.previews).toHaveLength(1);

    act(() => result.current.handleLinkHover(null));
    act(() => {
      vi.advanceTimersByTime(LINK_PREVIEW_CLOSE_GRACE_MS + 1);
    });
    expect(result.current.previews).toHaveLength(0);
  });

  it("keeps the preview open when the mouse enters the popup within the grace period", async () => {
    const { result } = setup();
    act(() => result.current.handleLinkHover(makeHover(ARRAY_DEST)));
    await act(async () => {
      vi.advanceTimersByTime(LINK_PREVIEW_HOVER_DELAY_MS);
    });

    act(() => result.current.handleLinkHover(null));
    act(() => {
      vi.advanceTimersByTime(LINK_PREVIEW_CLOSE_GRACE_MS - 100);
    });
    act(() => result.current.handlePreviewEnter());
    act(() => {
      vi.advanceTimersByTime(LINK_PREVIEW_CLOSE_GRACE_MS * 2);
    });
    expect(result.current.previews).toHaveLength(1);

    // Leaving the popup re-arms the grace close.
    act(() => result.current.handlePreviewLeave());
    act(() => {
      vi.advanceTimersByTime(LINK_PREVIEW_CLOSE_GRACE_MS + 1);
    });
    expect(result.current.previews).toHaveLength(0);
  });

  it("keeps pinned previews open regardless of hover movement", async () => {
    const { result } = setup();
    act(() => result.current.handleLinkHover(makeHover(ARRAY_DEST)));
    await act(async () => {
      vi.advanceTimersByTime(LINK_PREVIEW_HOVER_DELAY_MS);
    });

    const id = result.current.previews[0].id;
    act(() => result.current.togglePreviewPin(id));
    expect(result.current.previews[0].pinned).toBe(true);

    act(() => result.current.handleLinkHover(null));
    act(() => result.current.handlePreviewLeave());
    act(() => {
      vi.advanceTimersByTime(LINK_PREVIEW_CLOSE_GRACE_MS * 4);
    });
    expect(result.current.previews).toHaveLength(1);
  });

  it("dedupes previews for the same destination", async () => {
    const { result } = setup();
    act(() => result.current.handleLinkHover(makeHover(ARRAY_DEST)));
    await act(async () => {
      vi.advanceTimersByTime(LINK_PREVIEW_HOVER_DELAY_MS);
    });
    // 固化后再次悬停同一条款：不弹第二个窗口。
    act(() => result.current.togglePreviewPin(result.current.previews[0].id));
    act(() => result.current.handleLinkHover(null));
    act(() => result.current.handleLinkHover(makeHover(ARRAY_DEST)));
    await act(async () => {
      vi.advanceTimersByTime(LINK_PREVIEW_HOVER_DELAY_MS);
    });
    expect(result.current.previews).toHaveLength(1);
  });

  it("keeps only one transient preview: showing a new one closes the previous", async () => {
    const { result } = setup();
    act(() => result.current.handleLinkHover(makeHover(ARRAY_DEST)));
    await act(async () => {
      vi.advanceTimersByTime(LINK_PREVIEW_HOVER_DELAY_MS);
    });
    expect(result.current.previews[0].page).toBe(12);

    const otherDest = [{ num: 30 }, { name: "FitH" }, 500];
    act(() => result.current.handleLinkHover(null));
    act(() => result.current.handleLinkHover(makeHover(otherDest)));
    await act(async () => {
      vi.advanceTimersByTime(LINK_PREVIEW_HOVER_DELAY_MS);
    });

    expect(result.current.previews).toHaveLength(1);
    expect(result.current.previews[0].page).toBe(30);
  });

  it("allows multiple pinned previews up to the cap", async () => {
    const { result } = setup();
    for (let i = 0; i < MAX_LINK_PREVIEWS; i++) {
      const dest = [{ num: i + 1 }, { name: "FitH" }, 100 + i];
      act(() => result.current.handleLinkHover(makeHover(dest)));
      await act(async () => {
        vi.advanceTimersByTime(LINK_PREVIEW_HOVER_DELAY_MS);
      });
      const current =
        result.current.previews[result.current.previews.length - 1];
      act(() => result.current.togglePreviewPin(current.id));
      act(() => result.current.handleLinkHover(null));
    }
    expect(result.current.previews).toHaveLength(MAX_LINK_PREVIEWS);

    // 全部固化且达上限：不再创建新预览。
    act(() => result.current.handleLinkHover(makeHover(ARRAY_DEST)));
    await act(async () => {
      vi.advanceTimersByTime(LINK_PREVIEW_HOVER_DELAY_MS);
    });
    expect(result.current.previews).toHaveLength(MAX_LINK_PREVIEWS);
  });

  it("does not create a preview when the destination cannot be resolved", async () => {
    const { result } = setup();
    act(() => result.current.handleLinkHover(makeHover("missing")));
    await act(async () => {
      vi.advanceTimersByTime(LINK_PREVIEW_HOVER_DELAY_MS);
    });
    expect(result.current.previews).toHaveLength(0);
  });

  it("closePreview removes the preview by id", async () => {
    const { result } = setup();
    act(() => result.current.handleLinkHover(makeHover(ARRAY_DEST)));
    await act(async () => {
      vi.advanceTimersByTime(LINK_PREVIEW_HOVER_DELAY_MS);
    });
    act(() => result.current.closePreview(result.current.previews[0].id));
    expect(result.current.previews).toHaveLength(0);
  });

  it("clamps the initial position inside the viewport", async () => {
    const { result } = setup();
    act(() =>
      result.current.handleLinkHover({
        dest: ARRAY_DEST,
        clientX: window.innerWidth - 10,
        clientY: window.innerHeight - 10,
      })
    );
    await act(async () => {
      vi.advanceTimersByTime(LINK_PREVIEW_HOVER_DELAY_MS);
    });
    const preview = result.current.previews[0];
    expect(preview.x + LINK_PREVIEW_DEFAULT_WIDTH).toBeLessThanOrEqual(
      window.innerWidth
    );
  });
});
