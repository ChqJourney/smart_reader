import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import CustomInterpretModal from "../components/CustomInterpretModal";

describe("CustomInterpretModal", () => {
  it("renders prompt input and action buttons", () => {
    render(
      <CustomInterpretModal
        stashCount={2}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText(/自定义解读/)).toBeInTheDocument();
    expect(screen.getByText(/基于 2 个选中片段/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/输入你的解读要求/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /发送/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /取消/i })).toBeInTheDocument();
  });

  it("calls onSubmit with trimmed prompt and clears input", () => {
    const onSubmit = vi.fn();
    render(
      <CustomInterpretModal
        stashCount={1}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText(/输入你的解读要求/);
    fireEvent.change(input, { target: { value: "  请分析关系  " } });
    fireEvent.click(screen.getByRole("button", { name: /发送/i }));

    expect(onSubmit).toHaveBeenCalledWith("请分析关系");
  });

  it("does not submit when prompt is empty", () => {
    const onSubmit = vi.fn();
    render(
      <CustomInterpretModal
        stashCount={1}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /发送/i }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onClose when clicking cancel", () => {
    const onClose = vi.fn();
    render(
      <CustomInterpretModal
        stashCount={1}
        onSubmit={vi.fn()}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /取消/i }));

    expect(onClose).toHaveBeenCalled();
  });

  it("submits on Enter key", () => {
    const onSubmit = vi.fn();
    render(
      <CustomInterpretModal
        stashCount={1}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText(/输入你的解读要求/);
    fireEvent.change(input, { target: { value: "追问" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("追问");
  });
});
