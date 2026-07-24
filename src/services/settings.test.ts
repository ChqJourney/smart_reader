import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockTauriInvoke } from "../test/mocks/tauri";
import { AppSettings } from "../services/settings";

const DEFAULT_SETTINGS = {
  llm: {
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    model: "deepseek-v4-flash",
  },
  platformId: "deepseek",
  thinking: "auto",
  maxToolRounds: 20,
  agentToolsEnabled: false,
  targetLanguage: "中文",
  systemPrompts: {
    translate:
      "你是一位检测认证行业标准文档翻译助手，擅长把英文标准条款准确翻译成{targetLanguage}。请保持专业术语准确，首次出现关键术语时保留原文，不要编造片段中未提及的条款或页码。",
    explain:
      "你是一位检测认证行业标准文档阅读助手，擅长把复杂的英文标准条款解释得清晰易懂。请基于用户提供的文档片段用{targetLanguage}回答，不要编造片段中未提及的条款或页码。",
  },
  hoverTranslate: false,
  logLevel: "warn",
};

describe("settings service", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("loads default settings from backend", async () => {
    mockTauriInvoke({
      load_settings: () => ({ ...DEFAULT_SETTINGS }),
      check_api_key: () => false,
    });
    const { loadSettings } = await import("../services/settings");
    const settings = await loadSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it("does not expose backend api key to frontend", async () => {
    mockTauriInvoke({
      load_settings: () => ({
        llm: {
          baseUrl: "https://custom.example.com",
          apiKey: "sk-test",
          model: "gpt-4",
        },
        targetLanguage: "English",
      }),
      check_api_key: () => true,
    });
    const { loadSettings } = await import("../services/settings");
    const settings = await loadSettings();
    expect(settings.llm.baseUrl).toBe("https://custom.example.com");
    expect(settings.llm.apiKey).toBe("");
    expect(settings.targetLanguage).toBe("English");
    expect(settings.systemPrompts).toEqual(DEFAULT_SETTINGS.systemPrompts);
  });

  it("fills default system prompts when backend returns old format", async () => {
    mockTauriInvoke({
      load_settings: () => ({
        llm: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test",
          model: "gpt-4o-mini",
        },
        targetLanguage: "中文",
      }),
      check_api_key: () => true,
    });
    const { loadSettings } = await import("../services/settings");
    const settings = await loadSettings();
    expect(settings.systemPrompts.translate).toContain("翻译助手");
    expect(settings.systemPrompts.explain).toContain("阅读助手");
  });

  it("migrates legacy localStorage config when backend has no api key", async () => {
    localStorage.setItem(
      "standardread-llm-config",
      JSON.stringify({ apiKey: "legacy-key", model: "legacy-model" })
    );
    let savedSettings: any = null;
    mockTauriInvoke({
      load_settings: () => ({ ...DEFAULT_SETTINGS }),
      check_api_key: () => false,
      save_settings: (args) => {
        savedSettings = args.settings;
        return null;
      },
    });
    const { loadSettings } = await import("../services/settings");
    const settings = await loadSettings();
    expect(settings.llm.apiKey).toBe("legacy-key");
    expect(settings.llm.model).toBe("legacy-model");
    expect(savedSettings).not.toBeNull();
    expect(savedSettings.llm.apiKey).toBe("legacy-key");
    expect(localStorage.getItem("standardread-llm-config")).toBeNull();
  });

  it("keeps legacy localStorage config when migration save fails", async () => {
    localStorage.setItem(
      "standardread-llm-config",
      JSON.stringify({ apiKey: "legacy-key", model: "legacy-model" })
    );
    mockTauriInvoke({
      load_settings: () => ({ ...DEFAULT_SETTINGS }),
      check_api_key: () => false,
      save_settings: () => Promise.reject(new Error("disk full")),
    });
    const { loadSettings } = await import("../services/settings");
    const settings = await loadSettings();
    expect(settings.llm.apiKey).toBe("legacy-key");
    expect(localStorage.getItem("standardread-llm-config")).not.toBeNull();
  });

  it("does not migrate legacy config when backend already has an api key", async () => {
    localStorage.setItem(
      "standardread-llm-config",
      JSON.stringify({ apiKey: "legacy-key" })
    );
    let savedSettings: any = "not-called";
    mockTauriInvoke({
      load_settings: () => ({
        llm: {
          baseUrl: "https://api.example.com",
          apiKey: "",
          model: "gpt-4",
        },
        targetLanguage: "中文",
      }),
      check_api_key: () => true,
      save_settings: (args) => {
        savedSettings = args.settings;
        return null;
      },
    });
    const { loadSettings } = await import("../services/settings");
    const settings = await loadSettings();
    expect(settings.llm.apiKey).toBe("");
    expect(savedSettings).toBe("not-called");
  });

  it("falls back to defaults and legacy config when backend fails", async () => {
    localStorage.setItem(
      "standardread-llm-config",
      JSON.stringify({ apiKey: "legacy-key" })
    );
    mockTauriInvoke({
      load_settings: () => Promise.reject(new Error("backend error")),
    });
    const { loadSettings } = await import("../services/settings");
    const settings = await loadSettings();
    expect(settings.llm.apiKey).toBe("legacy-key");
    expect(settings.llm.model).toBe("deepseek-v4-flash");
    expect(settings.targetLanguage).toBe("中文");
  });

  it("saves settings via backend", async () => {
    let saved: any = null;
    mockTauriInvoke({
      save_settings: (args) => {
        saved = args.settings;
        return null;
      },
    });
    const { saveSettings } = await import("../services/settings");
    const settings: AppSettings = {
      llm: { baseUrl: "x", apiKey: "y", model: "z" },
      platformId: "custom",
      thinking: "auto",
      maxToolRounds: 20,
      agentToolsEnabled: true,
      targetLanguage: "中文",
      systemPrompts: {
        translate: "translate prompt",
        explain: "explain prompt",
      },
      hoverTranslate: true,
      logLevel: "warn",
    };
    await saveSettings(settings);
    expect(saved).toEqual(settings);
  });

  it("checkApiKey returns backend result", async () => {
    mockTauriInvoke({
      check_api_key: ({ platformId }) => platformId === "openai",
    });
    const { checkApiKey } = await import("../services/settings");
    expect(await checkApiKey("openai")).toBe(true);
    expect(await checkApiKey("deepseek")).toBe(false);
  });

  it("deleteApiKey invokes backend command", async () => {
    let deletedPlatform: string | null = null;
    mockTauriInvoke({
      delete_api_key: ({ platformId }) => {
        deletedPlatform = platformId;
        return null;
      },
    });
    const { deleteApiKey } = await import("../services/settings");
    await deleteApiKey("openai");
    expect(deletedPlatform).toBe("openai");
  });
});
