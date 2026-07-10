import { invoke } from "@tauri-apps/api/core";

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AppSettings {
  llm: LlmConfig;
  targetLanguage: string;
}

const LEGACY_STORAGE_KEY = "standardread-llm-config";

const DEFAULT_SETTINGS: AppSettings = {
  llm: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
  },
  targetLanguage: "中文",
};

function isValidSettings(value: unknown): value is AppSettings {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AppSettings).llm === "object" &&
    (value as AppSettings).llm !== null &&
    typeof (value as AppSettings).llm.apiKey === "string" &&
    typeof (value as AppSettings).targetLanguage === "string"
  );
}

function mergeWithLegacy(base: AppSettings): AppSettings {
  const legacy = loadLegacySettings();
  if (!legacy) return base;
  const merged: AppSettings = {
    ...base,
    llm: { ...base.llm, ...legacy },
  };
  saveSettings(merged).catch(() => {
    // ignore background save errors
  });
  localStorage.removeItem(LEGACY_STORAGE_KEY);
  return merged;
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const backend = await invoke<AppSettings>("load_settings");
    if (isValidSettings(backend)) {
      if (!backend.llm.apiKey) {
        return mergeWithLegacy(backend);
      }
      return backend;
    }
  } catch (err) {
    console.error("Failed to load settings:", err);
  }
  return mergeWithLegacy({ ...DEFAULT_SETTINGS });
}

function loadLegacySettings(): Partial<LlmConfig> | null {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<LlmConfig>;
  } catch {
    return null;
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  try {
    await invoke("save_settings", { settings });
  } catch (err) {
    console.error("Failed to save settings:", err);
  }
}

export { DEFAULT_SETTINGS };
