import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import TranslatePopup from "../components/TranslatePopup";
import { Annotation } from "../services/annotations";

vi.mock("../services/llm", async () => {
  const actual = await vi.importActual<typeof import("../services/llm")>("../services/llm");
  return {
    ...actual,
    streamChatCompletion: vi.fn(),
  };
});

import { streamChatCompletion } from "../services/llm";

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "anno-1",
    type: "translate",
    text: "hello world",
    position: { page: 1, x: 100, y: 200 },
    content: "",
    isStreaming: true,
    createdAt: 1000,
    ...overrides,
  };
}

describe("TranslatePopup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading spinner while streaming without content", () => {
    (streamChatCompletion as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      // Never yield, simulating a pending stream
      await new Promise<void>(() => {});
    });

    render(
      <TranslatePopup
        annotation={makeAnnotation()}
        scale={1}
        onUpdate={vi.fn()}
        onHide={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText(/翻译中…/)).toBeInTheDocument();
    expect(document.querySelector(".loading-spinner")).toBeInTheDocument();
  });

  it("keeps loading spinner below existing content while streaming", () => {
    (streamChatCompletion as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      await new Promise<void>(() => {});
    });

    render(
      <TranslatePopup
        annotation={makeAnnotation({ content: "已有翻译内容", isStreaming: true })}
        scale={1}
        onUpdate={vi.fn()}
        onHide={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText(/已有翻译内容/)).toBeInTheDocument();
    expect(screen.getByText(/翻译中…/)).toBeInTheDocument();
    expect(document.querySelector(".loading-spinner")).toBeInTheDocument();
  });

  it("hides loading spinner when streaming finishes", async () => {
    (streamChatCompletion as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield { type: "chunk", content: "翻译结果" };
    });

    render(
      <TranslatePopup
        annotation={makeAnnotation()}
        scale={1}
        onUpdate={vi.fn()}
        onHide={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await vi.waitFor(() => {
      expect(screen.queryByText(/翻译中…/)).not.toBeInTheDocument();
      expect(document.querySelector(".loading-spinner")).not.toBeInTheDocument();
    });
  });
});
