import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import PdfAnnotations from "../components/PdfAnnotations";
import { Annotation } from "../services/annotations";
import { DEFAULT_SETTINGS } from "../services/settings";

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
    fileHash: "hash-a",
    ...overrides,
  };
}

function renderPdfAnnotations(
  props: Partial<React.ComponentProps<typeof PdfAnnotations>> & {
    annotations: Annotation[];
    pageNum: number;
  }
) {
  return render(
    <PdfAnnotations
      annotations={props.annotations}
      pageNum={props.pageNum}
      scale={props.scale ?? 1}
      fileHash={props.fileHash ?? "hash-a"}
      sessions={props.sessions}
      onUpdate={props.onUpdate ?? vi.fn()}
      onDelete={props.onDelete ?? vi.fn()}
      onExplainClick={props.onExplainClick ?? vi.fn()}
      onReinterpret={props.onReinterpret}
      settings={props.settings ?? DEFAULT_SETTINGS}
    />
  );
}

describe("PdfAnnotations", () => {
  it("only shows annotations for the current page", () => {
    renderPdfAnnotations({
      annotations: [
        makeAnnotation("1", "explain", 1),
        makeAnnotation("2", "explain", 2),
      ],
      pageNum: 1,
    });

    expect(screen.getAllByLabelText(/解读/i)).toHaveLength(1);
  });

  it("opens explain popup and calls onExplainClick when viewing", () => {
    const onExplainClick = vi.fn();
    renderPdfAnnotations({
      annotations: [makeAnnotation("1", "explain", 1)],
      pageNum: 1,
      onExplainClick,
    });

    fireEvent.click(screen.getByLabelText(/解读/i));
    expect(
      screen.getByRole("dialog", { name: /解读标记/i })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /查看解读/i }));
    expect(onExplainClick).toHaveBeenCalledWith("1");
  });

  it("shows inline result and calls onReinterpret for linked session", () => {
    const onReinterpret = vi.fn();
    renderPdfAnnotations({
      annotations: [
        makeAnnotation("1", "explain", 1, { sessionId: "session-1" }),
      ],
      pageNum: 1,
      sessions: [
        {
          id: "session-1",
          sources: [],
          messages: [
            { id: "m1", role: "user", content: "请解读", createdAt: 1 },
            {
              id: "m2",
              role: "assistant",
              content: "内联解读结果",
              createdAt: 2,
            },
          ],
          isStreaming: false,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      onReinterpret,
    });

    fireEvent.click(screen.getByLabelText(/解读/i));

    expect(screen.getByText(/内联解读结果/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /重新解读/i }));
    expect(onReinterpret).toHaveBeenCalledWith("session-1");
  });

  it("marks the marker as pending while the linked session is streaming", () => {
    const { container } = renderPdfAnnotations({
      annotations: [
        makeAnnotation("1", "explain", 1, { sessionId: "session-1" }),
      ],
      pageNum: 1,
      sessions: [
        {
          id: "session-1",
          sources: [],
          messages: [
            { id: "m1", role: "user", content: "请解读", createdAt: 1 },
            { id: "m2", role: "assistant", content: "", createdAt: 2 },
          ],
          isStreaming: true,
          streamingMessageId: "m2",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });

    expect(
      container.querySelector(".annotation-marker.pending")
    ).toBeInTheDocument();
  });

  it("calls onDelete from explain popup", () => {
    const onDelete = vi.fn();
    renderPdfAnnotations({
      annotations: [makeAnnotation("1", "explain", 1)],
      pageNum: 1,
      onDelete,
    });

    fireEvent.click(screen.getByLabelText(/解读/i));
    fireEvent.click(screen.getByRole("button", { name: /删除/i }));
    expect(onDelete).toHaveBeenCalledWith("1");
  });

  it("toggles translate popup visibility", () => {
    const onUpdate = vi.fn();
    renderPdfAnnotations({
      annotations: [makeAnnotation("1", "translate", 1)],
      pageNum: 1,
      onUpdate,
    });

    fireEvent.click(screen.getByLabelText(/翻译/i));

    expect(onUpdate).toHaveBeenCalledWith("1", { hidden: true });
  });

  it("opens interpreted stash popup and calls onDelete", () => {
    const onDelete = vi.fn();
    renderPdfAnnotations({
      annotations: [
        makeAnnotation("1", "stash", 1, {
          interpretedGroupSize: 2,
          interpretedIndex: 0,
        }),
      ],
      pageNum: 1,
      onDelete,
    });

    fireEvent.click(screen.getByLabelText(/已解读暂存/i));
    expect(
      screen.getByRole("dialog", { name: /已解读暂存/i })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /删除/i }));
    expect(onDelete).toHaveBeenCalledWith("1");
  });

  it("does not show annotations from a different fileHash", () => {
    renderPdfAnnotations({
      annotations: [
        makeAnnotation("1", "explain", 1),
        makeAnnotation("2", "explain", 1, { fileHash: "hash-b" }),
      ],
      pageNum: 1,
      fileHash: "hash-a",
    });

    expect(screen.getAllByLabelText(/解读/i)).toHaveLength(1);
  });
});
