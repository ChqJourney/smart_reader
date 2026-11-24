import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import SetupWizard from "./SetupWizard";
import type { AppSettings } from "../services/settings";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

const defaultSettings: AppSettings = {
  llm: {
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    model: "deepseek-flash",
  },
  platformId: "deepseek",
  thinking: "auto",
  maxToolRounds: 20,
  agentToolsEnabled: true,
  webSearchEnabled: false,
  targetLanguage: "中文",
  systemPrompts: {
    translate: "翻译提示词 {targetLanguage}",
    explain: "解读提示词 {targetLanguage}",
  },
  hoverTranslate: false,
  linkPreviewEnabled: false,
  logLevel: "warn",
  rightPanelVisible: true,
  rightPanelWidth: 0,
  sessionSortMode: "recentActivity",
  theme: "system",
  lastSeenVersion: "",
};

describe("SetupWizard", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((command: string) => {
      if (command === "check_api_key") {
        return Promise.resolve(false);
      }
      if (command === "save_settings") {
        return Promise.resolve(undefined);
      }
      if (command === "test_connection") {
        return Promise.resolve({ success: true, model: "deepseek-flash" });
      }
      return Promise.reject(
        new Error(`No mock handler for command: ${command}`)
      );
    });
  });

  it("disables the start button again when the API key changes after a successful test", async () => {
    render(
      <SetupWizard
        open
        initialSettings={defaultSettings}
        onComplete={vi.fn()}
        onSkip={vi.fn()}
      />
    );

    // 步骤 1 → 2：填入密钥。
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.change(screen.getByLabelText("API 密钥"), {
      target: { value: "sk-old" },
    });

    // 步骤 2 → 3：测试连接成功，「开始使用」可用。
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "开始使用" })).toBeEnabled();
    });

    // 返回修改密钥后，旧的测试结果失效，「开始使用」重新禁用。
    fireEvent.click(screen.getByRole("button", { name: "上一步" }));
    fireEvent.change(screen.getByLabelText("API 密钥"), {
      target: { value: "sk-new" },
    });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByRole("button", { name: "开始使用" })).toBeDisabled();
  });

  it("ignores a connection result that arrives after the API key changed", async () => {
    let finishTest!: (value: { success: boolean; model: string }) => void;
    const testGate = new Promise<{ success: boolean; model: string }>(
      (resolve) => {
        finishTest = resolve;
      }
    );
    mockInvoke.mockImplementation((command: string) => {
      if (command === "check_api_key") return Promise.resolve(false);
      if (command === "save_settings") return Promise.resolve(null);
      if (command === "test_connection") return testGate;
      return Promise.reject(new Error(command));
    });
    render(
      <SetupWizard
        open
        initialSettings={defaultSettings}
        onComplete={vi.fn()}
        onSkip={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.change(screen.getByLabelText("API 密钥"), {
      target: { value: "sk-old" },
    });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("test_connection", {
        params: expect.objectContaining({ apiKey: "sk-old" }),
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "上一步" }));
    fireEvent.change(screen.getByLabelText("API 密钥"), {
      target: { value: "sk-new" },
    });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    await act(async () => {
      finishTest({ success: true, model: "deepseek-flash" });
      await testGate;
    });

    expect(screen.getByRole("button", { name: "开始使用" })).toBeDisabled();
    expect(
      mockInvoke.mock.calls.filter(([command]) => command === "save_settings")
    ).toHaveLength(0);
  });

  it("saves settings only when starting, not when testing", async () => {
    const onComplete = vi.fn();
    render(
      <SetupWizard
        open
        initialSettings={defaultSettings}
        onComplete={onComplete}
        onSkip={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.change(screen.getByLabelText("API 密钥"), {
      target: { value: "sk-test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "开始使用" })).toBeEnabled();
    });

    expect(
      mockInvoke.mock.calls.filter(([command]) => command === "save_settings")
    ).toHaveLength(0);
    expect(mockInvoke).toHaveBeenCalledWith("test_connection", {
      params: expect.objectContaining({
        platformId: "deepseek",
        apiKey: "sk-test",
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: "开始使用" }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(
      mockInvoke.mock.calls.filter(([command]) => command === "save_settings")
    ).toHaveLength(1);
  });
});
