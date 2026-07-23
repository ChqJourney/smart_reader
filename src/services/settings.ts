import { invoke } from "@tauri-apps/api/core";
import { error } from "./logs";

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface SystemPrompts {
  translate: string;
  explain: string;
}

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export type ThinkingMode = "enabled" | "disabled" | "auto";

export type PlatformId =
  | "deepseek"
  | "kimi"
  | "bailian"
  | "glm"
  | "volcengine"
  | "openrouter"
  | "openai"
  | "xiaomimimo"
  | "custom";

export interface AppSettings {
  llm: LlmConfig;
  /** Platform preset ID for model dropdown population */
  platformId: PlatformId;
  /** Thinking mode preference */
  thinking: ThinkingMode;
  /** Max tool call rounds (0 = use default 20) */
  maxToolRounds: number;
  /** Whether the agent can use PDF tools during interpretation */
  agentToolsEnabled: boolean;
  targetLanguage: string;
  systemPrompts: SystemPrompts;
  hoverTranslate: boolean;
  logLevel: LogLevel;
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
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    model: "deepseek-v4-flash",
  },
  platformId: "deepseek",
  thinking: "auto",
  maxToolRounds: 20,
  agentToolsEnabled: true,
  targetLanguage: "中文",
  systemPrompts: DEFAULT_SYSTEM_PROMPTS,
  hoverTranslate: false,
  logLevel: "warn",
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
  const platformId = (value.platformId ??
    DEFAULT_SETTINGS.platformId) as PlatformId;
  return {
    llm: {
      baseUrl: value.llm?.baseUrl ?? DEFAULT_SETTINGS.llm.baseUrl,
      apiKey: value.llm?.apiKey ?? DEFAULT_SETTINGS.llm.apiKey,
      model: value.llm?.model ?? DEFAULT_SETTINGS.llm.model,
    },
    platformId,
    thinking: (value.thinking ?? DEFAULT_SETTINGS.thinking) as ThinkingMode,
    maxToolRounds: value.maxToolRounds ?? DEFAULT_SETTINGS.maxToolRounds,
    agentToolsEnabled:
      value.agentToolsEnabled ?? DEFAULT_SETTINGS.agentToolsEnabled,
    targetLanguage: value.targetLanguage ?? DEFAULT_SETTINGS.targetLanguage,
    systemPrompts: {
      translate:
        value.systemPrompts?.translate ?? DEFAULT_SYSTEM_PROMPTS.translate,
      explain: value.systemPrompts?.explain ?? DEFAULT_SYSTEM_PROMPTS.explain,
    },
    hoverTranslate: value.hoverTranslate ?? DEFAULT_SETTINGS.hoverTranslate,
    logLevel: isLogLevel(value.logLevel)
      ? value.logLevel
      : DEFAULT_SETTINGS.logLevel,
  };
}

function isLogLevel(value: unknown): value is LogLevel {
  return (
    typeof value === "string" &&
    ["trace", "debug", "info", "warn", "error"].includes(value)
  );
}

async function mergeWithLegacy(base: AppSettings): Promise<AppSettings> {
  const legacy = loadLegacySettings();
  if (!legacy) return base;
  const merged: AppSettings = {
    ...base,
    llm: { ...base.llm, ...legacy },
  };
  try {
    await saveSettings(merged);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Keep the legacy localStorage key if the backend save failed so the
    // API key is not lost; it will be retried on next load.
  }
  return merged;
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const backend = await invoke<AppSettings>("load_settings");
    if (isValidSettings(backend)) {
      const normalized = normalizeSettings(backend);
      // Defense in depth: the backend already masks the API key, but never let
      // a plaintext key from any source leak into the rest of the frontend.
      normalized.llm.apiKey = "";
      // Only migrate a legacy localStorage key if no key is already configured
      // in secure storage.
      const hasBackendKey = await checkApiKey(normalized.platformId);
      if (!hasBackendKey) {
        return await mergeWithLegacy(normalized);
      }
      return normalized;
    }
  } catch (err) {
    error(`Failed to load settings: ${err}`);
  }
  return await mergeWithLegacy({ ...DEFAULT_SETTINGS });
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
    error(`Failed to save settings: ${err}`);
    throw err;
  }
}

/**
 * Check whether an API key is configured for a specific platform.
 * Returns a boolean; the actual key never leaves the backend.
 */
export async function checkApiKey(platformId: string): Promise<boolean> {
  try {
    return await invoke<boolean>("check_api_key", { platformId });
  } catch (err) {
    error(`Failed to check API key for ${platformId}: ${err}`);
    return false;
  }
}

/**
 * Delete the stored API key for a specific platform.
 */
export async function deleteApiKey(platformId: string): Promise<void> {
  try {
    await invoke("delete_api_key", { platformId });
  } catch (err) {
    error(`Failed to delete API key for ${platformId}: ${err}`);
  }
}

export async function openDefaultAppsSettings(): Promise<void> {
  await invoke("open_default_apps_settings");
}

export { DEFAULT_SETTINGS, DEFAULT_SYSTEM_PROMPTS };
