import { describe, it, expect, vi } from "vitest";
import { render, act } from "@testing-library/react";
import ExplainPopup from "./ExplainPopup";
import { Annotation } from "../services/annotations";

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "anno-1",
    type: "explain",
    text: "some english text",
    position: { page: 1, x: 280, y: 290 },
    content: "",
    isStreaming: false,
    createdAt: 1000,
    ...overrides,
  };
}

describe("ExplainPopup", () => {
  it("clamps position inside the page wrapper and re-clamps on wrapper resize", () => {
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
        <ExplainPopup
          annotation={makeAnnotation()}
          scale={1}
          onGotoSession={vi.fn()}
          onDelete={vi.fn()}
          onClose={vi.fn()}
        />
      </div>
    );

    const popup = container.querySelector(".explain-popup") as HTMLElement;
    const wrapper = popup.closest(".pdf-page-wrapper") as HTMLElement;

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

    // Before measurement, raw position is used.
    expect(popup.style.left).toBe("280px");
    expect(popup.style.top).toBe("290px");

    act(() => {
      roFire?.();
    });

    // translate(-50%, 12px): x range [50, 250], y range [-12, 208]
    expect(popup.style.left).toBe("250px");
    expect(popup.style.top).toBe("208px");

    vi.unstubAllGlobals();
  });
});
