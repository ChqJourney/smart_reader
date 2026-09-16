import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
    model: "deepseek-v4-flash",
  },
  platformId: "deepseek",
  thinking: "auto",
  maxToolRounds: 20,
  agentToolsEnabled: true,
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
        return Promise.resolve({ success: true, model: "deepseek-v4-flash" });
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
});
