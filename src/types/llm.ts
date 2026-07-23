/**
 * LLM 相关类型定义
 *
 * 这些类型用于前端 service 层和 UI 组件之间的数据传递。
 * 后端 Rust 的对应结构（在 llm_proxy.rs 中）必须保持 serde 字段名一致（camelCase）。
 */

/** 思考模式开关 */
export type ThinkingMode = "enabled" | "disabled" | "auto";

/** Chat 消息 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
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

/**
 * 流式事件（后端通过 Tauri Channel 推送给前端）
 *
 * 对应后端 StreamEvent 枚举，字段名 camelCase。
 */
export type StreamEvent =
  | { type: "chunk"; content: string }
  | { type: "reasoningChunk"; content: string }
  | { type: "toolCall"; name: string; args: string; callId: string }
  | { type: "toolResult"; callId: string; summary: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "error"; error: LlmError }
  | { type: "done" };
