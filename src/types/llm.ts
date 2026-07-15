/**
 * LLM 相关类型定义
 *
 * 这些类型用于前端 service 层和 UI 组件之间的数据传递。
 * 后端 Rust 的对应结构（在 llm_proxy.rs 中）必须保持 serde 字段名一致（camelCase）。
 */

import type { PlatformId } from "../data/platformPresets";

/** 思考模式开关 */
export type ThinkingMode = "enabled" | "disabled" | "auto";

/**
 * LLM Profile（模型配置档案）
 *
 * 用户可以保存多个 profile（如「DeepSeek 日常」「Kimi 长文」「GLM 中文」），
 * 实际使用时只有一个被激活（activeLlmProfileId）。
 *
 * API Key 不存储在此结构中，而是按 profileId 存储在系统钥匙串里。
 * 磁盘 settings.json 中 apiKey 字段始终为空字符串。
 */
export interface LlmProfile {
  /** Profile 唯一标识（UUID 或时间戳生成的 ID） */
  id: string;
  /** 用户可读的 profile 名（如「DeepSeek 日常」） */
  name: string;
  /** 平台 ID（用于匹配预设） */
  platformId: PlatformId;
  /** Base URL（从预设自动填充，用户可覆盖） */
  baseUrl: string;
  /** 模型 ID */
  model: string;
  /** 思考模式开关 */
  thinking: ThinkingMode;
  /** context window 覆盖值（0 表示用预设默认值） */
  contextWindowOverride: number;
  /** 最大工具调用轮次（0 表示用全局默认值） */
  maxToolRoundsOverride: number;
}

/** LLM 请求用的配置（从激活的 profile 解析而来，传给后端） */
export interface LlmRequestConfig {
  platformId: PlatformId;
  baseUrl: string;
  model: string;
  thinking: ThinkingMode;
}

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

/** 工具调用请求参数（发给后端 invoke） */
export interface ChatCompletionsRequest {
  /** 激活的 profile ID（后端据此从 keyring 读 API Key） */
  profileId: string;
  /** 消息列表 */
  messages: ChatMessage[];
  /** 是否启用内置工具（PDF 读取/查找） */
  enableTools: boolean;
  /** 当前会话授权访问的 PDF fileHash 列表（工具白名单） */
  authorizedFileHashes: string[];
  /** AbortSignal 的标识，用于取消请求 */
  requestId: string;
}

/** 测试连接请求参数 */
export interface TestConnectionRequest {
  profileId: string;
}

/** 测试连接结果 */
export interface TestConnectionResult {
  success: boolean;
  model: string;
  error?: LlmError;
}
