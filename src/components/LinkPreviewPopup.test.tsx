import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import LinkPreviewPopup from "./LinkPreviewPopup";
import type { LinkPreviewState } from "../hooks/useLinkPreviews";

vi.mock("../services/logs", () => ({
  error: vi.fn(),
}));

function makePdf(overrides: { renderError?: boolean } = {}) {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 100 * scale,
      height: 200 * scale,
      scale,
      convertToViewportPoint: (x: number, y: number) => [x, y],
    }),
    render: vi.fn(() =>
      overrides.renderError
        ? { promise: Promise.reject(new Error("boom")), cancel: vi.fn() }
        : { promise: Promise.resolve(), cancel: vi.fn() }
    ),
  };
  return {
    getPage: vi.fn(async () => page),
    page,
  };
}

function makePreview(patch: Partial<LinkPreviewState> = {}): LinkPreviewState {
  return {
    id: "link-preview-1",
    key: "95:700",
    page: 95,
    destY: 700,
    x: 50,
    y: 50,
    width: 520,
    height: 400,
    pinned: false,
    ...patch,
  };
}

function renderPopup(pdf = makePdf(), preview = makePreview()) {
  const props = {
    onGoToPage: vi.fn(),
    onTogglePin: vi.fn(),
    onClose: vi.fn(),
    onMouseEnter: vi.fn(),
    onMouseLeave: vi.fn(),
  };
  const utils = render(
    <LinkPreviewPopup pdf={pdf as never} preview={preview} {...props} />
  );
  return { ...utils, props, pdf };
}

describe("LinkPreviewPopup", () => {
  beforeEach(() => {
    // jsdom 无 canvas 2d 实现：桩掉 getContext 让渲染流程走通。
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: vi.fn(),
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the target page into the popup canvas", async () => {
    const pdf = makePdf();
    renderPopup(pdf);

    await waitFor(() => {
      expect(pdf.getPage).toHaveBeenCalledWith(95);
    });
    await waitFor(() => {
      expect(pdf.page.render).toHaveBeenCalled();
    });
    // fit-to-width：jsdom clientWidth=0 → 回退 committedWidth 520，scale = 5.2。
    const canvas = document.querySelector(
      ".link-preview-body canvas"
    ) as HTMLCanvasElement;
    expect(canvas).toBeTruthy();
    expect(canvas.width).toBe(520);
  });

  it("scrolls the body to the destination Y after the first render", async () => {
    renderPopup();
    await waitFor(() => {
      const body = document.querySelector(
        ".link-preview-body"
      ) as HTMLDivElement;
      // destY=700，convertToViewportPoint 恒等映射，顶部留 12px 边距。
      expect(body.scrollTop).toBe(700 - 12);
    });
  });

  it("shows the page number title and navigates on click", async () => {
    const { props } = renderPopup();
    const title = await screen.findByRole("button", { name: "第 95 页" });
    fireEvent.click(title);
    expect(props.onGoToPage).toHaveBeenCalledWith(95);
  });

  it("reports pin toggle and close", async () => {
    const { props } = renderPopup();
    const pin = await screen.findByRole("button", {
      name: "固化预览（不随鼠标移出关闭）",
    });
    fireEvent.click(pin);
    expect(props.onTogglePin).toHaveBeenCalledWith("link-preview-1");

    const close = screen.getByRole("button", { name: "关闭预览" });
    fireEvent.click(close);
    expect(props.onClose).toHaveBeenCalledWith("link-preview-1");
  });

  it("reports mouse enter/leave for the grace-close logic", async () => {
    const { props, pdf } = renderPopup();
    // 等异步渲染链落地，避免事件断言后仍有 state 更新（act 警告）。
    await waitFor(() => {
      expect(pdf.page.render).toHaveBeenCalled();
    });
    const popup = document.querySelector(".link-preview-popup") as HTMLElement;
    fireEvent.mouseEnter(popup);
    expect(props.onMouseEnter).toHaveBeenCalled();
    fireEvent.mouseLeave(popup);
    expect(props.onMouseLeave).toHaveBeenCalled();
  });

  it("shows an error state when rendering fails", async () => {
    renderPopup(makePdf({ renderError: true }));
    expect(await screen.findByText("预览加载失败")).toBeInTheDocument();
  });
});
