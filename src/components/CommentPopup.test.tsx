import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import CommentPopup from "../components/CommentPopup";
import { Annotation } from "../services/annotations";

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "comment-1",
    type: "comment",
    text: "selected source text",
    position: { page: 1, x: 100, y: 200 },
    content: "",
    isStreaming: false,
    hidden: false,
    createdAt: 1000,
    ...overrides,
  };
}

describe("CommentPopup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders an editable textarea with the comment placeholder", () => {
    render(
      <div
        className="pdf-page-wrapper"
        style={{ width: 400, height: 400, position: "relative" }}
      >
        <CommentPopup
          annotation={makeAnnotation()}
          scale={1}
          onUpdate={vi.fn()}
          onHide={vi.fn()}
          onClose={vi.fn()}
        />
      </div>
    );

    const textarea = screen.getByPlaceholderText(/输入批注/);
    expect(textarea).toBeInTheDocument();
    expect(textarea).toHaveValue("");
  });

  it("does not render the original selected text", () => {
    render(
      <div
        className="pdf-page-wrapper"
        style={{ width: 400, height: 400, position: "relative" }}
      >
        <CommentPopup
          annotation={makeAnnotation({ text: "selected source text" })}
          scale={1}
          onUpdate={vi.fn()}
          onHide={vi.fn()}
          onClose={vi.fn()}
        />
      </div>
    );

    expect(screen.queryByText("selected source text")).not.toBeInTheDocument();
  });

  it("persists edited content via onUpdate (debounced)", () => {
    const onUpdate = vi.fn();
    render(
      <div
        className="pdf-page-wrapper"
        style={{ width: 400, height: 400, position: "relative" }}
      >
        <CommentPopup
          annotation={makeAnnotation()}
          scale={1}
          onUpdate={onUpdate}
          onHide={vi.fn()}
          onClose={vi.fn()}
        />
      </div>
    );

    const textarea = screen.getByPlaceholderText(/输入批注/);
    fireEvent.change(textarea, { target: { value: "我的批注内容" } });
    expect(textarea).toHaveValue("我的批注内容");

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(onUpdate).toHaveBeenCalledWith({
      content: "我的批注内容",
      isStreaming: false,
    });
  });

  it("commits the latest content on unmount without waiting for the debounce", () => {
    const onUpdate = vi.fn();
    const { unmount } = render(
      <div
        className="pdf-page-wrapper"
        style={{ width: 400, height: 400, position: "relative" }}
      >
        <CommentPopup
          annotation={makeAnnotation()}
          scale={1}
          onUpdate={onUpdate}
          onHide={vi.fn()}
          onClose={vi.fn()}
        />
      </div>
    );

    const textarea = screen.getByPlaceholderText(/输入批注/);
    fireEvent.change(textarea, { target: { value: "未等防抖的内容" } });

    // 不推进 300ms 防抖计时器，直接 unmount：最终内容必须被提交一次
    unmount();

    expect(onUpdate).toHaveBeenCalledWith({
      content: "未等防抖的内容",
      isStreaming: false,
    });
  });

  it("calls onClose when the delete button is clicked", () => {
    const onClose = vi.fn();
    render(
      <div
        className="pdf-page-wrapper"
        style={{ width: 400, height: 400, position: "relative" }}
      >
        <CommentPopup
          annotation={makeAnnotation()}
          scale={1}
          onUpdate={vi.fn()}
          onHide={vi.fn()}
          onClose={onClose}
        />
      </div>
    );

    fireEvent.click(screen.getByRole("button", { name: /删除/ }));
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onHide when the hide button is clicked", () => {
    const onHide = vi.fn();
    render(
      <div
        className="pdf-page-wrapper"
        style={{ width: 400, height: 400, position: "relative" }}
      >
        <CommentPopup
          annotation={makeAnnotation()}
          scale={1}
          onUpdate={vi.fn()}
          onHide={onHide}
          onClose={vi.fn()}
        />
      </div>
    );

    fireEvent.click(screen.getByRole("button", { name: /隐藏批注/ }));
    expect(onHide).toHaveBeenCalled();
  });
});
