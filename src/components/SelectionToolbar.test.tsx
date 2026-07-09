import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import SelectionToolbar from "../components/SelectionToolbar";

describe("SelectionToolbar", () => {
  it("renders nothing when there is no selection", () => {
    const { container } = render(
      <SelectionToolbar selection={null} onAction={vi.fn()} onDismiss={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders action buttons at given position", () => {
    render(
      <SelectionToolbar
        selection={{ text: "hello", x: 100, y: 200 }}
        onAction={vi.fn()}
        onAddToStash={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: /加入暂存/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /解读/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /翻译/i })).toBeInTheDocument();
  });

  it("calls onAction with action and text then dismisses", () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    render(
      <SelectionToolbar
        selection={{ text: "hello", x: 0, y: 0 }}
        onAction={onAction}
        onAddToStash={vi.fn()}
        onDismiss={onDismiss}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /解读/i }));

    expect(onAction).toHaveBeenCalledWith("explain", "hello");
    expect(onDismiss).toHaveBeenCalled();
  });

  it("calls onAddToStash with text then dismisses", () => {
    const onAddToStash = vi.fn();
    const onDismiss = vi.fn();
    render(
      <SelectionToolbar
        selection={{ text: "hello", x: 0, y: 0 }}
        onAction={vi.fn()}
        onAddToStash={onAddToStash}
        onDismiss={onDismiss}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /加入暂存/i }));

    expect(onAddToStash).toHaveBeenCalledWith("hello");
    expect(onDismiss).toHaveBeenCalled();
  });

  it("dismisses when clicking outside", async () => {
    const onDismiss = vi.fn();
    render(
      <div>
        <span data-testid="outside">outside</span>
        <SelectionToolbar
          selection={{ text: "hello", x: 0, y: 0 }}
          onAction={vi.fn()}
          onAddToStash={vi.fn()}
          onDismiss={onDismiss}
        />
      </div>
    );

    await new Promise((resolve) => setTimeout(resolve, 60));
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(onDismiss).toHaveBeenCalled();
  });
});
