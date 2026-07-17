import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";
import { useDrag } from "./useDrag";

interface HostProps {
  onMove: (dx: number, dy: number) => void;
  onEnd?: () => void;
  threshold?: number;
  enabled?: boolean;
}

function DragHost({ onMove, onEnd, threshold, enabled }: HostProps) {
  const { isDragging, handlers } = useDrag({
    onMove,
    onEnd,
    threshold,
    enabled,
  });
  return (
    <div>
      <div data-testid="drag" {...handlers}>
        {isDragging ? "dragging" : "idle"}
      </div>
      <div data-testid="outside">sibling</div>
    </div>
  );
}

describe("useDrag", () => {
  it("reports delta once movement exceeds threshold", () => {
    const onMove = vi.fn();
    render(<DragHost onMove={onMove} threshold={2} />);

    fireEvent.mouseDown(screen.getByTestId("drag"), { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(screen.getByTestId("drag"), { clientX: 10, clientY: 20 });

    expect(onMove).toHaveBeenCalledWith(10, 20);
  });

  it("ignores sub-threshold movement", () => {
    const onMove = vi.fn();
    render(<DragHost onMove={onMove} threshold={5} />);

    fireEvent.mouseDown(screen.getByTestId("drag"), { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(screen.getByTestId("drag"), { clientX: 1, clientY: 2 });

    expect(onMove).not.toHaveBeenCalled();
    expect(screen.getByTestId("drag").textContent).toBe("idle");
  });

  it("reports incremental deltas across multiple moves", () => {
    const onMove = vi.fn();
    render(<DragHost onMove={onMove} threshold={2} />);

    fireEvent.mouseDown(screen.getByTestId("drag"), { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(screen.getByTestId("drag"), { clientX: 10, clientY: 0 });
    fireEvent.mouseMove(screen.getByTestId("drag"), { clientX: 13, clientY: 4 });

    expect(onMove).toHaveBeenNthCalledWith(1, 10, 0);
    expect(onMove).toHaveBeenNthCalledWith(2, 3, 4);
  });

  it("calls onEnd and clears isDragging on mouseup", () => {
    const onEnd = vi.fn();
    render(<DragHost onMove={vi.fn()} onEnd={onEnd} threshold={2} />);

    const drag = screen.getByTestId("drag");
    fireEvent.mouseDown(drag, { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(drag, { clientX: 10, clientY: 10 });
    expect(drag.textContent).toBe("dragging");

    fireEvent.mouseUp(drag, { clientX: 10, clientY: 10 });

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(drag.textContent).toBe("idle");
  });

  it("stops reporting after mouseup", () => {
    const onMove = vi.fn();
    render(<DragHost onMove={onMove} threshold={2} />);

    fireEvent.mouseDown(screen.getByTestId("drag"), { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(screen.getByTestId("drag"), { clientX: 10, clientY: 10 });
    fireEvent.mouseUp(screen.getByTestId("drag"), { clientX: 10, clientY: 10 });
    fireEvent.mouseMove(screen.getByTestId("drag"), { clientX: 50, clientY: 50 });

    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it("does not start when disabled", () => {
    const onMove = vi.fn();
    render(<DragHost onMove={onMove} enabled={false} threshold={2} />);

    fireEvent.mouseDown(screen.getByTestId("drag"), { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(screen.getByTestId("drag"), { clientX: 10, clientY: 10 });

    expect(onMove).not.toHaveBeenCalled();
  });

  it("keeps tracking when the cursor moves outside the drag handle (global listener)", () => {
    // This is the core fix for 10.4: a popup whose mousemove is bound only to
    // the header/body loses the event once the cursor leaves that element.
    // useDrag listens on window, so movement on a sibling still reports.
    const onMove = vi.fn();
    render(<DragHost onMove={onMove} threshold={2} />);

    fireEvent.mouseDown(screen.getByTestId("drag"), { clientX: 0, clientY: 0 });
    // Cursor moves onto the sibling element — outside the drag handle.
    fireEvent.mouseMove(screen.getByTestId("outside"), { clientX: 15, clientY: 5 });

    expect(onMove).toHaveBeenCalledWith(15, 5);
  });

  it("removes window listeners on unmount (no leak)", () => {
    const onMove = vi.fn();
    const { unmount } = render(<DragHost onMove={onMove} threshold={2} />);

    fireEvent.mouseDown(screen.getByTestId("drag"), { clientX: 0, clientY: 0 });
    unmount();

    // After unmount, dispatching a window mousemove should not call onMove.
    act(() => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 99, clientY: 99 }));
    });
    expect(onMove).not.toHaveBeenCalled();
  });
});
