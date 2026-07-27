import i18n from "i18next";
import type { LlmError } from "../types/llm";
import { warn } from "./logs";

/**
 * 把结构化 LlmError 转为面向用户的友好中文文案。
 *
 * 原始报错（常为英文，如 "Incorrect API key provided"）只写入日志，
 * 不进入 UI。设置页、首次配置向导、解读 / 翻译错误提示统一走这里，
 * 避免多处文案不一致（曾经向导友好、设置页透传英文原文）。
 */
export function llmErrorToMessage(err: LlmError): string {
  // 原始报文进日志便于排查；UI 只展示友好中文。
  warn(`llmError: ${JSON.stringify(err)}`);
  switch (err.kind) {
    case "network":
      return i18n.t("llm.error.network");
    case "auth":
      return i18n.t("llm.error.auth");
    case "modelNotFound":
      return i18n.t("llm.error.modelNotFound", { model: err.model });
    case "rateLimit":
      return i18n.t("llm.error.rateLimit");
    case "contextLengthExceeded":
      return i18n.t("llm.error.contextLengthExceeded");
    case "serverError":
      return i18n.t("llm.error.serverError", { status: err.status });
    case "streamInterrupted":
      return i18n.t("llm.error.streamInterrupted");
    case "invalidConfig":
      return i18n.t("llm.error.invalidConfig", { field: err.field });
    case "toolError":
      return i18n.t("llm.error.toolError", { toolName: err.toolName });
    case "unknown":
      return i18n.t("llm.error.unknown", { status: err.status });
  }
}
