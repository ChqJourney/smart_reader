import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import Icon from "./Icon";
import {
  AppSettings,
  DEFAULT_SETTINGS,
  DEFAULT_SYSTEM_PROMPTS,
  LogLevel,
  SystemPrompts,
  ThinkingMode,
  PlatformId,
  openDefaultAppsSettings,
  saveSettings,
  getApiKey,
} from "../services/settings";
import {
  PLATFORM_LIST,
  PLATFORM_PRESETS,
  findModel,
} from "../data/platformPresets";
import { testConnection } from "../services/llm";
import type { LlmError } from "../types/llm";
import { useDictionaryStatus } from "../hooks/useDictionaryStatus";
import { useModal } from "../hooks/useModal";
import { error, openLogsDir } from "../services/logs";
import {
  checkUpdateInfo,
  installUpdate,
  UpdateInfo,
} from "../services/updater";
import "./CustomInterpretModal.css";
import "./SettingsModal.css";

type PromptTab = "translate" | "explain";
type SettingsPage = "model" | "feature" | "system" | "about";
type UpdateState =
  | "idle"
  | "checking"
  | "noUpdate"
  | "available"
  | "installing"
  | "noPlatformUpdate"
  | "error";

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = units[0];
  for (let i = 1; i < units.length; i++) {
    if (size < 1024) break;
    size /= 1024;
    unit = units[i];
  }
  return `${size.toFixed(1)} ${unit}`;
}

interface SettingsModalProps {
  open: boolean;
  initialSettings: AppSettings;
  onClose: () => void;
  onSave: (settings: AppSettings) => void;
}

const PAGE_LIST: SettingsPage[] = ["model", "feature", "system", "about"];

function isNoPlatformUpdateError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("were found in the response") &&
    message.includes("platforms") &&
    message.includes("fallback platforms")
  );
}

