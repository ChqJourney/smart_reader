import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import TitleBarToggles from "./TitleBarToggles";

const baseProps = {
  showHoverTranslate: false,
  hoverTranslateEnabled: false,
  onToggleHoverTranslate: vi.fn(),
  showAgentTools: false,
  agentToolsEnabled: false,
  onToggleAgentTools: vi.fn(),
  modelDisplay: null as string | null,
};

function renderToggles(overrides: Partial<typeof baseProps> = {}) {
  return render(<TitleBarToggles {...baseProps} {...overrides} />);
}

describe("TitleBarToggles", () => {
  it("renders nothing when no item is visible", () => {
    const { container } = renderToggles();
    expect(container.firstChild).toBeNull();
  });

  it("shows hover translate toggle only when dictionary is ready", () => {
    const { rerender } = renderToggles();
    expect(screen.queryByTestId("toggle-hover-translate")).toBeNull();

    rerender(<TitleBarToggles {...baseProps} showHoverTranslate />);
    expect(screen.getByTestId("toggle-hover-translate")).toBeInTheDocument();
  });

  it("reflects hover translate state and calls back on click", () => {
    const onToggle = vi.fn();
    renderToggles({
      showHoverTranslate: true,
      hoverTranslateEnabled: true,
      onToggleHoverTranslate: onToggle,
    });

    const btn = screen.getByTestId("toggle-hover-translate");
    expect(btn).toHaveAttribute("aria-checked", "true");
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("shows agent tools toggle and model display only when API key is configured", () => {
    const { rerender } = renderToggles();
    expect(screen.queryByTestId("toggle-agent-tools")).toBeNull();
    expect(screen.queryByTestId("titlebar-model-display")).toBeNull();

    rerender(
      <TitleBarToggles
        {...baseProps}
        showAgentTools
        modelDisplay="DeepSeek · deepseek-v4-flash"
      />
    );
    expect(screen.getByTestId("toggle-agent-tools")).toBeInTheDocument();
    expect(screen.getByTestId("titlebar-model-display")).toHaveTextContent(
      "DeepSeek · deepseek-v4-flash"
    );
  });

  it("asks for confirmation before enabling agent tools", () => {
    const onToggle = vi.fn();
    renderToggles({ showAgentTools: true, onToggleAgentTools: onToggle });

    fireEvent.click(screen.getByTestId("toggle-agent-tools"));

    // 弹出确认框，回调尚未触发
    expect(screen.getByText("开启智能文档查阅")).toBeInTheDocument();
    expect(screen.getByText(/大幅增加 token 消耗/)).toBeInTheDocument();
    expect(onToggle).not.toHaveBeenCalled();

    // 取消：不开启
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByText("开启智能文档查阅")).toBeNull();
    expect(onToggle).not.toHaveBeenCalled();

    // 再次打开并确认：触发开启
    fireEvent.click(screen.getByTestId("toggle-agent-tools"));
    fireEvent.click(screen.getByRole("button", { name: "开启" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("开启智能文档查阅")).toBeNull();
  });

  it("disables agent tools immediately without confirmation", () => {
    const onToggle = vi.fn();
    renderToggles({
      showAgentTools: true,
      agentToolsEnabled: true,
      onToggleAgentTools: onToggle,
    });

    const btn = screen.getByTestId("toggle-agent-tools");
    expect(btn).toHaveAttribute("aria-checked", "true");
    fireEvent.click(btn);

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("开启智能文档查阅")).toBeNull();
  });
});
