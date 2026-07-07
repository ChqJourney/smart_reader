import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AiChatPanel from "../components/AiChatPanel";
import { Annotation } from "../services/annotations";

vi.mock("../services/llm", async () => {
  const actual = await vi.importActual<typeof import("../services/llm")>("../services/llm");
  return {
    ...actual,
    streamChatCompletion: vi.fn(),
  };
});

import { streamChatCompletion } from "../services/llm";

function makeAnnotation(id: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id,
    type: "explain",
    text: "sample text",
    position: { page: 1, x: 0, y: 0 },
    content: "",
    isStreaming: true,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("AiChatPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows placeholder when no explain annotations", () => {
    render(
      <AiChatPanel
        explainAnnotations={[]}
        onGotoAnnotation={vi.fn()}
        onAnnotationUpdate={vi.fn()}
      />
    );

    expect(screen.getByText(/在 PDF 中选中内容/i)).toBeInTheDocument();
  });

  it("renders explain annotations sorted by createdAt desc", () => {
    const annotations: Annotation[] = [
      makeAnnotation("1", { createdAt: 100 }),
      makeAnnotation("2", { createdAt: 200 }),
    ];

    render(
      <AiChatPanel
        explainAnnotations={annotations}
        onGotoAnnotation={vi.fn()}
        onAnnotationUpdate={vi.fn()}
      />
    );

    expect(screen.getAllByText(/sample text/)).toHaveLength(2);
  });

  it("toggles settings form", () => {
    render(
      <AiChatPanel
        explainAnnotations={[]}
        onGotoAnnotation={vi.fn()}
        onAnnotationUpdate={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /打开设置/i }));
    expect(screen.getByPlaceholderText(/api.openai.com/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /关闭设置/i }));
    expect(screen.queryByPlaceholderText(/api.openai.com/i)).not.toBeInTheDocument();
  });

  it("streams content for new explain annotations", async () => {
    const onUpdate = vi.fn();
    const annotation = makeAnnotation("1");

    (streamChatCompletion as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield { type: "chunk", content: "解释" };
      yield { type: "chunk", content: "内容" };
    });

    render(
      <AiChatPanel
        explainAnnotations={[annotation]}
        onGotoAnnotation={vi.fn()}
        onAnnotationUpdate={onUpdate}
      />
    );

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith("1", { content: "解释内容" });
    });
  });
});
