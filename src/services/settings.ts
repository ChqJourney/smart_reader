import { invoke } from "@tauri-apps/api/core";

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface SystemPrompts {
  translate: string;
  explain: string;
}

export interface AppSettings {
  llm: LlmConfig;
  targetLanguage: string;
  systemPrompts: SystemPrompts;
}

const LEGACY_STORAGE_KEY = "standardread-llm-config";

const DEFAULT_SYSTEM_PROMPTS: SystemPrompts = {
  translate:
    "你是一位检测认证行业标准文档翻译助手，擅长把英文标准条款准确翻译成{targetLanguage}。请保持专业术语准确，首次出现关键术语时保留原文，不要编造片段中未提及的条款或页码。",
  explain:
    "你是一位检测认证行业标准文档阅读助手，擅长把复杂的英文标准条款解释得清晰易懂。请基于用户提供的文档片段用{targetLanguage}回答，不要编造片段中未提及的条款或页码。",
};

const DEFAULT_SETTINGS: AppSettings = {
  llm: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
  },
  targetLanguage: "中文",
  systemPrompts: DEFAULT_SYSTEM_PROMPTS,
};

function isValidSettings(value: unknown): value is Partial<AppSettings> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AppSettings).llm === "object" &&
    (value as AppSettings).llm !== null &&
    typeof (value as AppSettings).llm.apiKey === "string" &&
    typeof (value as AppSettings).targetLanguage === "string"
  );
}

function normalizeSettings(value: Partial<AppSettings>): AppSettings {
  return {
    llm: {
      baseUrl: value.llm?.baseUrl ?? DEFAULT_SETTINGS.llm.baseUrl,
      apiKey: value.llm?.apiKey ?? DEFAULT_SETTINGS.llm.apiKey,
      model: value.llm?.model ?? DEFAULT_SETTINGS.llm.model,
    },
    targetLanguage: value.targetLanguage ?? DEFAULT_SETTINGS.targetLanguage,
    systemPrompts: {
      translate:
        value.systemPrompts?.translate ?? DEFAULT_SYSTEM_PROMPTS.translate,
      explain:
        value.systemPrompts?.explain ?? DEFAULT_SYSTEM_PROMPTS.explain,
    },
  };
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
      const normalized = normalizeSettings(backend);
      if (!normalized.llm.apiKey) {
        return mergeWithLegacy(normalized);
      }
      return normalized;
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

export { DEFAULT_SETTINGS, DEFAULT_SYSTEM_PROMPTS };
