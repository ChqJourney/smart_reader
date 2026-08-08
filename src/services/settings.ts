import { invoke } from "@tauri-apps/api/core";
import { error } from "./logs";
import { PLATFORM_PRESETS } from "../data/platformPresets";
import type { PlatformId } from "../data/platformPresets";
import type { SessionSortMode } from "./sessions";

// PlatformId 统一定义在 data/platformPresets.ts，这里 re-export 保持既有 import 路径可用。
export type { PlatformId };

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

export type ThemeMode = "system" | "light" | "dark";

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
  /** 条款链接悬停预览（画中画）开关 */
  linkPreviewEnabled: boolean;
  logLevel: LogLevel;
  /** Whether the right-side AI chat panel is visible. */
  rightPanelVisible: boolean;
  /** Persisted width of the right-side panel in pixels. 0 means "use default fraction". */
  rightPanelWidth: number;
  /** 解读记录列表排序方式 */
  sessionSortMode: SessionSortMode;
  /** 界面主题：跟随系统 / 浅色 / 深色 */
  theme: ThemeMode;
}

const LEGACY_STORAGE_KEY = "standardread-llm-config";
const LEGACY_RIGHT_PANEL_LAYOUT_KEY = "pdfAgent.rightPanelLayout";

interface LegacyRightPanelLayout {
  visible?: unknown;
  width?: unknown;
}

function loadLegacyRightPanelLayout(): Partial<
  Pick<AppSettings, "rightPanelVisible" | "rightPanelWidth">
> | null {
  try {
    const raw = localStorage.getItem(LEGACY_RIGHT_PANEL_LAYOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LegacyRightPanelLayout;
    const result: Partial<
      Pick<AppSettings, "rightPanelVisible" | "rightPanelWidth">
    > = {};
    if (typeof parsed.visible === "boolean") {
      result.rightPanelVisible = parsed.visible;
    }
    if (typeof parsed.width === "number") {
      result.rightPanelWidth = parsed.width;
    }
    return result;
  } catch {
    return null;
  }
}

function clearLegacyRightPanelLayout(): void {
  try {
    localStorage.removeItem(LEGACY_RIGHT_PANEL_LAYOUT_KEY);
  } catch {
    // ignore
  }
}

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
  agentToolsEnabled: false,
  targetLanguage: "中文",
  systemPrompts: DEFAULT_SYSTEM_PROMPTS,
  hoverTranslate: false,
  linkPreviewEnabled: false,
  logLevel: "warn",
  rightPanelVisible: true,
  rightPanelWidth: 0,
  sessionSortMode: "recentActivity",
  theme: "system",
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
    linkPreviewEnabled:
      value.linkPreviewEnabled ?? DEFAULT_SETTINGS.linkPreviewEnabled,
    logLevel: isLogLevel(value.logLevel)
      ? value.logLevel
      : DEFAULT_SETTINGS.logLevel,
    rightPanelVisible:
      value.rightPanelVisible ?? DEFAULT_SETTINGS.rightPanelVisible,
    rightPanelWidth: value.rightPanelWidth ?? DEFAULT_SETTINGS.rightPanelWidth,
    sessionSortMode: isSessionSortMode(value.sessionSortMode)
      ? value.sessionSortMode
      : DEFAULT_SETTINGS.sessionSortMode,
    theme: isThemeMode(value.theme) ? value.theme : DEFAULT_SETTINGS.theme,
  };
}

function isThemeMode(value: unknown): value is ThemeMode {
  return (
    typeof value === "string" && ["system", "light", "dark"].includes(value)
  );
}

function isSessionSortMode(value: unknown): value is SessionSortMode {
  return (
    typeof value === "string" &&
    ["recentActivity", "createdAt", "page"].includes(value)
  );
}

function isLogLevel(value: unknown): value is LogLevel {
  return (
    typeof value === "string" &&
    ["trace", "debug", "info", "warn", "error"].includes(value)
  );
}

/**
 * Ensure platformId and model are consistent with the current platform preset.
 * - Unknown platform ids fall back to the default platform.
 * - Models that no longer exist in the preset (deprecated ids, cross-platform
 *   leftovers after an upgrade) are reset to the platform's default model and
 *   base URL so the settings UI and LLM calls stay consistent.
 * - Custom platforms are left untouched.
 */
function migrateModelForPlatform(settings: AppSettings): AppSettings {
  let platformId = settings.platformId;
  if (!PLATFORM_PRESETS[platformId]) {
    platformId = DEFAULT_SETTINGS.platformId;
  }

  const preset = PLATFORM_PRESETS[platformId];
  if (!preset || preset.models.length === 0) {
    if (platformId === settings.platformId) {
      return settings;
    }
    return { ...settings, platformId };
  }

  const modelExists = preset.models.some((m) => m.id === settings.llm.model);
  if (modelExists && platformId === settings.platformId) {
    return settings;
  }

  return {
    ...settings,
    platformId,
    llm: {
      ...settings.llm,
      baseUrl: preset.baseUrl,
      model: preset.defaultModelId,
    },
  };
}

async function mergeWithLegacy(base: AppSettings): Promise<AppSettings> {
  const legacy = loadLegacySettings();
  if (!legacy) return migrateModelForPlatform(base);
  const merged: AppSettings = {
    ...base,
    llm: { ...base.llm, ...legacy },
  };
  const migrated = migrateModelForPlatform(merged);
  try {
    await saveSettings(migrated);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Keep the legacy localStorage key if the backend save failed so the
    // API key is not lost; it will be retried on next load.
  }
  return migrated;
}

export async function loadSettings(): Promise<AppSettings> {
  const layoutLegacy = loadLegacyRightPanelLayout();

  try {
    const backend = await invoke<AppSettings>("load_settings");
    if (isValidSettings(backend)) {
      let normalized = normalizeSettings(backend);
      if (layoutLegacy) {
        normalized = { ...normalized, ...layoutLegacy };
      }
      // Defense in depth: the backend already masks the API key, but never let
      // a plaintext key from any source leak into the rest of the frontend.
      normalized.llm.apiKey = "";
      // Only migrate a legacy localStorage key if no key is already configured
      // in secure storage.
      const hasBackendKey = await checkApiKey(normalized.platformId);
      const merged = hasBackendKey
        ? normalized
        : await mergeWithLegacy(normalized);
      const final = migrateModelForPlatform(merged);
      const needsMigrationSave = final.llm.model !== merged.llm.model;

      if (needsMigrationSave || layoutLegacy) {
        try {
          await saveSettings(final);
          if (layoutLegacy) {
            clearLegacyRightPanelLayout();
          }
        } catch {
          // Keep the legacy localStorage key if the layout migration failed so
          // the layout is not lost. If only the model id was migrated, the
          // in-memory settings are already consistent and will be retried when
          // the user opens the settings modal.
        }
      }
      return final;
    }
  } catch (err) {
    error(`Failed to load settings: ${err}`);
  }

  const fallback = { ...DEFAULT_SETTINGS, ...(layoutLegacy ?? {}) };
  return await mergeWithLegacy(fallback);
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
