/**
 * LLM 相关类型定义
 *
 * 这些类型用于前端 service 层和 UI 组件之间的数据传递。
 * 后端 Rust 的对应结构（在 llm_proxy.rs 中）必须保持 serde 字段名一致（camelCase）。
 */

/** 思考模式开关 */
export type ThinkingMode = "enabled" | "disabled" | "auto";

/**
 * 多模态 content part（OpenAI 兼容格式）。
 * 图片仅以 base64 data URL 形式出现在 user 消息中（页面截图工具）。
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** Chat 消息 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** 纯文本，或视觉场景下的 content parts 数组（仅 user 消息） */
  content: string | ContentPart[];
  /** 工具调用 ID（role=tool 时） */
  toolCallId?: string;
  /** assistant 发起的工具调用（role=assistant 且有工具调用时） */
  toolCalls?: ToolCall[];
  /** 思考内容（部分平台如 DeepSeek 在工具调用轮次必须回传） */
  reasoningContent?: string;
}

/** 工具调用定义 */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** Token 用量信息 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 思考过程消耗的 token（已计入 completionTokens） */
  reasoningTokens?: number;
  /** 命中上下文缓存的输入 token */
  cachedTokens?: number;
}

/**
 * 结构化 LLM 错误
 *
 * 后端 LlmError 枚举的 TypeScript 对应。
 * 前端根据 kind 字段显示不同的友好提示和操作引导。
 */
export type LlmError =
  | { kind: "network"; detail: string }
  | { kind: "auth"; detail: string }
  | { kind: "modelNotFound"; model: string; detail: string }
  | { kind: "rateLimit"; retryAfter: number | null; detail: string }
  | {
      kind: "contextLengthExceeded";
      limit: number;
      requested: number;
      detail: string;
    }
  | { kind: "serverError"; status: number; detail: string }
  | { kind: "streamInterrupted"; partialContent: string }
  | { kind: "invalidConfig"; field: string; detail: string }
  | { kind: "toolError"; toolName: string; detail: string }
  | { kind: "unknown"; status: number; body: string };
