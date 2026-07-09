import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import PdfAnnotations from "../components/PdfAnnotations";
import { Annotation } from "../services/annotations";

function makeAnnotation(
  id: string,
  type: Annotation["type"],
  page: number,
  overrides: Partial<Annotation> = {}
): Annotation {
  return {
    id,
    type,
    text: "text",
    position: { page, x: 10, y: 20 },
    content: "",
    isStreaming: false,
    createdAt: 1,
    ...overrides,
  };
}

describe("PdfAnnotations", () => {
  it("only shows annotations for the current page", () => {
    render(
      <PdfAnnotations
        annotations={[
          makeAnnotation("1", "explain", 1),
          makeAnnotation("2", "explain", 2),
        ]}
        pageNum={1}
        scale={1}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onExplainClick={vi.fn()}
      />
    );

    expect(screen.getAllByLabelText(/解读/i)).toHaveLength(1);
  });

  it("opens explain popup and calls onExplainClick when viewing", () => {
    const onExplainClick = vi.fn();
    render(
      <PdfAnnotations
        annotations={[makeAnnotation("1", "explain", 1)]}
        pageNum={1}
        scale={1}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onExplainClick={onExplainClick}
      />
    );

    fireEvent.click(screen.getByLabelText(/解读/i));
    expect(screen.getByRole("dialog", { name: /解读标记/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /查看解读/i }));
    expect(onExplainClick).toHaveBeenCalledWith("1");
  });

  it("calls onDelete from explain popup", () => {
    const onDelete = vi.fn();
    render(
      <PdfAnnotations
        annotations={[makeAnnotation("1", "explain", 1)]}
        pageNum={1}
        scale={1}
        onUpdate={vi.fn()}
        onDelete={onDelete}
        onExplainClick={vi.fn()}
      />
    );

    fireEvent.click(screen.getByLabelText(/解读/i));
    fireEvent.click(screen.getByRole("button", { name: /删除/i }));
    expect(onDelete).toHaveBeenCalledWith("1");
  });

  it("toggles translate popup visibility", () => {
    const onUpdate = vi.fn();
    render(
      <PdfAnnotations
        annotations={[makeAnnotation("1", "translate", 1)]}
        pageNum={1}
        scale={1}
        onUpdate={onUpdate}
        onDelete={vi.fn()}
        onExplainClick={vi.fn()}
      />
    );

    fireEvent.click(screen.getByLabelText(/翻译/i));

    expect(onUpdate).toHaveBeenCalledWith("1", { hidden: true });
  });

  it("opens interpreted stash popup and calls onDelete", () => {
    const onDelete = vi.fn();
    render(
      <PdfAnnotations
        annotations={[
          makeAnnotation("1", "stash", 1, {
            interpretedGroupSize: 2,
            interpretedIndex: 0,
          }),
        ]}
        pageNum={1}
        scale={1}
        onUpdate={vi.fn()}
        onDelete={onDelete}
        onExplainClick={vi.fn()}
      />
    );

    fireEvent.click(screen.getByLabelText(/已解读暂存/i));
    expect(screen.getByRole("dialog", { name: /已解读暂存/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /删除/i }));
    expect(onDelete).toHaveBeenCalledWith("1");
  });
});
