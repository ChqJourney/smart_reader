import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import InterpretPopup from "./InterpretPopup";
import { Annotation } from "../services/annotations";
import {
  InterpretationSession,
  InterpretationMessage,
} from "../services/sessions";

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "anno-1",
    type: "explain",
    text: "some english text",
    position: { page: 1, x: 280, y: 290 },
    content: "",
    isStreaming: false,
    createdAt: 1000,
    sessionId: "session-1",
    ...overrides,
  };
}

function makeMessage(
  overrides: Partial<InterpretationMessage> = {}
): InterpretationMessage {
  return {
    id: "msg-1",
    role: "user",
    content: "hello",
    createdAt: 1000,
    ...overrides,
  };
}

function makeSession(
  overrides: Partial<InterpretationSession> = {}
): InterpretationSession {
  return {
    id: "session-1",
    sources: [],
    messages: [
      makeMessage({ id: "msg-1", role: "user", content: "请解读" }),
      makeMessage({ id: "msg-2", role: "assistant", content: "这是解读结果" }),
    ],
    isStreaming: false,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function renderPopup(
  props: Partial<React.ComponentProps<typeof InterpretPopup>> = {}
) {
  return render(
    <InterpretPopup
      annotation={makeAnnotation()}
      scale={1}
      variant="explain"
      session={makeSession()}
      onGotoSession={vi.fn()}
      onReinterpret={vi.fn()}
      onDelete={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />
  );
}

describe("InterpretPopup", () => {
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
        <InterpretPopup
          annotation={makeAnnotation()}
          scale={1}
          variant="explain"
          session={makeSession()}
          onGotoSession={vi.fn()}
          onDelete={vi.fn()}
          onClose={vi.fn()}
        />
      </div>
    );

    const popup = container.querySelector(".interpret-popup") as HTMLElement;
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

  it("shows the latest assistant answer inline with source text collapsed", () => {
    renderPopup();

    expect(screen.getByText(/这是解读结果/)).toBeInTheDocument();
    // 原文默认折叠
    expect(screen.queryByText("some english text")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /原文/i }));
    expect(screen.getByText("some english text")).toBeInTheDocument();
  });

  it("shows loading state while the session is streaming", () => {
    renderPopup({
      session: makeSession({
        isStreaming: true,
        streamingMessageId: "msg-2",
        messages: [
          makeMessage({ id: "msg-1", role: "user", content: "请解读" }),
          makeMessage({ id: "msg-2", role: "assistant", content: "" }),
        ],
      }),
    });

    expect(screen.getByText(/解读中/)).toBeInTheDocument();
    // 流式中禁用重新解读
    expect(screen.getByRole("button", { name: /重新解读/i })).toBeDisabled();
  });

  it("calls onReinterpret when clicking reinterpret", () => {
    const onReinterpret = vi.fn();
    renderPopup({ onReinterpret });

    fireEvent.click(screen.getByRole("button", { name: /重新解读/i }));

    expect(onReinterpret).toHaveBeenCalled();
  });

  it("falls back to expanded source text when session is missing", () => {
    renderPopup({ session: undefined, onReinterpret: undefined });

    expect(screen.getByText("some english text")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /重新解读/i })
    ).not.toBeInTheDocument();
  });
});
