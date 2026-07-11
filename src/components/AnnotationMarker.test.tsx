import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import AnnotationMarker from "../components/AnnotationMarker";
import { Annotation } from "../services/annotations";

function makeAnnotation(
  type: Annotation["type"] = "explain",
  overrides: Partial<Annotation> = {}
): Annotation {
  return {
    id: "1",
    type,
    text: "text",
    position: { page: 1, x: 10, y: 20 },
    content: "",
    isStreaming: false,
    createdAt: 1,
    ...overrides,
  };
}

describe("AnnotationMarker", () => {
  it("renders explain label", () => {
    render(
      <AnnotationMarker
        annotation={makeAnnotation("explain")}
        scale={1.5}
        onClick={vi.fn()}
        onMove={vi.fn()}
      />
    );

    expect(screen.getByLabelText(/解读/i)).toBeInTheDocument();
  });

  it("renders translate label", () => {
    render(
      <AnnotationMarker
        annotation={makeAnnotation("translate")}
        scale={1.5}
        onClick={vi.fn()}
        onMove={vi.fn()}
      />
    );

    expect(screen.getByLabelText(/翻译/i)).toBeInTheDocument();
  });

  it("renders stash icon label", () => {
    render(
      <AnnotationMarker
        annotation={makeAnnotation("stash")}
        scale={1.5}
        onClick={vi.fn()}
        onMove={vi.fn()}
      />
    );

    expect(screen.getByLabelText(/暂存/i)).toBeInTheDocument();
  });

  it("renders interpreted stash marker with group info", () => {
    render(
      <AnnotationMarker
        annotation={makeAnnotation("stash", {
          interpretedGroupSize: 3,
          interpretedIndex: 1,
        })}
        scale={1.5}
        onClick={vi.fn()}
        onMove={vi.fn()}
      />
    );

    expect(screen.getByLabelText(/已解读暂存/i)).toBeInTheDocument();
  });

  it("calls onClick when clicked without dragging", () => {
    const onClick = vi.fn();
    render(
      <AnnotationMarker
        annotation={makeAnnotation()}
        scale={1}
        onClick={onClick}
        onMove={vi.fn()}
      />
    );

    fireEvent.click(screen.getByLabelText(/解读/i));

    expect(onClick).toHaveBeenCalled();
  });

  it("allows click again after a previous drag", () => {
    const onClick = vi.fn();
    render(
      <AnnotationMarker
        annotation={makeAnnotation()}
        scale={1}
        onClick={onClick}
        onMove={vi.fn()}
      />
    );

    const marker = screen.getByLabelText(/解读/i);

    // Drag
    fireEvent.mouseDown(marker, { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(marker, { clientX: 10, clientY: 20 });
    fireEvent.mouseUp(marker, { clientX: 10, clientY: 20 });
    fireEvent.click(marker);
    expect(onClick).not.toHaveBeenCalled();

    // Next click should work
    fireEvent.click(marker);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("calls onMove while dragging", () => {
    const onMove = vi.fn();
    render(
      <AnnotationMarker
        annotation={makeAnnotation()}
        scale={1}
        onClick={vi.fn()}
        onMove={onMove}
      />
    );

    const marker = screen.getByLabelText(/解读/i);
    fireEvent.mouseDown(marker, { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(marker, { clientX: 10, clientY: 20 });

    expect(onMove).toHaveBeenCalledWith(10, 20);
  });

  it("does not call onClick for plain stash marker", () => {
    const onClick = vi.fn();
    render(
      <AnnotationMarker
        annotation={makeAnnotation("stash")}
        scale={1}
        onClick={onClick}
        onMove={vi.fn()}
      />
    );

    fireEvent.click(screen.getByLabelText(/暂存/i));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("calls onClick and onMove for interpreted stash marker", () => {
    const onClick = vi.fn();
    const onMove = vi.fn();
    render(
      <AnnotationMarker
        annotation={makeAnnotation("stash", {
          interpretedGroupSize: 3,
          interpretedIndex: 1,
        })}
        scale={1}
        onClick={onClick}
        onMove={onMove}
      />
    );

    const marker = screen.getByLabelText(/已解读暂存/i);

    // Drag the marker.
    fireEvent.mouseDown(marker, { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(marker, { clientX: 5, clientY: 5 });
    fireEvent.mouseUp(marker, { clientX: 5, clientY: 5 });
    expect(onMove).toHaveBeenCalledWith(5, 5);

    // First click after a drag is ignored (it belongs to the drag gesture).
    fireEvent.click(marker);
    expect(onClick).not.toHaveBeenCalled();

    // Subsequent clicks open the popup.
    fireEvent.click(marker);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
