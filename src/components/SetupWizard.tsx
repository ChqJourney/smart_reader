import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "./Icon";
import {
  AppSettings,
  checkApiKey,
  saveSettings,
  ThinkingMode,
  PlatformId,
} from "../services/settings";
import { PLATFORM_PRESETS } from "../data/platformPresets";
import { testConnection } from "../services/llm";
import { llmErrorToMessage } from "../services/llmError";
import type { LlmError } from "../types/llm";
import "./SetupWizard.css";

type Step = 1 | 2 | 3;
type TestState = "idle" | "testing" | "success" | "error";

interface SetupWizardProps {
  open: boolean;
  initialSettings: AppSettings;
  onComplete: (settings: AppSettings) => void;
  onSkip: () => void;
}

type TagKind = "recommended" | "free" | "card";

function platformTagKind(id: PlatformId): TagKind | null {
  if (id === "deepseek") return "recommended";
  if (id === "glm") return "free";
  if (id === "openai" || id === "openrouter") return "card";
  return null;
}

/** 自定义（高级）对非编程用户隐藏；其余按「易用度」排序，推荐项置顶。 */
const WIZARD_ORDER: PlatformId[] = [
  "deepseek",
  "kimi",
  "bailian",
  "glm",
  "volcengine",
  "xiaomimimo",
  "openai",
  "openrouter",
];

function CheckMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 8.5l3 3 7-7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function SetupWizard({
  open,
  initialSettings,
  onComplete,
  onSkip,
}: SetupWizardProps) {
  const { t } = useTranslation();
  // 向导文案全部收编在 locales 的 wizard.* 段，此处不再保留 defaultValue 内联副本。
  const w = (key: string, opts?: Record<string, unknown>) =>
    t(`wizard.${key}`, opts ?? {});

  const [step, setStep] = useState<Step>(1);
  const [platformId, setPlatformId] = useState<PlatformId>(
    initialSettings.platformId !== "custom" &&
      PLATFORM_PRESETS[initialSettings.platformId]
      ? initialSettings.platformId
      : "deepseek"
  );
  const [apiKey, setApiKey] = useState("");
  const [thinking, setThinking] = useState<ThinkingMode>(
    initialSettings.thinking
  );
  const [agentToolsEnabled, setAgentToolsEnabled] = useState(
    initialSettings.agentToolsEnabled
  );
  const [targetLanguage, setTargetLanguage] = useState(
    initialSettings.targetLanguage
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [testState, setTestState] = useState<TestState>("idle");
  const [testModel, setTestModel] = useState<string | null>(null);
  const [testError, setTestError] = useState<LlmError | null>(null);
  // 各平台在钥匙串中是否已存在密钥。用于：① 卡片标注「已配置」；
  // ② 第 2 步允许留空密钥（沿用已保存的 key），方便已配过的用户换平台/改模型。
  const [existingKeys, setExistingKeys] = useState<Set<PlatformId>>(new Set());

  const preset = PLATFORM_PRESETS[platformId];

  // 向导打开时探测各平台钥匙串状态（key 不回传 webview，只能靠 checkApiKey 判断）。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.all(WIZARD_ORDER.map((id) => checkApiKey(id)))
      .then((results) => {
        if (cancelled) return;
        const set = new Set<PlatformId>();
        results.forEach((ok, i) => {
          if (ok) set.add(WIZARD_ORDER[i]);
        });
        setExistingKeys(set);
      })
      .catch(() => {
        // 探测失败按「无密钥」处理，不阻断向导。
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // 当前选中平台是否已有密钥；是则第 2/3 步允许留空密钥。
  const hasExistingKey = existingKeys.has(platformId);

  const selectPlatform = useCallback((id: PlatformId) => {
    setPlatformId(id);
    // 切换平台后，之前的测试结果失效，回到待测试状态。
    setTestState("idle");
    setTestError(null);
  }, []);

  const goNext = useCallback(() => {
    setStep((s) => (s < 3 ? ((s + 1) as Step) : s));
  }, []);

  const goBack = useCallback(() => {
    setStep((s) => (s > 1 ? ((s - 1) as Step) : s));
  }, []);

  const buildSettings = useCallback(
    (key: string): AppSettings => ({
      ...initialSettings,
      platformId,
      llm: {
        baseUrl: preset.baseUrl,
        model: preset.defaultModelId,
        apiKey: key,
      },
      thinking,
      agentToolsEnabled,
      targetLanguage,
    }),
    [
      initialSettings,
      platformId,
      preset,
      thinking,
      agentToolsEnabled,
      targetLanguage,
    ]
  );

  const handleTest = useCallback(async () => {
    if (!apiKey.trim() && !hasExistingKey) return;
    setTestState("testing");
    setTestError(null);
    const settingsToSave = buildSettings(apiKey.trim());
    try {
      // saveSettings 会把 apiKey 写入系统钥匙串，其余写入 settings.json
      await saveSettings(settingsToSave);
      const result = await testConnection();
      if (result.success) {
        setTestState("success");
        setTestModel(result.model);
      } else if (result.error) {
        setTestState("error");
        setTestError(result.error);
      } else {
        setTestState("error");
        setTestError({ kind: "unknown", status: 0, body: "未知错误" });
      }
    } catch (e) {
      setTestState("error");
      setTestError({ kind: "unknown", status: 0, body: String(e) });
    }
  }, [apiKey, buildSettings, hasExistingKey]);

  const handleStart = useCallback(async () => {
    const finalSettings = buildSettings(apiKey.trim());
    try {
      await saveSettings(finalSettings);
      onComplete(finalSettings);
    } catch (err) {
      setTestError({ kind: "unknown", status: 0, body: String(err) });
    }
  }, [apiKey, buildSettings, onComplete]);

  const stepLabel = (n: Step): string => {
    if (n === 1) return w("step1");
    if (n === 2) return w("step2");
    return w("step3");
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" role="dialog" aria-label={w("title")}>
      <div className="modal-content wizard-content">
        <button
          type="button"
          className="wizard-close"
          onClick={onSkip}
          aria-label={w("close")}
        >
          <Icon name="close" size={18} />
        </button>

        <h3>{w("title")}</h3>
        <p className="modal-hint">{w("subtitle")}</p>

        {/* 步骤指示器 */}
        <ol className="wizard-steps">
          {([1, 2, 3] as Step[]).map((n) => (
            <li
              key={n}
              className={step === n ? "active" : step > n ? "done" : ""}
            >
              <span className="wizard-step-dot">
                {step > n ? <CheckMark /> : n}
              </span>
              <span className="wizard-step-label">{stepLabel(n)}</span>
            </li>
          ))}
        </ol>

        <div className="wizard-body">
          {/* 步骤 1：选择平台 */}
          {step === 1 && (
            <div className="wizard-step">
              <p className="wizard-lead">{w("selectPlatformHint")}</p>
              <div className="wizard-platforms">
                {WIZARD_ORDER.map((id) => {
                  const p = PLATFORM_PRESETS[id];
                  const tagKind = platformTagKind(id);
                  return (
                    <button
                      type="button"
                      key={id}
                      className={`wizard-platform${
                        platformId === id ? " selected" : ""
                      }`}
                      onClick={() => selectPlatform(id)}
                      aria-pressed={platformId === id}
                    >
                      {tagKind && (
                        <span className={`wizard-tag ${tagKind}`}>
                          {w(`tag.${tagKind}`)}
                        </span>
                      )}
                      {platformId === id && (
                        <span className="wizard-platform-check">
                          <CheckMark />
                        </span>
                      )}
                      <span className="wizard-platform-name">
                        {p.label}
                        {existingKeys.has(id) && (
                          <span className="wizard-configured">
                            {w("configured")}
                          </span>
                        )}
                      </span>
                      <span className="wizard-platform-blurb">
                        {w(`blurb.${id}`)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 步骤 2：填入密钥 */}
          {step === 2 && (
            <div className="wizard-step">
              <p className="wizard-lead">
                {w("enterKeyTitle", { platform: preset.label })}
              </p>
              <a
                className="wizard-getkey"
                href={preset.apiKeyHelpUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {w("getApiKey", { platform: preset.label })}
              </a>
              <input
                type="password"
                className="wizard-input"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  hasExistingKey ? w("apiKeyPlaceholderKeep") : "sk-..."
                }
                autoFocus
                aria-label={w("apiKey")}
              />
              {hasExistingKey && !apiKey.trim() && (
                <p className="wizard-hint wizard-hint-keep">
                  {w("keepExistingKey")}
                </p>
              )}
              {preset.apiKeyHint && (
                <p className="wizard-hint">
                  {w("hintPrefix")}
                  {preset.apiKeyHint}
                </p>
              )}

              {/* 高级设置：默认收起，降低认知负担 */}
              <button
                type="button"
                className="wizard-advanced-toggle"
                onClick={() => setShowAdvanced((v) => !v)}
                aria-expanded={showAdvanced}
              >
                <Icon
                  name="chevron-down"
                  size={16}
                  className={showAdvanced ? "rot" : ""}
                />
                {w("advancedTitle")}
              </button>
              {showAdvanced && (
                <div className="wizard-advanced">
                  <label className="wizard-field">
                    {w("thinkingLabel")}
                    <select
                      value={thinking}
                      onChange={(e) =>
                        setThinking(e.target.value as ThinkingMode)
                      }
                    >
                      <option value="auto">{t("settings.thinkingAuto")}</option>
                      <option value="enabled">
                        {t("settings.thinkingEnabled")}
                      </option>
                      <option value="disabled">
                        {t("settings.thinkingDisabled")}
                      </option>
                    </select>
                  </label>
                  <label className="wizard-toggle">
                    <input
                      type="checkbox"
                      checked={agentToolsEnabled}
                      onChange={(e) => setAgentToolsEnabled(e.target.checked)}
                    />
                    {w("agentToolsLabel")}
                  </label>
                  <label className="wizard-field">
                    {w("targetLanguageLabel")}
                    <input
                      type="text"
                      value={targetLanguage}
                      onChange={(e) => setTargetLanguage(e.target.value)}
                      placeholder={t("settings.targetLanguagePlaceholder")}
                    />
                  </label>
                </div>
              )}
            </div>
          )}

          {/* 步骤 3：测试连接 */}
          {step === 3 && (
            <div className="wizard-step">
              <p className="wizard-lead">
                {w(
                  hasExistingKey && !apiKey.trim()
                    ? "testDescKeep"
                    : "testDesc",
                  { platform: preset.label }
                )}
              </p>
              <button
                type="button"
                className="icon-btn primary wizard-test-btn"
                onClick={handleTest}
                disabled={
                  testState === "testing" || (!apiKey.trim() && !hasExistingKey)
                }
              >
                {testState === "testing"
                  ? t("settings.testing")
                  : t("settings.testConnection")}
              </button>

              {testState === "success" && (
                <div className="wizard-result ok">
                  <CheckMark />
                  <span>
                    {t("settings.testConnectionSuccess", {
                      model: testModel ?? preset.defaultModelId,
                    })}
                  </span>
                </div>
              )}
              {testState === "error" && testError && (
                <div className="wizard-result err">
                  <strong>{w("testFailTitle")}</strong>
                  <span>{llmErrorToMessage(testError)}</span>
                </div>
              )}
              {testState !== "success" && testState !== "testing" && (
                <p className="wizard-result-hint">{w("testFailHint")}</p>
              )}
            </div>
          )}
        </div>

        <div className="wizard-footer">
          <button type="button" className="wizard-link" onClick={onSkip}>
            {w("skip")}
          </button>
          <div className="wizard-nav">
            {step > 1 && (
              <button type="button" onClick={goBack}>
                {w("back")}
              </button>
            )}
            {step < 3 && (
              <button
                type="button"
                className="primary"
                onClick={goNext}
                disabled={step === 2 && !apiKey.trim() && !hasExistingKey}
              >
                {w("next")}
              </button>
            )}
            {step === 3 && (
              <button
                type="button"
                className="primary"
                onClick={handleStart}
                disabled={testState !== "success"}
              >
                {w("startUsing")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
