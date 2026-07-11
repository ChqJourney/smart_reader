import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import SettingsModal from "./SettingsModal";
import { DictionaryStatusProvider } from "../hooks/useDictionaryStatus";

function renderModal(props: React.ComponentProps<typeof SettingsModal>) {
  return render(
    <DictionaryStatusProvider>
      <SettingsModal {...props} />
    </DictionaryStatusProvider>
  );
}

const mockInvoke = vi.hoisted(() => vi.fn());
const mockListen = vi.hoisted(() => vi.fn());
const mockGetVersion = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mockListen,
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: mockGetVersion,
}));

const defaultSettings = {
  llm: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
  },
  targetLanguage: "中文",
  systemPrompts: {
    translate: "翻译提示词 {targetLanguage}",
    explain: "解读提示词 {targetLanguage}",
  },
  hoverTranslate: false,
};

function switchToFeaturePage() {
  fireEvent.click(screen.getByRole("button", { name: /功能设置/i }));
}

function switchToSystemPage() {
  fireEvent.click(screen.getByRole("button", { name: /系统设置/i }));
}

describe("SettingsModal", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockListen.mockReset();
    mockGetVersion.mockReset();
    mockFetch.mockReset();
    mockListen.mockResolvedValue(() => {});
    mockGetVersion.mockResolvedValue("0.1.0");
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("SpecReader AI Proprietary License"),
    });
    globalThis.fetch = mockFetch;

    mockInvoke.mockImplementation((command: string) => {
      if (command === "check_dictionary") {
        return Promise.resolve({ exists: false, path: "" });
      }
      if (command === "download_dictionary") {
        return Promise.resolve(undefined);
      }
      return Promise.reject(
        new Error(`No mock handler for command: ${command}`)
      );
    });
  });

  it("does not render when closed", () => {
    renderModal({
      open: false,
      initialSettings: defaultSettings,
      onClose: vi.fn(),
      onSave: vi.fn(),
    });
    expect(screen.queryByText("设置")).not.toBeInTheDocument();
  });

  it("renders model settings page by default", () => {
    renderModal({
      open: true,
      initialSettings: defaultSettings,
      onClose: vi.fn(),
      onSave: vi.fn(),
    });
    expect(screen.getByLabelText("API Base URL")).toHaveValue(
      "https://api.openai.com/v1"
    );
    expect(screen.getByLabelText(/API Key/i)).toHaveValue("");
    expect(screen.getByLabelText("Model")).toHaveValue("gpt-4o-mini");
  });

  it("saves updated settings", () => {
    const onSave = vi.fn();
    renderModal({
      open: true,
      initialSettings: defaultSettings,
      onClose: vi.fn(),
      onSave,
    });

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "gpt-4" },
    });

    switchToFeaturePage();
    fireEvent.change(screen.getByLabelText("目标语言"), {
      target: { value: "English" },
    });

    fireEvent.click(screen.getByText("保存"));

    expect(onSave).toHaveBeenCalledWith({
      llm: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4" },
      targetLanguage: "English",
      systemPrompts: defaultSettings.systemPrompts,
      hoverTranslate: false,
    });
  });

  it("renders system prompt tabs and switches between translate and explain", () => {
    renderModal({
      open: true,
      initialSettings: defaultSettings,
      onClose: vi.fn(),
      onSave: vi.fn(),
    });

    switchToFeaturePage();

    expect(screen.getByText("系统提示词")).toBeInTheDocument();
    expect(screen.getByLabelText("翻译系统提示词")).toHaveValue(
      "翻译提示词 {targetLanguage}"
    );

    fireEvent.click(screen.getByText("解读"));
    expect(screen.getByLabelText("解读系统提示词")).toHaveValue(
      "解读提示词 {targetLanguage}"
    );
  });

  it("resets active prompt to default", () => {
    renderModal({
      open: true,
      initialSettings: defaultSettings,
      onClose: vi.fn(),
      onSave: vi.fn(),
    });

    switchToFeaturePage();

    const textarea = screen.getByLabelText("翻译系统提示词");
    fireEvent.change(textarea, { target: { value: "modified" } });
    expect(textarea).toHaveValue("modified");

    fireEvent.click(screen.getByText("恢复默认"));
    expect(textarea).not.toHaveValue("modified");
    expect((textarea as HTMLTextAreaElement).value).toContain("翻译助手");
  });

  it("resets all settings to defaults", () => {
    const onSave = vi.fn();
    renderModal({
      open: true,
      initialSettings: defaultSettings,
      onClose: vi.fn(),
      onSave,
    });

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "custom" },
    });
    fireEvent.click(screen.getByText("恢复全部默认"));
    fireEvent.click(screen.getByText("保存"));

    expect(onSave).toHaveBeenCalled();
    const saved = onSave.mock.calls[0][0];
    expect(saved.llm.model).toBe("gpt-4o-mini");
    expect(saved.systemPrompts.translate).toContain("翻译助手");
  });

  it("does not auto-save when toggling hover translate off", () => {
    const onSave = vi.fn();
    renderModal({
      open: true,
      initialSettings: { ...defaultSettings, hoverTranslate: true },
      onClose: vi.fn(),
      onSave,
    });

    switchToFeaturePage();

    const toggle = screen.getByLabelText("启用悬停取词翻译");
    fireEvent.click(toggle);

    expect(toggle).not.toBeChecked();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows download confirm when toggling hover translate on without dictionary", () => {
    const onSave = vi.fn();
    renderModal({
      open: true,
      initialSettings: defaultSettings,
      onClose: vi.fn(),
      onSave,
    });

    switchToFeaturePage();

    const toggle = screen.getByLabelText("启用悬停取词翻译");
    fireEvent.click(toggle);

    expect(screen.getByText("下载离线词典")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("calls onClose when cancel clicked or overlay clicked", () => {
    const onClose = vi.fn();
    const { container } = renderModal({
      open: true,
      initialSettings: defaultSettings,
      onClose,
      onSave: vi.fn(),
    });
    fireEvent.click(screen.getByText("取消"));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(container.querySelector(".modal-overlay")!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("displays app info and license on system page", async () => {
    renderModal({
      open: true,
      initialSettings: defaultSettings,
      onClose: vi.fn(),
      onSave: vi.fn(),
    });

    switchToSystemPage();

    expect(screen.getByText("应用信息")).toBeInTheDocument();
    expect(screen.getByText("0.1.0")).toBeInTheDocument();
    expect(screen.getByText("com.photonee.specreader")).toBeInTheDocument();

    // License text is loaded asynchronously.
    await screen.findByText("SpecReader AI Proprietary License");
  });
});
