import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
import type { MutableRefObject } from "react";
import PageRail from "./PageRail";
import type { PageViewportInfo } from "../hooks/useViewportManager";

beforeAll(() => {
  // jsdom 不实现 pointer capture，但滑轨拖动会用到。
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = vi.fn();
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = vi.fn();
  }
});

const defaultRect = {
  top: 0,
  left: 0,
  right: 200,
  bottom: 600,
  width: 200,
  height: 600,
  x: 0,
  y: 0,
};

function getBoundingClientRect(rect = defaultRect) {
  return () => ({ ...rect, toJSON: () => ({}) });
}

function TestPageRail({
  bodyRect = defaultRect,
  pageNum = 3,
  viewMode = "single",
  onPageUp = vi.fn(),
  onPageDown = vi.fn(),
}: {
  bodyRect?: typeof defaultRect;
  pageNum?: number;
  viewMode?: "single" | "continuous";
  onPageUp?: () => void;
  onPageDown?: () => void;
}) {
  const viewerBodyRef: MutableRefObject<HTMLDivElement | null> = {
    current: null,
  };
  const continuousContainerRef: MutableRefObject<HTMLDivElement | null> = {
    current: null,
  };
  const pageViewportsRef: MutableRefObject<Map<number, PageViewportInfo>> = {
    current: new Map(),
  };
  const scaleRef: MutableRefObject<number> = { current: 1 };

  return (
    <div
      ref={(el) => {
        viewerBodyRef.current = el;
        if (el) {
          el.getBoundingClientRect = getBoundingClientRect(bodyRect);
        }
      }}
      data-testid="viewer-body"
      style={{ position: "relative", width: 200, height: 600 }}
    >
      <PageRail
        viewMode={viewMode}
        pageNum={pageNum}
        numPages={10}
        continuousContainerRef={continuousContainerRef}
        pageViewportsRef={pageViewportsRef}
        scaleRef={scaleRef}
        goToPage={vi.fn()}
        viewerBodyRef={viewerBodyRef}
        onPageUp={onPageUp}
        onPageDown={onPageDown}
      />
    </div>
  );
}

describe("PageRail 显隐与翻页按钮", () => {
  it("默认隐藏翻页键与滑轨", () => {
    const { container } = render(<TestPageRail />);
    const wrapper = container.querySelector(".page-rail-wrapper");
    expect(wrapper).not.toBeNull();
    expect(wrapper).not.toHaveClass("visible");
  });

  it("鼠标靠近阅读区右边界时显示控件", async () => {
    const { getByTestId } = render(<TestPageRail />);
    const body = getByTestId("viewer-body");

    fireEvent.mouseMove(body, { clientX: 170, clientY: 100 });
    await waitFor(() => {
      expect(body.querySelector(".page-rail-wrapper")).toHaveClass("visible");
    });

    fireEvent.mouseMove(body, { clientX: 100, clientY: 100 });
    await waitFor(() => {
      expect(body.querySelector(".page-rail-wrapper")).not.toHaveClass(
        "visible"
      );
    });
  });

  it("点击上/下翻页按钮调用对应回调", async () => {
    const onPageUp = vi.fn();
    const onPageDown = vi.fn();
    const { getByTestId, getByLabelText } = render(
      <TestPageRail onPageUp={onPageUp} onPageDown={onPageDown} />
    );
    const body = getByTestId("viewer-body");

    fireEvent.mouseMove(body, { clientX: 170, clientY: 100 });
    await waitFor(() => {
      expect(body.querySelector(".page-rail-wrapper")).toHaveClass("visible");
    });

    fireEvent.click(getByLabelText(/上一页/));
    expect(onPageUp).toHaveBeenCalledTimes(1);

    fireEvent.click(getByLabelText(/下一页/));
    expect(onPageDown).toHaveBeenCalledTimes(1);
  });

  it("拖动滑轨期间保持显示，释放后隐藏", async () => {
    const { getByTestId } = render(<TestPageRail />);
    const body = getByTestId("viewer-body");
    const rail = body.querySelector(".page-rail") as HTMLDivElement;

    fireEvent.mouseMove(body, { clientX: 170, clientY: 100 });
    await waitFor(() => {
      expect(body.querySelector(".page-rail-wrapper")).toHaveClass("visible");
    });

    fireEvent.pointerDown(rail, { pointerId: 1, clientX: 190, clientY: 300 });
    expect(body.querySelector(".page-rail-wrapper")).toHaveClass("visible");

    // 拖离右边界后仍应保持显示
    fireEvent.mouseMove(body, { clientX: 100, clientY: 300 });
    await waitFor(() => {
      expect(body.querySelector(".page-rail-wrapper")).toHaveClass("visible");
    });

    fireEvent.pointerUp(rail, { pointerId: 1 });
    await waitFor(() => {
      expect(body.querySelector(".page-rail-wrapper")).not.toHaveClass(
        "visible"
      );
    });
  });

  it("单页模式在首尾页禁用对应按钮", async () => {
    const { getByTestId, getByLabelText } = render(
      <TestPageRail pageNum={1} viewMode="single" />
    );
    const body = getByTestId("viewer-body");
    fireEvent.mouseMove(body, { clientX: 170, clientY: 100 });
    await waitFor(() => {
      expect(body.querySelector(".page-rail-wrapper")).toHaveClass("visible");
    });

    expect(getByLabelText(/上一页/)).toBeDisabled();
    expect(getByLabelText(/下一页/)).not.toBeDisabled();
  });
});
