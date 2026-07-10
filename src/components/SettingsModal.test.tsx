import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import SettingsModal from "./SettingsModal";

const defaultSettings = {
  llm: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini" },
  targetLanguage: "中文",
};

describe("SettingsModal", () => {
  it("does not render when closed", () => {
    render(
      <SettingsModal
        open={false}
        initialSettings={defaultSettings}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    );
    expect(screen.queryByText("设置")).not.toBeInTheDocument();
  });

  it("renders settings form with initial values", () => {
    render(
      <SettingsModal
        open
        initialSettings={defaultSettings}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    );
    expect(screen.getByLabelText("API Base URL")).toHaveValue("https://api.openai.com/v1");
    expect(screen.getByLabelText(/API Key/i)).toHaveValue("");
    expect(screen.getByLabelText("Model")).toHaveValue("gpt-4o-mini");
    expect(screen.getByLabelText("目标语言")).toHaveValue("中文");
  });

  it("saves updated settings", () => {
    const onSave = vi.fn();
    render(
      <SettingsModal
        open
        initialSettings={defaultSettings}
        onClose={vi.fn()}
        onSave={onSave}
      />
    );

    fireEvent.change(screen.getByLabelText("目标语言"), { target: { value: "English" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-4" } });
    fireEvent.click(screen.getByText("保存"));

    expect(onSave).toHaveBeenCalledWith({
      llm: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4" },
      targetLanguage: "English",
    });
  });

  it("calls onClose when cancel clicked or overlay clicked", () => {
    const onClose = vi.fn();
    const { container } = render(
      <SettingsModal
        open
        initialSettings={defaultSettings}
        onClose={onClose}
        onSave={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText("取消"));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(container.querySelector(".modal-overlay")!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
