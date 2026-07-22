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

/** 平台一句话简介（降低非编程用户的认知负担）。 */
const PLATFORM_BLURB: Partial<Record<PlatformId, string>> = {
  deepseek: "国产模型，便宜稳定，支持深度思考",
  kimi: "国产长上下文模型，适合大段标准",
  bailian: "阿里云通义千问，国内访问快",
  glm: "智谱 GLM，提供免费额度",
  volcengine: "火山引擎豆包，国产模型",
  openai: "OpenAI 官方 GPT，需海外信用卡",
  openrouter: "聚合多家海外模型，需海外信用卡",
};

type TagKind = "recommended" | "free" | "card";

function platformTag(id: PlatformId): { text: string; kind: TagKind } | null {
  if (id === "deepseek") return { text: "推荐", kind: "recommended" };
  if (id === "glm") return { text: "免费但限速", kind: "free" };
  if (id === "openai" || id === "openrouter")
    return { text: "需海外信用卡", kind: "card" };
  return null;
}

/** 自定义（高级）对非编程用户隐藏；其余按「易用度」排序，推荐项置顶。 */
const WIZARD_ORDER: PlatformId[] = [
  "deepseek",
  "kimi",
  "bailian",
  "glm",
  "volcengine",
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
  const w = (key: string, def: string, opts?: Record<string, unknown>) =>
    t(`wizard.${key}`, { defaultValue: def, ...(opts ?? {}) });

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

  const describeError = (err: LlmError): string => {
    switch (err.kind) {
      case "auth":
        return w(
          "errorAuth",
          "密钥无效或未授权。请确认粘贴的 Key 完整、未有多余空格，并已在平台后台启用。"
        );
      case "network":
        return w("errorNetwork", "网络无法连接。请检查网络连接后重试。");
      case "modelNotFound":
        return w(
          "errorModelNotFound",
          "模型 {{model}} 不存在，请回到上一步重新选择该平台的模型。",
          { model: err.model }
        );
      case "rateLimit":
        return w(
          "errorRateLimit",
          "请求过于频繁被限流，请稍候片刻再试；若经常发生，建议更换为付费模型。"
        );
      case "contextLengthExceeded":
        return w(
          "errorContextLength",
          "内容超出模型上下文长度，请减少所选片段长度后重试。"
        );
      case "serverError":
        return w("errorServer", "服务错误（{{status}}），请稍后重试或换用其他平台。", {
          status: err.status,
        });
      default: {
        const detail =
          "detail" in err
            ? (err as { detail: string }).detail
            : "body" in err
              ? (err as { body: string }).body
              : "未知错误";
        return w("errorUnknown", "连接失败：{{detail}}", { detail });
      }
    }
  };

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
    [initialSettings, platformId, preset, thinking, agentToolsEnabled, targetLanguage]
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
    } catch {
      // 测试已成功，保存失败不阻断进入主界面，避免二次挫败
    }
    onComplete(finalSettings);
  }, [apiKey, buildSettings, onComplete]);

  const stepLabel = (n: Step): string => {
    if (n === 1) return w("step1", "选择平台");
    if (n === 2) return w("step2", "填入密钥");
    return w("step3", "测试连接");
  };

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-label={w("title", "欢迎使用 SpecReader AI")}
    >
      <div className="modal-content wizard-content">
        <button
          type="button"
          className="wizard-close"
          onClick={onSkip}
          aria-label={w("close", "关闭")}
        >
          <Icon name="close" size={18} />
        </button>

        <h3>{w("title", "欢迎使用 SpecReader AI")}</h3>
        <p className="modal-hint">
          {w("subtitle", "只需三步，配置好 AI 模型即可开始翻译与解读标准。")}
        </p>

        {/* 步骤指示器 */}
        <ol className="wizard-steps">
          {([1, 2, 3] as Step[]).map((n) => (
            <li
              key={n}
              className={
                step === n ? "active" : step > n ? "done" : ""
              }
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
              <p className="wizard-lead">
                {w(
                  "selectPlatformHint",
                  "我们推荐从 DeepSeek 开始：便宜、稳定、支持深度思考。下方卡片已按难易度排序。"
                )}
              </p>
              <div className="wizard-platforms">
                {WIZARD_ORDER.map((id) => {
                  const p = PLATFORM_PRESETS[id];
                  const tag = platformTag(id);
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
                      {tag && (
                        <span className={`wizard-tag ${tag.kind}`}>
                          {tag.text}
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
                          <span className="wizard-configured">已配置</span>
                        )}
                      </span>
                      <span className="wizard-platform-blurb">
                        {PLATFORM_BLURB[id]}
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
                {w("enterKeyTitle", "填入 {{platform}} 的 API Key", {
                  platform: preset.label,
                })}
              </p>
              <a
                className="wizard-getkey"
                href={preset.apiKeyHelpUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {w("getApiKey", "前往 {{platform}} 获取密钥", {
                  platform: preset.label,
                })}
              </a>
              <input
                type="password"
                className="wizard-input"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  hasExistingKey
                    ? w("apiKeyPlaceholderKeep", "留空则沿用已保存的密钥")
                    : "sk-..."
                }
                autoFocus
                aria-label={w("apiKey", "API Key")}
              />
              {hasExistingKey && !apiKey.trim() && (
                <p className="wizard-hint wizard-hint-keep">
                  {w(
                    "keepExistingKey",
                    "已检测到该平台的密钥，留空将直接沿用，无需重新粘贴。"
                  )}
                </p>
              )}
              {preset.apiKeyHint && (
                <p className="wizard-hint">
                  {w("hintPrefix", "提示：")}
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
                {w("advancedTitle", "高级设置（一般无需修改）")}
              </button>
              {showAdvanced && (
                <div className="wizard-advanced">
                  <label className="wizard-field">
                    {w("thinkingLabel", "深度思考（更准确，但稍慢）")}
                    <select
                      value={thinking}
                      onChange={(e) =>
                        setThinking(e.target.value as ThinkingMode)
                      }
                    >
                      <option value="auto">
                        {w("thinkingAuto", "自动（模型默认）")}
                      </option>
                      <option value="enabled">
                        {w("thinkingEnabled", "开启（推理更深入，更慢）")}
                      </option>
                      <option value="disabled">
                        {w("thinkingDisabled", "关闭（快速响应）")}
                      </option>
                    </select>
                  </label>
                  <label className="wizard-toggle">
                    <input
                      type="checkbox"
                      checked={agentToolsEnabled}
                      onChange={(e) => setAgentToolsEnabled(e.target.checked)}
                    />
                    {w(
                      "agentToolsLabel",
                      "让 AI 自动核对原文条款（推荐开启）"
                    )}
                  </label>
                  <label className="wizard-field">
                    {w("targetLanguageLabel", "翻译 / 解读目标语言")}
                    <input
                      type="text"
                      value={targetLanguage}
                      onChange={(e) => setTargetLanguage(e.target.value)}
                      placeholder="中文"
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
                  hasExistingKey && !apiKey.trim()
                    ? "点击下方按钮，我们会用你已保存的密钥连接 {{platform}} 进行验证。"
                    : "点击下方按钮，我们会用你填入的密钥连接 {{platform}} 进行验证。",
                  { platform: preset.label }
                )}
              </p>
              <button
                type="button"
                className="icon-btn primary wizard-test-btn"
                onClick={handleTest}
                disabled={testState === "testing" || (!apiKey.trim() && !hasExistingKey)}
              >
                {testState === "testing"
                  ? w("testing", "测试中...")
                  : w("testButton", "测试连接")}
              </button>

              {testState === "success" && (
                <div className="wizard-result ok">
                  <CheckMark />
                  <span>
                    {w("testSuccess", "连接成功，模型：{{model}}", {
                      model: testModel ?? preset.defaultModelId,
                    })}
                  </span>
                </div>
              )}
              {testState === "error" && testError && (
                <div className="wizard-result err">
                  <strong>{w("testFailTitle", "连接未成功")}</strong>
                  <span>{describeError(testError)}</span>
                </div>
              )}
              {testState !== "success" && testState !== "testing" && (
                <p className="wizard-result-hint">
                  {w(
                    "testFailHint",
                    "若连接失败，请按上方提示检查密钥与网络后重试。"
                  )}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="wizard-footer">
          <button type="button" className="wizard-link" onClick={onSkip}>
            {w("skip", "暂不配置，直接进入")}
          </button>
          <div className="wizard-nav">
            {step > 1 && (
              <button type="button" onClick={goBack}>
                {w("back", "上一步")}
              </button>
            )}
            {step < 3 && (
              <button
                type="button"
                className="primary"
                onClick={goNext}
                disabled={step === 2 && !apiKey.trim() && !hasExistingKey}
              >
                {w("next", "下一步")}
              </button>
            )}
            {step === 3 && (
              <button
                type="button"
                className="primary"
                onClick={handleStart}
                disabled={testState !== "success"}
              >
                {w("startUsing", "开始使用")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
