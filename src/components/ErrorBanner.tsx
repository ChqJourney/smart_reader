import { useTranslation } from "react-i18next";
import type { LlmError } from "../types/llm";

interface ErrorBannerProps {
  error: LlmError;
  onRetry?: () => void;
  onOpenSettings?: () => void;
  onNewSession?: () => void;
}

export default function ErrorBanner({
  error,
  onRetry,
  onOpenSettings,
  onNewSession,
}: ErrorBannerProps) {
  const { t } = useTranslation();

  const message = getErrorMessage(error, t);
  const showSettings = ["auth", "modelNotFound", "invalidConfig"].includes(
    error.kind
  );
  const showNewSession = error.kind === "contextLengthExceeded";
  const showRetry =
    !showSettings ||
    error.kind === "rateLimit" ||
    error.kind === "serverError" ||
    error.kind === "network";

  return (
    <div className="error-banner">
      <span className="error-banner-icon">⚠</span>
      <div className="error-banner-content">{message}</div>
      <div className="error-banner-actions">
        {showRetry && onRetry && (
          <button
            type="button"
            className="error-banner-action"
            onClick={onRetry}
          >
            {t("error.retry", { defaultValue: "重试" })}
          </button>
        )}
        {showSettings && onOpenSettings && (
          <button
            type="button"
            className="error-banner-action"
            onClick={onOpenSettings}
          >
            {t("error.openSettings", { defaultValue: "打开设置" })}
          </button>
        )}
        {showNewSession && onNewSession && (
          <button
            type="button"
            className="error-banner-action"
            onClick={onNewSession}
          >
            {t("error.newSession", { defaultValue: "新建会话" })}
          </button>
        )}
      </div>
    </div>
  );
}

function getErrorMessage(
  error: LlmError,
  t: (key: string, options?: any) => string
): string {
  switch (error.kind) {
    case "network":
      return t("error.network", { defaultValue: error.detail });
    case "auth":
      return t("error.auth", { defaultValue: error.detail });
    case "modelNotFound":
      return t("error.modelNotFound", {
        model: error.model,
        defaultValue: error.detail,
      });
    case "rateLimit":
      return t("error.rateLimit", { defaultValue: error.detail });
    case "contextLengthExceeded":
      return t("error.contextLengthExceeded", { defaultValue: error.detail });
    case "serverError":
      return t("error.server", {
        status: error.status,
        defaultValue: error.detail,
      });
    case "streamInterrupted":
      return t("error.streamInterrupted", {
        defaultValue: "响应中断，已保留部分内容",
      });
    case "invalidConfig":
      return t("error.invalidConfig", {
        field: error.field,
        defaultValue: error.detail,
      });
    case "toolError":
      return t("error.toolError", {
        toolName: error.toolName,
        defaultValue: error.detail,
      });
    case "unknown":
      return t("error.unknown", {
        status: error.status,
        defaultValue: `请求失败 (HTTP ${error.status}): ${error.body}`,
      });
  }
}
