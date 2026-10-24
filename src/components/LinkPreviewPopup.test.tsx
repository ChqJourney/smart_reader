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

  it("zooms via header buttons and re-renders at the new scale", async () => {
    const pdf = makePdf();
    renderPopup(pdf);
    await waitFor(() => {
      expect(pdf.page.render).toHaveBeenCalledTimes(1);
    });
    const canvas = document.querySelector(
      ".link-preview-body canvas"
    ) as HTMLCanvasElement;
    // fit-to-width：jsdom clientWidth=0 → 回退 committedWidth 520，scale 5.2。
    expect(canvas.width).toBe(520);

    fireEvent.click(
      screen.getByRole("button", { name: "放大（Ctrl/Cmd+滚轮）" })
    );
    await waitFor(() => {
      expect(pdf.page.render).toHaveBeenCalledTimes(2);
    });
    // 5.2 × 1.2 ≈ 6.24 → 位图 624px。
    expect(canvas.width).toBe(624);
    // zoom≠1 时按视口像素定宽，超出部分走内容区原生滚动。
    expect(parseFloat(canvas.style.width)).toBeCloseTo(624, 5);

    fireEvent.click(
      screen.getByRole("button", { name: "缩小（Ctrl/Cmd+滚轮）" })
    );
    await waitFor(() => {
      expect(pdf.page.render).toHaveBeenCalledTimes(3);
    });
    expect(canvas.width).toBe(520);
    // 回到 zoom=1 恢复 CSS width:100% 跟随窗口拉伸。
    expect(canvas.style.width).toBe("");
  });

  it("zooms with Ctrl+wheel over the preview body; plain wheel does not zoom", async () => {
    const pdf = makePdf();
    renderPopup(pdf);
    await waitFor(() => {
      expect(pdf.page.render).toHaveBeenCalledTimes(1);
    });
    const body = document.querySelector(".link-preview-body") as HTMLDivElement;
    const canvas = document.querySelector(
      ".link-preview-body canvas"
    ) as HTMLCanvasElement;

    // 累积阈值 100：一次 deltaY -120 跨阈值放大一档。
    fireEvent.wheel(body, { deltaY: -120, ctrlKey: true });
    await waitFor(() => {
      expect(pdf.page.render).toHaveBeenCalledTimes(2);
    });
    expect(canvas.width).toBe(624);

    // 不带修饰键的滚轮保持原生滚动，不触发缩放重渲。
    fireEvent.wheel(body, { deltaY: -240 });
    await new Promise((r) => setTimeout(r, 50));
    expect(pdf.page.render).toHaveBeenCalledTimes(2);
  });

  it("pans the content by dragging the body (grab hand)", async () => {
    const pdf = makePdf();
    renderPopup(pdf);
    await waitFor(() => {
      expect(pdf.page.render).toHaveBeenCalled();
    });
    const body = document.querySelector(".link-preview-body") as HTMLDivElement;
    // jsdom 无布局：桩出溢出尺寸让 usePanScroll 的溢出门控通过。
    Object.defineProperty(body, "scrollWidth", {
      value: 1000,
      configurable: true,
    });
    Object.defineProperty(body, "clientWidth", {
      value: 500,
      configurable: true,
    });
    Object.defineProperty(body, "scrollHeight", {
      value: 2000,
      configurable: true,
    });
    Object.defineProperty(body, "clientHeight", {
      value: 400,
      configurable: true,
    });

    // 初次渲染已自动滚动到 dest（688），重置一个已知基线再拖拽。
    body.scrollTop = 100;
    fireEvent.mouseDown(body, { button: 0, clientX: 200, clientY: 200 });
    // 手型惯例：内容跟随光标——光标左上移，视口右下移。
    fireEvent.mouseMove(window, { clientX: 180, clientY: 170 });
    expect(body.classList.contains("panning")).toBe(true);
    expect(body.scrollLeft).toBe(20);
    expect(body.scrollTop).toBe(130);
    fireEvent.mouseUp(window);
    expect(body.classList.contains("panning")).toBe(false);
  });
});
