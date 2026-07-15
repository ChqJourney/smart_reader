import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
const mockCheckUpdate = vi.hoisted(() => vi.fn());
const mockDownloadAndInstall = vi.hoisted(() => vi.fn());
const mockRelaunch = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mockListen,
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: mockGetVersion,
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: mockCheckUpdate,
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: mockRelaunch,
}));

const defaultSettings = {
  llm: {
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    model: "deepseek-v4-flash",
  },
  platformId: "deepseek" as const,
  thinking: "auto" as const,
  maxToolRounds: 5,
  targetLanguage: "中文",
  systemPrompts: {
    translate: "翻译提示词 {targetLanguage}",
    explain: "解读提示词 {targetLanguage}",
  },
  hoverTranslate: false,
  logLevel: "warn" as const,
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
    mockCheckUpdate.mockReset();
    mockDownloadAndInstall.mockReset();
    mockRelaunch.mockReset();
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
    expect(screen.getByLabelText(/API Base URL/i)).toHaveValue(
      "https://api.deepseek.com/v1"
    );
    expect(screen.getByLabelText(/API Key/i)).toHaveValue("");
    expect(screen.getByLabelText("Model")).toHaveValue("deepseek-v4-flash");
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
      target: { value: "deepseek-v4-pro" },
    });

    switchToFeaturePage();
    fireEvent.change(screen.getByLabelText("目标语言"), {
      target: { value: "English" },
    });

    fireEvent.click(screen.getByText("保存"));

    expect(onSave).toHaveBeenCalledWith({
      llm: { baseUrl: "https://api.deepseek.com/v1", apiKey: "", model: "deepseek-v4-pro" },
      platformId: "deepseek",
      thinking: "auto",
      maxToolRounds: 5,
      targetLanguage: "English",
      systemPrompts: defaultSettings.systemPrompts,
      hoverTranslate: false,
      logLevel: "warn",
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
      target: { value: "deepseek-v4-pro" },
    });
    fireEvent.click(screen.getByText("恢复全部默认"));
    fireEvent.click(screen.getByText("保存"));

    expect(onSave).toHaveBeenCalled();
    const saved = onSave.mock.calls[0][0];
    expect(saved.llm.model).toBe("deepseek-v4-flash");
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
    expect(screen.getByText("立即下载")).toBeInTheDocument();
    expect(
      document.querySelector(".dictionary-download-icon")
    ).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows byte-based progress when total size is unknown", async () => {
    let progressCallback: ((p: unknown) => void) | null = null;
    mockListen.mockImplementation(
      (_event: string, cb: (p: unknown) => void) => {
        progressCallback = cb;
        return Promise.resolve(() => {});
      }
    );

    const onSave = vi.fn();
    renderModal({
      open: true,
      initialSettings: defaultSettings,
      onClose: vi.fn(),
      onSave,
    });

    switchToFeaturePage();
    fireEvent.click(screen.getByLabelText("启用悬停取词翻译"));
    fireEvent.click(screen.getByText("立即下载"));

    await waitFor(() => {
      expect(progressCallback).not.toBeNull();
    });

    progressCallback!({
      payload: {
        status: "downloading",
        downloaded: 128 * 1024,
        total: 0,
      },
    });

    await waitFor(() => {
      expect(screen.getByText(/已下载\s+128\.0 KB/)).toBeInTheDocument();
    });
  });

  it("calls onClose when close, cancel or save clicked, but not overlay", () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    const { container } = renderModal({
      open: true,
      initialSettings: defaultSettings,
      onClose,
      onSave,
    });

    fireEvent.click(screen.getByLabelText("关闭"));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("取消"));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByText("保存"));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(2);

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

  it("renders check for updates button on system page", () => {
    renderModal({
      open: true,
      initialSettings: defaultSettings,
      onClose: vi.fn(),
      onSave: vi.fn(),
    });

    switchToSystemPage();

    expect(screen.getByText("软件更新")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /检查更新/i })
    ).toBeInTheDocument();
  });

  it("shows no update available when check returns none", async () => {
    mockCheckUpdate.mockResolvedValue({ available: false });

    renderModal({
      open: true,
      initialSettings: defaultSettings,
      onClose: vi.fn(),
      onSave: vi.fn(),
    });

    switchToSystemPage();

    fireEvent.click(screen.getByRole("button", { name: /检查更新/i }));

    await screen.findByText(/当前已是最新版本/i);
    expect(
      screen.queryByRole("button", { name: /检查更新/i })
    ).not.toBeInTheDocument();
  });

  it("shows upgrade button when an update is available", async () => {
    mockCheckUpdate.mockResolvedValue({
      available: true,
      version: "0.2.0",
      downloadAndInstall: mockDownloadAndInstall,
    });

    renderModal({
      open: true,
      initialSettings: defaultSettings,
      onClose: vi.fn(),
      onSave: vi.fn(),
    });

    switchToSystemPage();

    fireEvent.click(screen.getByRole("button", { name: /检查更新/i }));

    await screen.findByText(/发现新版本 0\.2\.0/i);
    expect(
      screen.getByRole("button", { name: /马上升级/i })
    ).toBeInTheDocument();
  });

  it("downloads, installs and relaunches when upgrade is clicked", async () => {
    mockDownloadAndInstall.mockResolvedValue(undefined);
    mockCheckUpdate.mockResolvedValue({
      available: true,
      version: "0.2.0",
      downloadAndInstall: mockDownloadAndInstall,
    });

    renderModal({
      open: true,
      initialSettings: defaultSettings,
      onClose: vi.fn(),
      onSave: vi.fn(),
    });

    switchToSystemPage();

    fireEvent.click(screen.getByRole("button", { name: /检查更新/i }));
    await screen.findByText(/发现新版本 0\.2\.0/i);

    fireEvent.click(screen.getByRole("button", { name: /马上升级/i }));

    await waitFor(() => {
      expect(mockDownloadAndInstall).toHaveBeenCalledTimes(1);
      expect(mockRelaunch).toHaveBeenCalledTimes(1);
    });
  });

  it("shows friendly message when no update package is available for current platform", async () => {
    mockCheckUpdate.mockRejectedValue(
      new Error(
        'None of the fallback platforms `["darwin-aarch64-app", "darwin-aarch64"]` were found in the response `platforms` object'
      )
    );

    renderModal({
      open: true,
      initialSettings: defaultSettings,
      onClose: vi.fn(),
      onSave: vi.fn(),
    });

    switchToSystemPage();

    fireEvent.click(screen.getByRole("button", { name: /检查更新/i }));

    await screen.findByText(/当前暂无适用于本系统的更新包/i);
    expect(screen.queryByText(/检查更新失败/i)).not.toBeInTheDocument();
  });

  it("shows error message when update check fails", async () => {
    mockCheckUpdate.mockRejectedValue(new Error("network error"));

    renderModal({
      open: true,
      initialSettings: defaultSettings,
      onClose: vi.fn(),
      onSave: vi.fn(),
    });

    switchToSystemPage();

    fireEvent.click(screen.getByRole("button", { name: /检查更新/i }));

    await screen.findByText(/检查更新失败.*network error/i);
  });
});
