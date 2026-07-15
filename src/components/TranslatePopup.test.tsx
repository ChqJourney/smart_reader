import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import TranslatePopup from "../components/TranslatePopup";
import { Annotation } from "../services/annotations";
import { DEFAULT_SETTINGS } from "../services/settings";

vi.mock("../services/llm", async () => {
  const actual =
    await vi.importActual<typeof import("../services/llm")>("../services/llm");
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
    (streamChatCompletion as ReturnType<typeof vi.fn>).mockImplementation(
      async function* () {
        // Never yield, simulating a pending stream
        await new Promise<void>(() => {});
      }
    );

    render(
      <TranslatePopup
        annotation={makeAnnotation()}
        scale={1}
        settings={DEFAULT_SETTINGS}
        onUpdate={vi.fn()}
        onHide={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText(/翻译中…/)).toBeInTheDocument();
    expect(document.querySelector(".loading-spinner")).toBeInTheDocument();
  });

  it("keeps loading spinner below existing content while streaming", () => {
    (streamChatCompletion as ReturnType<typeof vi.fn>).mockImplementation(
      async function* () {
        await new Promise<void>(() => {});
      }
    );

    render(
      <TranslatePopup
        annotation={makeAnnotation({
          content: "已有翻译内容",
          isStreaming: true,
        })}
        scale={1}
        settings={DEFAULT_SETTINGS}
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
    (streamChatCompletion as ReturnType<typeof vi.fn>).mockImplementation(
      async function* () {
        yield { type: "chunk", content: "翻译结果" };
      }
    );

    render(
      <TranslatePopup
        annotation={makeAnnotation()}
        scale={1}
        settings={DEFAULT_SETTINGS}
        onUpdate={vi.fn()}
        onHide={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await vi.waitFor(() => {
      expect(screen.queryByText(/翻译中…/)).not.toBeInTheDocument();
      expect(
        document.querySelector(".loading-spinner")
      ).not.toBeInTheDocument();
    });
  });

  it("adjusts position to stay within page wrapper bounds", () => {
    const onUpdate = vi.fn();
    const { container } = render(
      <div
        className="pdf-page-wrapper"
        style={{ width: 200, height: 200, position: "relative" }}
      >
        <TranslatePopup
          annotation={makeAnnotation({
            position: { page: 1, x: 180, y: 190 },
            content: "translation result",
            isStreaming: false,
          })}
          scale={1}
          settings={DEFAULT_SETTINGS}
          onUpdate={onUpdate}
          onHide={vi.fn()}
          onClose={vi.fn()}
        />
      </div>
    );

    const popup = container.querySelector(".translate-popup") as HTMLElement;
    const wrapper = popup.closest(".pdf-page-wrapper") as HTMLElement;
    expect(popup.offsetLeft + popup.offsetWidth).toBeLessThanOrEqual(
      wrapper.offsetWidth
    );
    expect(popup.offsetTop + popup.offsetHeight).toBeLessThanOrEqual(
      wrapper.offsetHeight
    );
  });

  it("re-clamps position when the wrapper resizes to its real size (tab activation)", () => {
    // jsdom does not fire real layout, so use a controllable ResizeObserver
    // that lets the test trigger the callback on demand.
    let roFire: (() => void) | null = null;
    class ControllableRO {
      cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
        roFire = () => cb([], this as unknown as ResizeObserver);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ControllableRO);

    const { container } = render(
      <div
        className="pdf-page-wrapper"
        style={{ width: 300, height: 300, position: "relative" }}
      >
        <TranslatePopup
          annotation={makeAnnotation({
            position: { page: 1, x: 280, y: 290 },
            content: "translation result",
            isStreaming: false,
          })}
          scale={1}
          settings={DEFAULT_SETTINGS}
          onUpdate={vi.fn()}
          onHide={vi.fn()}
          onClose={vi.fn()}
        />
      </div>
    );

    const popup = container.querySelector(".translate-popup") as HTMLElement;
    const wrapper = popup.closest(".pdf-page-wrapper") as HTMLElement;

    // Simulate the wrapper/popup having their real layout dimensions after the
    // page viewport finishes loading asynchronously.
    Object.defineProperty(popup, "offsetWidth", {
      get: () => 100,
      configurable: true,
    });
    Object.defineProperty(popup, "offsetHeight", {
      get: () => 80,
      configurable: true,
    });
    Object.defineProperty(wrapper, "offsetWidth", {
      get: () => 300,
      configurable: true,
    });
    Object.defineProperty(wrapper, "offsetHeight", {
      get: () => 300,
      configurable: true,
    });

    // Before the wrapper is measured, position is unclamped (raw left/top).
    expect(popup.style.left).toBe("280px");
    expect(popup.style.top).toBe("290px");

    // Fire the ResizeObserver callback to simulate the wrapper reaching its
    // real size after async viewport load.
    act(() => {
      roFire?.();
    });

    // transform translate(-50%, 12px):
    //   x range [50, 250], y range [-12, 208]
    expect(popup.style.left).toBe("250px");
    expect(popup.style.top).toBe("208px");

    vi.unstubAllGlobals();
  });
});