export default function SettingsModal({
  open,
  initialSettings,
  onClose,
  onSave,
}: SettingsModalProps) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [activePromptTab, setActivePromptTab] =
    useState<PromptTab>("translate");
  const [activePage, setActivePage] = useState<SettingsPage>("model");
  const [showDownloadConfirm, setShowDownloadConfirm] = useState(false);
  const [downloadPending, setDownloadPending] = useState(false);
  const [version, setVersion] = useState<string>("0.1.0");
  const [licenseText, setLicenseText] = useState<string | null>(null);
  const [currentPlatform, setCurrentPlatform] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState>("idle");
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<UpdateInfo | null>(null);
  const dictionaryStatus = useDictionaryStatus();
  const [testState, setTestState] = useState<
    "idle" | "testing" | "success" | "error"
  >("idle");
  const [testResult, setTestResult] = useState<string | null>(null);
  /** Per-platform API key cache (in-memory, not persisted). Keyed by platformId. */
  const apiKeysCacheRef = useRef<Record<string, string>>({});
  /** Tracks which platforms have an API key configured in keyring. */
  const [platformsWithKey, setPlatformsWithKey] = useState<Set<string>>(
    new Set()
  );

  useEffect(() => {
    setSettings(initialSettings);
    setActivePromptTab("translate");
    setActivePage("model");
    setShowDownloadConfirm(false);
    setDownloadPending(false);
    setUpdateState("idle");
    setUpdateVersion(null);
    setUpdateError(null);
    setPendingUpdate(null);
    setTestState("idle");
    setTestResult(null);
    // Initialize API key cache with the current platform's key
    apiKeysCacheRef.current = {
      [initialSettings.platformId]: initialSettings.llm.apiKey,
    };
  }, [initialSettings, open]);

  // Check which platforms have an API key configured in keyring
  useEffect(() => {
    if (!open) return;
    const platformIds = PLATFORM_LIST.filter((p) => p.id !== "custom").map(
      (p) => p.id
    );
    let cancelled = false;
    Promise.all(
      platformIds.map(async (id) => {
        const key = await getApiKey(id);
        return { id, hasKey: !!key };
      })
    ).then((results) => {
      if (cancelled) return;
      const set = new Set<string>();
      // Always include the current platform if it has a key in settings
      if (settings.llm.apiKey) {
        set.add(settings.platformId);
      }
      results.forEach(({ id, hasKey }) => {
        if (hasKey) set.add(id);
      });
      setPlatformsWithKey(set);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    getVersion()
      .then(setVersion)
      .catch(() => setVersion("0.1.0"));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setCurrentPlatform(navigator.platform);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/LICENSE.txt")
      .then((res) => {
        if (!res.ok) throw new Error("failed");
        return res.text();
      })
      .then((text) => {
        if (!cancelled) setLicenseText(text);
      })
      .catch(() => {
        if (!cancelled) setLicenseText(t("settings.licenseError"));
      });
    return () => {
      cancelled = true;
    };
  }, [open, t]);

  useEffect(() => {
    if (
      open &&
      downloadPending &&
      dictionaryStatus.progress?.status === "done"
    ) {
      setSettings((prev) => ({ ...prev, hoverTranslate: true }));
      setShowDownloadConfirm(false);
      setDownloadPending(false);
    }
  }, [open, downloadPending, dictionaryStatus.progress]);

  const handleHoverTranslateToggle = useCallback(
    async (checked: boolean) => {
      if (!checked) {
        setSettings((prev) => ({ ...prev, hoverTranslate: false }));
        return;
      }

      if (dictionaryStatus.status?.exists) {
        setSettings((prev) => ({ ...prev, hoverTranslate: true }));
        return;
      }

      setShowDownloadConfirm(true);
    },
    [dictionaryStatus.status]
  );

  const handleConfirmDownload = useCallback(async () => {
    setShowDownloadConfirm(false);
    setDownloadPending(true);
    await dictionaryStatus.startDownload();
  }, [dictionaryStatus]);

  const handleCancelDownload = useCallback(() => {
    setShowDownloadConfirm(false);
    setDownloadPending(false);
  }, []);

  const handleOpenLogs = useCallback(async () => {
    try {
      await openLogsDir();
    } catch (e) {
      error(`Failed to open logs directory: ${e}`);
    }
  }, []);

  const handleOpenDefaultApps = useCallback(async () => {
    try {
      await openDefaultAppsSettings();
    } catch (e) {
      error(`Failed to open default apps settings: ${e}`);
    }
  }, []);

  const handleCheckUpdate = useCallback(async () => {
    setUpdateState("checking");
    setUpdateError(null);
    try {
      const result = await checkUpdateInfo();
      if (result.available && result.update) {
        setUpdateVersion(result.version ?? null);
        setPendingUpdate(result.update);
        setUpdateState("available");
      } else {
        setUpdateState("noUpdate");
      }
    } catch (err) {
      if (isNoPlatformUpdateError(err)) {
        setUpdateState("noPlatformUpdate");
      } else {
        setUpdateState("error");
        setUpdateError(err instanceof Error ? err.message : String(err));
      }
    }
  }, []);

  const handleUpgrade = useCallback(async () => {
    if (!pendingUpdate) return;
    setUpdateState("installing");
    setUpdateError(null);
    try {
      await installUpdate(pendingUpdate);
    } catch (err) {
      setUpdateState("error");
      setUpdateError(err instanceof Error ? err.message : String(err));
    }
  }, [pendingUpdate]);

  // Stabilize onClose so useModal's useEffect doesn't re-run on every render
  // (which would steal focus from <select> dropdowns).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const stableOnClose = useCallback(() => onCloseRef.current(), []);
  const { contentRef } = useModal({ open, onClose: stableOnClose });

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(settings);
  };

  const updateLlm = (patch: Partial<AppSettings["llm"]>) => {
    setSettings((s) => ({ ...s, llm: { ...s.llm, ...patch } }));
  };

  /** When platform changes, auto-fill baseUrl/model and load that platform's API key. */
  const handlePlatformChange = async (platformId: PlatformId) => {
    // Cache the current platform's API key before switching
    apiKeysCacheRef.current[settings.platformId] = settings.llm.apiKey;

    const preset = PLATFORM_PRESETS[platformId];
    // Try in-memory cache first, then fall back to keyring
    let cachedKey = apiKeysCacheRef.current[platformId];
    if (cachedKey === undefined) {
      cachedKey = (await getApiKey(platformId)) ?? "";
      apiKeysCacheRef.current[platformId] = cachedKey;
    }

    if (platformId === "custom") {
      setSettings((s) => ({
        ...s,
        platformId,
        llm: { ...s.llm, apiKey: cachedKey ?? "" },
      }));
      return;
    }
    setSettings((s) => ({
      ...s,
      platformId,
      llm: {
        ...s.llm,
        baseUrl: preset.baseUrl,
        model: preset.defaultModelId,
        apiKey: cachedKey ?? "",
      },
    }));
  };

  /** Test the LLM connection with current (saved) settings. */
  const handleTestConnection = async () => {
    // Save settings directly to backend (without closing the modal)
    try {
      await saveSettings(settings);
    } catch {
      // ignore save errors — test will still use whatever is on disk
    }
    setTestState("testing");
    setTestResult(null);
    try {
      const result = await testConnection();
      if (result.success) {
        setTestState("success");
        setTestResult(
          t("settings.testConnectionSuccess", {
            model: result.model,
            defaultValue: `连接成功，模型：${result.model}`,
          })
        );
      } else if (result.error) {
        setTestState("error");
        setTestResult(formatLlmError(result.error));
      } else {
        setTestState("error");
        setTestResult(
          t("settings.testConnectionUnknown", {
            defaultValue: "连接失败，未知错误",
          })
        );
      }
    } catch (err) {
      setTestState("error");
      setTestResult(String(err));
    }
  };

  const formatLlmError = (err: LlmError): string => {
    switch (err.kind) {
      case "network":
        return t("settings.errorNetwork", { defaultValue: err.detail });
      case "auth":
        return t("settings.errorAuth", { defaultValue: err.detail });
      case "modelNotFound":
        return t("settings.errorModelNotFound", {
          model: err.model,
          defaultValue: err.detail,
        });
      case "rateLimit":
        return t("settings.errorRateLimit", { defaultValue: err.detail });
      case "contextLengthExceeded":
        return t("settings.errorContextLength", { defaultValue: err.detail });
      case "serverError":
        return t("settings.errorServer", {
          status: err.status,
          defaultValue: err.detail,
        });
      default:
        return "detail" in err
          ? (err as { detail: string }).detail
          : "body" in err
            ? (err as { body: string }).body
            : JSON.stringify(err);
    }
  };

  const updateSystemPrompt = (key: keyof SystemPrompts, value: string) => {
    setSettings((s) => ({
      ...s,
      systemPrompts: { ...s.systemPrompts, [key]: value },
    }));
  };

  const updateLogLevel = (value: LogLevel) => {
    setSettings((s) => ({ ...s, logLevel: value }));
  };

  const resetPrompt = (key: keyof SystemPrompts) => {
    updateSystemPrompt(key, DEFAULT_SYSTEM_PROMPTS[key]);
  };

  const resetAll = () => {
    setSettings(DEFAULT_SETTINGS);
  };

  const currentPrompt = settings.systemPrompts[activePromptTab];
  const currentDefault = DEFAULT_SYSTEM_PROMPTS[activePromptTab];

  const downloadProgressPercent =
    dictionaryStatus.progress && dictionaryStatus.progress.total > 0
      ? Math.min(
          100,
          Math.round(
            (dictionaryStatus.progress.downloaded /
              dictionaryStatus.progress.total) *
              100
          )
        )
      : 0;

  const progressTotalKnown =
    dictionaryStatus.progress !== null && dictionaryStatus.progress.total > 0;

  const progressText = (() => {
    if (dictionaryStatus.progress?.message) {
      return dictionaryStatus.progress.message;
    }
    if (progressTotalKnown) {
      return t("settings.downloadingProgress", {
        percent: downloadProgressPercent,
      });
    }
    const downloaded = dictionaryStatus.progress?.downloaded ?? 0;
    return t("settings.downloadingProgressUnknown", {
      size: formatBytes(downloaded),
    });
  })();

  const promptTabLabel =
    activePromptTab === "translate"
      ? t("action.translate")
      : t("action.explain");

  return (
    <div className="modal-overlay">
      <div
        ref={contentRef}
        className="modal-content settings-modal-content"
        role="dialog"
        aria-label={t("settings.title")}
      >
        <div className="settings-modal-header">
          <button
            type="button"
            className="settings-modal-close"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <Icon name="close" size={18} />
          </button>
          <h3>{t("settings.title")}</h3>
          <p className="modal-hint">{t("settings.description")}</p>
        </div>

        <form
          id="settings-form"
          className="settings-modal-body"
          onSubmit={handleSubmit}
        >
          <div className="settings-modal-layout">
            <nav
              className="settings-modal-sidebar"
              aria-label={t("settings.title")}
            >
              {PAGE_LIST.map((page) => (
                <button
                  key={page}
                  type="button"
                  className={activePage === page ? "active" : ""}
                  onClick={() => setActivePage(page)}
                  aria-current={activePage === page ? "page" : undefined}
                >
                  {t(`settings.pages.${page}`)}
                </button>
              ))}
            </nav>

            <div className="settings-modal-page-content">
              {activePage === "model" && (
                <section className="settings-section">
                  <div className="settings-section-title">
                    {t("settings.llmApi")}
                  </div>
                  <div className="settings-section-hint">
                    {t("settings.llmApiHint")}
                  </div>

                  {/* Platform selector */}
                  <label className="settings-field">
                    {t("settings.platform", { defaultValue: "平台" })}
                    <select
                      value={settings.platformId}
                      onChange={(e) =>
                        handlePlatformChange(e.target.value as PlatformId)
                      }
                    >
                      {PLATFORM_LIST.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                          {platformsWithKey.has(p.id)
                            ? t("settings.apiKeyConfigured", {
                                defaultValue: "（已配置）",
                              })
                            : ""}
                        </option>
                      ))}
                    </select>
                  </label>

                  {/* Model dropdown (from platform preset) or free text (custom) */}
                  <label className="settings-field">
                    {t("settings.model")}
                    {settings.platformId === "custom" ||
                    PLATFORM_PRESETS[settings.platformId].models.length ===
                      0 ? (
                      <input
                        type="text"
                        value={settings.llm.model}
                        onChange={(e) => updateLlm({ model: e.target.value })}
                        placeholder="model-name"
                      />
                    ) : (
                      <select
                        value={settings.llm.model}
                        onChange={(e) => updateLlm({ model: e.target.value })}
                      >
                        {PLATFORM_PRESETS[settings.platformId].models.map(
                          (m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                            </option>
                          )
                        )}
                      </select>
                    )}
                  </label>

                  {/* Base URL (read-only for known platforms, editable for custom) */}
                  <label className="settings-field">
                    {t("settings.apiBaseUrl")}
                    {settings.platformId === "custom" ? (
                      <input
                        type="text"
                        value={settings.llm.baseUrl}
                        onChange={(e) => updateLlm({ baseUrl: e.target.value })}
                        placeholder="https://api.example.com/v1"
                      />
                    ) : (
                      <input
                        type="text"
                        value={settings.llm.baseUrl}
                        onChange={(e) => updateLlm({ baseUrl: e.target.value })}
                        readOnly
                        className="settings-readonly-input"
                      />
                    )}
                  </label>

                  {/* API Key */}
                  <label className="settings-field">
                    {t("settings.apiKey")}
                    {settings.llm.apiKey && (
                      <span className="settings-apikey-configured">
                        {t("settings.apiKeyConfigured", {
                          defaultValue: "已配置",
                        })}
                      </span>
                    )}
                    <input
                      type="password"
                      value={settings.llm.apiKey}
                      onChange={(e) => updateLlm({ apiKey: e.target.value })}
                      placeholder="sk-..."
                    />
                    {PLATFORM_PRESETS[settings.platformId].apiKeyHelpUrl && (
                      <a
                        href={
                          PLATFORM_PRESETS[settings.platformId].apiKeyHelpUrl
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        className="settings-help-link"
                      >
                        {t("settings.howToGetApiKey", {
                          defaultValue: "如何获取 API Key?",
                        })}
                      </a>
                    )}
                    {PLATFORM_PRESETS[settings.platformId].apiKeyHint && (
                      <p className="settings-field-hint">
                        {PLATFORM_PRESETS[settings.platformId].apiKeyHint}
                      </p>
                    )}
                  </label>

                  {/* Test connection button */}
                  <div className="settings-form-row">
                    <button
                      type="button"
                      className="icon-btn primary"
                      onClick={handleTestConnection}
                      disabled={testState === "testing"}
                    >
                      {testState === "testing"
                        ? t("settings.testing", { defaultValue: "测试中..." })
                        : t("settings.testConnection", {
                            defaultValue: "测试连接",
                          })}
                    </button>
                    {testState === "success" && (
                      <span className="settings-status-ok">{testResult}</span>
                    )}
                    {testState === "error" && (
                      <span className="settings-status-error">
                        {testResult}
                      </span>
                    )}
                  </div>

                  {/* Thinking mode toggle */}
                  {(() => {
                    const model = findModel(
                      settings.platformId,
                      settings.llm.model
                    );
                    const supportsThinking = model?.supportsThinking ?? false;
                    if (!supportsThinking && settings.platformId !== "custom") {
                      return null;
                    }
                    return (
                      <label className="settings-field">
                        {t("settings.thinkingMode", {
                          defaultValue: "思考模式",
                        })}
                        <select
                          value={settings.thinking}
                          onChange={(e) =>
                            setSettings((s) => ({
                              ...s,
                              thinking: e.target.value as ThinkingMode,
                            }))
                          }
                        >
                          <option value="auto">
                            {t("settings.thinkingAuto", {
                              defaultValue: "自动（模型默认）",
                            })}
                          </option>
                          <option value="enabled">
                            {t("settings.thinkingEnabled", {
                              defaultValue: "开启（推理更深入，更慢）",
                            })}
                          </option>
                          <option value="disabled">
                            {t("settings.thinkingDisabled", {
                              defaultValue: "关闭（快速响应）",
                            })}
                          </option>
                        </select>
                      </label>
                    );
                  })()}

                  {/* Max tool rounds */}
                  <label className="settings-field">
                    {t("settings.maxToolRounds", {
                      defaultValue: "最大工具调用次数",
                    })}
                    <input
                      type="number"
                      min={0}
                      max={20}
                      value={settings.maxToolRounds}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          maxToolRounds: Math.max(
                            0,
                            Math.min(20, parseInt(e.target.value) || 0)
                          ),
                        }))
                      }
                    />
                    <p className="settings-field-hint">
                      {t("settings.maxToolRoundsHint", {
                        defaultValue:
                          "0 表示使用默认值 5。AI 读取 PDF 内容时的最大调用轮次。",
                      })}
                    </p>
                  </label>
                </section>
              )}

              {activePage === "feature" && (
                <>
                  <section className="settings-section">
                    <div className="settings-section-title">
                      {t("settings.outputLanguage")}
                    </div>
                    <div className="settings-section-hint">
                      {t("settings.outputLanguageHint")}
                    </div>
                    <div className="settings-form-row">
                      <label className="settings-field">
                        {t("settings.targetLanguage")}
                        <input
                          type="text"
                          value={settings.targetLanguage}
                          onChange={(e) =>
                            setSettings((s) => ({
                              ...s,
                              targetLanguage: e.target.value,
                            }))
                          }
                          placeholder={t("settings.targetLanguagePlaceholder")}
                        />
                      </label>
                    </div>
                  </section>

                  <section className="settings-section">
                    <div className="settings-section-title">
                      {t("settings.hoverTranslate")}
                    </div>
                    <div className="settings-section-hint">
                      {t("settings.hoverTranslateHint")}
                    </div>
                    <label className="settings-toggle">
                      <input
                        type="checkbox"
                        checked={settings.hoverTranslate}
                        onChange={(e) =>
                          handleHoverTranslateToggle(e.target.checked)
                        }
                        disabled={dictionaryStatus.downloading}
                      />
                      {t("settings.enableHoverTranslate")}
                    </label>
                    {settings.hoverTranslate &&
                      dictionaryStatus.status?.exists && (
                        <p className="settings-status-ok">
                          {t("settings.dictionaryReady")}
                        </p>
                      )}
                    {dictionaryStatus.downloading && (
                      <div className="settings-download-progress">
                        <div
                          className={`settings-progress-bar${
                            progressTotalKnown ? "" : " indeterminate"
                          }`}
                        >
                          <div
                            className="settings-progress-fill"
                            style={{ width: `${downloadProgressPercent}%` }}
                          />
                        </div>
                        <span className="settings-progress-text">
                          {progressText}
                        </span>
                      </div>
                    )}
                    {dictionaryStatus.error && (
                      <p className="settings-status-error">
                        {dictionaryStatus.error}
                      </p>
                    )}
                  </section>

                  <section className="settings-section">
                    <div className="settings-section-title">
                      {t("settings.systemPrompts")}
                    </div>
                    <div className="settings-section-hint">
                      {t("settings.systemPromptsHint")}
                    </div>
                    <div className="settings-prompt-tabs">
                      <button
                        type="button"
                        className={
                          activePromptTab === "translate" ? "active" : ""
                        }
                        onClick={() => setActivePromptTab("translate")}
                      >
                        {t("action.translate")}
                      </button>
                      <button
                        type="button"
                        className={
                          activePromptTab === "explain" ? "active" : ""
                        }
                        onClick={() => setActivePromptTab("explain")}
                      >
                        {t("action.explain")}
                      </button>
                    </div>
                    <div className="settings-prompt-area">
                      <textarea
                        value={currentPrompt}
                        onChange={(e) =>
                          updateSystemPrompt(activePromptTab, e.target.value)
                        }
                        rows={5}
                        aria-label={t("settings.promptAriaLabel", {
                          action: promptTabLabel,
                        })}
                      />
                      <div className="settings-prompt-meta">
                        <span>
                          {currentPrompt.length} {t("settings.characters")}
                        </span>
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() => resetPrompt(activePromptTab)}
                          disabled={currentPrompt === currentDefault}
                        >
                          {t("common.reset")}
                        </button>
                      </div>
                    </div>
                  </section>
                </>
              )}

              {activePage === "system" && (
                <>
                  <section className="settings-section">
                    <div className="settings-section-title">
                      {t("settings.logLevel")}
                    </div>
                    <div className="settings-section-hint">
                      {t("settings.logLevelHint")}
                    </div>
                    <div className="settings-field">
                      <select
                        id="log-level"
                        value={settings.logLevel}
                        onChange={(e) =>
                          updateLogLevel(e.target.value as LogLevel)
                        }
                      >
                        {(
                          [
                            "trace",
                            "debug",
                            "info",
                            "warn",
                            "error",
                          ] as LogLevel[]
                        ).map((level) => (
                          <option key={level} value={level}>
                            {level.toUpperCase()}
                          </option>
                        ))}
                      </select>
                    </div>
                  </section>

                  <section className="settings-section">
                    <div className="settings-section-title">
                      {t("settings.openLogs")}
                    </div>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={handleOpenLogs}
                    >
                      {t("settings.openLogs")}
                    </button>
                  </section>

                  {currentPlatform?.startsWith("Win") && (
                    <section className="settings-section">
                      <div className="settings-section-title">
                        {t("settings.defaultPdfReader")}
                      </div>
                      <div className="settings-section-hint">
                        {t("settings.defaultPdfReaderHint")}
                      </div>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={handleOpenDefaultApps}
                      >
                        {t("settings.setAsDefaultPdfReader")}
                      </button>
                    </section>
                  )}
                </>
              )}

              {activePage === "about" && (
                <>
                  <section className="settings-section">
                    <div className="settings-section-title">
                      {t("settings.appInfo")}
                    </div>
                    <dl className="settings-info-list">
                      <div>
                        <dt>{t("settings.productName")}</dt>
                        <dd>SpecReader AI</dd>
                      </div>
                      <div>
                        <dt>{t("settings.version")}</dt>
                        <dd>{version}</dd>
                      </div>
                      <div>
                        <dt>{t("settings.identifier")}</dt>
                        <dd>com.photonee.specreader</dd>
                      </div>
                    </dl>
                  </section>

                  <section className="settings-section">
                    <div className="settings-section-title">
                      {t("settings.softwareUpdate")}
                    </div>
                    <div className="settings-section-hint">
                      {t("settings.softwareUpdateHint", { version })}
                    </div>
                    {updateState === "idle" && (
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={handleCheckUpdate}
                      >
                        {t("settings.checkForUpdates")}
                      </button>
                    )}
                    {updateState === "checking" && (
                      <span className="settings-status-info">
                        {t("settings.checkingForUpdates")}
                      </span>
                    )}
                    {updateState === "noUpdate" && (
                      <span className="settings-status-ok">
                        {t("settings.noUpdateAvailable")}
                      </span>
                    )}
                    {updateState === "available" && (
                      <div className="settings-update-available">
                        <span>
                          {t("settings.updateAvailable", {
                            version: updateVersion,
                          })}
                        </span>
                        <button
                          type="button"
                          className="icon-btn primary"
                          onClick={handleUpgrade}
                        >
                          {t("settings.upgradeNow")}
                        </button>
                      </div>
                    )}
                    {updateState === "installing" && (
                      <span className="settings-status-info">
                        {t("settings.installingUpdate")}
                      </span>
                    )}
                    {updateState === "noPlatformUpdate" && (
                      <span className="settings-status-info">
                        {t("settings.noUpdateForPlatform")}
                      </span>
                    )}
                    {updateState === "error" && updateError && (
                      <span className="settings-status-error">
                        {t("settings.updateError", { error: updateError })}
                      </span>
                    )}
                  </section>

                  <section className="settings-section">
                    <div className="settings-section-title">
                      {t("settings.license")}
                    </div>
                    <pre className="settings-license-text">
                      {licenseText ?? t("settings.licenseLoading")}
                    </pre>
                  </section>
                </>
              )}
            </div>
          </div>
        </form>

        <div className="settings-modal-footer">
          <div className="settings-modal-footer-left">
            <button type="button" className="icon-btn" onClick={resetAll}>
              {t("settings.resetAll")}
            </button>
          </div>
          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button type="submit" form="settings-form">
              {t("common.save")}
            </button>
          </div>
        </div>
      </div>

      {showDownloadConfirm && (
        <div className="modal-overlay" onClick={handleCancelDownload}>
          <div
            className="modal-content dictionary-download-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={t("settings.downloadDictionaryTitle")}
          >
            <div className="dictionary-download-icon">
              <Icon name="dictionary" size={40} />
            </div>
            <h3>{t("settings.downloadDictionaryTitle")}</h3>
            <p className="modal-hint">{t("settings.downloadDictionaryHint")}</p>
            <div className="modal-actions">
              <button type="button" onClick={handleCancelDownload}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="primary"
                onClick={handleConfirmDownload}
              >
                {t("settings.downloadNow")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
