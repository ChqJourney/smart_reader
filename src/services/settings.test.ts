import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockTauriInvoke } from "../test/mocks/tauri";

const DEFAULT_SETTINGS = {
  llm: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
  },
  targetLanguage: "中文",
};

describe("settings service", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("loads default settings from backend", async () => {
    mockTauriInvoke({
      load_settings: () => ({ ...DEFAULT_SETTINGS }),
    });
    const { loadSettings } = await import("../services/settings");
    const settings = await loadSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it("merges backend settings when backend has custom values", async () => {
    mockTauriInvoke({
      load_settings: () => ({
        llm: { baseUrl: "https://custom.example.com", apiKey: "sk-test", model: "gpt-4" },
        targetLanguage: "English",
      }),
    });
    const { loadSettings } = await import("../services/settings");
    const settings = await loadSettings();
    expect(settings.llm.baseUrl).toBe("https://custom.example.com");
    expect(settings.llm.apiKey).toBe("sk-test");
    expect(settings.targetLanguage).toBe("English");
  });

  it("migrates legacy localStorage config when backend apiKey is empty", async () => {
    localStorage.setItem(
      "standardread-llm-config",
      JSON.stringify({ apiKey: "legacy-key", model: "legacy-model" })
    );
    let savedSettings: any = null;
    mockTauriInvoke({
      load_settings: () => ({ ...DEFAULT_SETTINGS }),
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

  it("does not migrate legacy config when backend already has apiKey", async () => {
    localStorage.setItem("standardread-llm-config", JSON.stringify({ apiKey: "legacy-key" }));
    let savedSettings: any = "not-called";
    mockTauriInvoke({
      load_settings: () => ({
        llm: { baseUrl: "https://api.example.com", apiKey: "backend-key", model: "gpt-4" },
        targetLanguage: "中文",
      }),
      save_settings: (args) => {
        savedSettings = args.settings;
        return null;
      },
    });
    const { loadSettings } = await import("../services/settings");
    const settings = await loadSettings();
    expect(settings.llm.apiKey).toBe("backend-key");
    expect(savedSettings).toBe("not-called");
  });

  it("falls back to defaults and legacy config when backend fails", async () => {
    localStorage.setItem("standardread-llm-config", JSON.stringify({ apiKey: "legacy-key" }));
    mockTauriInvoke({
      load_settings: () => Promise.reject(new Error("backend error")),
    });
    const { loadSettings } = await import("../services/settings");
    const settings = await loadSettings();
    expect(settings.llm.apiKey).toBe("legacy-key");
    expect(settings.llm.model).toBe("gpt-4o-mini");
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
    const settings = {
      llm: { baseUrl: "x", apiKey: "y", model: "z" },
      targetLanguage: "中文",
    };
    await saveSettings(settings);
    expect(saved).toEqual(settings);
  });
});
