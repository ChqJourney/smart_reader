import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import PageJumpPanel from "./PageJumpPanel";

function renderPanel(
  overrides: Partial<{
    pageNum: number;
    numPages: number;
    onSubmit: (page: number) => void;
    onClose: () => void;
  }> = {}
) {
  const onSubmit = overrides.onSubmit ?? vi.fn();
  const onClose = overrides.onClose ?? vi.fn();
  render(
    <PageJumpPanel
      pageNum={overrides.pageNum ?? 3}
      numPages={overrides.numPages ?? 240}
      onSubmit={onSubmit}
      onClose={onClose}
    />
  );
  return { onSubmit, onClose };
}

describe("PageJumpPanel", () => {
  it("renders with the current page selected and total shown", () => {
    renderPanel({ pageNum: 3, numPages: 240 });
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("3");
    expect(screen.getByText("/ 240")).toBeInTheDocument();
    expect(document.activeElement).toBe(input);
  });

  it("submits the entered page on Enter", () => {
    const { onSubmit } = renderPanel();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith(42);
  });

  it("strips non-digit characters from input", () => {
    const { onSubmit } = renderPanel();
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1a2b" } });
    expect(input.value).toBe("12");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith(12);
  });

  it("closes without submitting on invalid input", () => {
    const { onSubmit, onClose } = renderPanel();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape without submitting", () => {
    const { onSubmit, onClose } = renderPanel();
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("closes when clicking outside the panel", () => {
    const { onClose } = renderPanel();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });
});
