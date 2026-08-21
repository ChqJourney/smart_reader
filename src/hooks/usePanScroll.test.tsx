import { describe, it, expect } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { useRef } from "react";
import { usePanScroll } from "./usePanScroll";

function PanHost({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { isPanning, handlers } = usePanScroll({
    getContainer: () => ref.current,
    active,
  });
  return (
    <div data-testid="scroller" ref={ref} {...handlers}>
      {isPanning ? "panning" : "idle"}
    </div>
  );
}

/** jsdom 的 scroll/client 尺寸恒为 0，手动定义以模拟内容溢出。 */
function mockOverflow(
  el: HTMLElement,
  {
    scrollWidth = 1000,
    clientWidth = 200,
    scrollHeight = 1000,
    clientHeight = 200,
  } = {}
) {
  Object.defineProperty(el, "scrollWidth", {
    configurable: true,
    value: scrollWidth,
  });
  Object.defineProperty(el, "clientWidth", {
    configurable: true,
    value: clientWidth,
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
}

describe("usePanScroll", () => {
  it("pans the container on drag when active and overflowing", () => {
    render(<PanHost active={true} />);
    const el = screen.getByTestId("scroller");
    mockOverflow(el);
    el.scrollTop = 100;
    el.scrollLeft = 50;

    fireEvent.mouseDown(el, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(el, { clientX: 10, clientY: 30 });

    // 内容跟随光标：光标下移 30 → scrollTop 减 30。
    expect(el.scrollTop).toBe(70);
    expect(el.scrollLeft).toBe(40);
    expect(el.textContent).toBe("panning");

    fireEvent.mouseUp(el);
    expect(el.textContent).toBe("idle");
  });

  it("does nothing when not active", () => {
    render(<PanHost active={false} />);
    const el = screen.getByTestId("scroller");
    mockOverflow(el);
    el.scrollTop = 100;

    fireEvent.mouseDown(el, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(el, { clientX: 10, clientY: 30 });

    expect(el.scrollTop).toBe(100);
    expect(el.textContent).toBe("idle");
  });

  it("does not start a drag when content does not overflow", () => {
    render(<PanHost active={true} />);
    const el = screen.getByTestId("scroller");
    mockOverflow(el, {
      scrollWidth: 200,
      clientWidth: 200,
      scrollHeight: 200,
      clientHeight: 200,
    });
    el.scrollTop = 0;

    fireEvent.mouseDown(el, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(el, { clientX: 10, clientY: 30 });

    expect(el.scrollTop).toBe(0);
    expect(el.textContent).toBe("idle");
  });

  it("ignores non-left mouse buttons", () => {
    render(<PanHost active={true} />);
    const el = screen.getByTestId("scroller");
    mockOverflow(el);
    el.scrollTop = 100;

    fireEvent.mouseDown(el, { button: 1, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(el, { clientX: 10, clientY: 30 });

    expect(el.scrollTop).toBe(100);
    expect(el.textContent).toBe("idle");
  });

  it("keeps panning until mouseup even if active flips off mid-drag (Space released)", () => {
    const { rerender } = render(<PanHost active={true} />);
    const el = screen.getByTestId("scroller");
    mockOverflow(el);
    el.scrollTop = 100;

    fireEvent.mouseDown(el, { button: 0, clientX: 0, clientY: 0 });
    // 拖动途中松开 Space。
    rerender(<PanHost active={false} />);
    fireEvent.mouseMove(el, { clientX: 0, clientY: 30 });

    expect(el.scrollTop).toBe(70);

    fireEvent.mouseUp(el);
    fireEvent.mouseMove(el, { clientX: 0, clientY: 60 });
    expect(el.scrollTop).toBe(70);
  });
});
