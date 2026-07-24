import i18n from "i18next";
import { Channel, invoke } from "@tauri-apps/api/core";
import { info, warn } from "./logs";
import { LlmConfig, SystemPrompts } from "./settings";
import type {
  ThinkingMode,
  TokenUsage,
  ChatMessage,
  LlmError,
} from "../types/llm";
import type { ToolCall } from "../types/llm";

export type { LlmConfig, SystemPrompts };
export type { ThinkingMode, TokenUsage, LlmError };
export type { ChatMessage, ToolCall };

export type SelectionAction = "explain" | "translate";

/** Events yielded by streamChatCompletion. */
export type StreamEvent =
  | { type: "chunk"; content: string }
  | { type: "reasoningChunk"; content: string }
  | { type: "toolCall"; name: string; args: string; callId: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "error"; message: string; error?: LlmError }
  | { type: "done" };

/** Options for streamChatCompletion. */
export interface StreamOptions {
  thinking?: ThinkingMode;
  enableTools?: boolean;
  authorizedFileHashes?: string[];
  signal?: AbortSignal;
}

/**
 * Stream a chat completion through the Rust backend (bypasses webview CORS,
 * keeps API key in backend memory only).
 *
 * The backend reads baseUrl/model from settings and apiKey from keyring —
 * the frontend never needs to pass the API key.
 */
export async function* streamChatCompletion(
  messages: ChatMessage[],
  options?: StreamOptions
): AsyncGenerator<StreamEvent, void> {
  if (options?.signal?.aborted) {
    return;
  }

  const requestId =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;

  info(`llmRequestStarted: requestId=${requestId}`);
  const start = performance.now();

  // Queue-based bridge from Channel callbacks to AsyncGenerator
  const queue: StreamEvent[] = [];
  let resolveWait: (() => void) | null = null;
  let finished = false;

  const enqueue = (event: StreamEvent) => {
    queue.push(event);
    if (resolveWait) {
      resolveWait();
      resolveWait = null;
    }
  };

  // Set up the Tauri Channel to receive backend StreamEvents
  const channel = new Channel<{
    type: string;
    content?: string;
    usage?: TokenUsage;
    error?: LlmError;
    name?: string;
    args?: string;
    callId?: string;
    call_id?: string;
  }>();

  channel.onmessage = (msg) => {
    switch (msg.type) {
      case "chunk":
        if (msg.content) enqueue({ type: "chunk", content: msg.content });
        break;
      case "reasoningChunk":
        if (msg.content)
          enqueue({ type: "reasoningChunk", content: msg.content });
        break;
      case "toolCall": {
        // Defensive: some platforms/serde configurations serialize this as call_id.
        const callId = msg.callId ?? msg.call_id;
        if (msg.name && callId) {
          enqueue({
            type: "toolCall",
            name: msg.name,
            args: msg.args ?? "{}",
            callId,
          });
        }
        break;
      }
      case "usage":
        if (msg.usage) enqueue({ type: "usage", usage: msg.usage });
        break;
      case "error":
        if (msg.error) {
          enqueue({
            type: "error",
            message: errorToMessage(msg.error),
            error: msg.error,
          });
        }
        finished = true;
        break;
      case "done":
        enqueue({ type: "done" });
        finished = true;
        break;
    }
    if (finished && resolveWait) {
      resolveWait();
      resolveWait = null;
    }
  };

  // 标记流结束并唤醒正在等待的 generator，保证消费者 Promise 一定 settle。
  const markFinished = () => {
    finished = true;
    if (resolveWait) {
      resolveWait();
      resolveWait = null;
    }
  };

  // Handle abort: tell the backend to cancel, and terminate the local
  // generator immediately. 若 SSE 连接已停滞（服务器不再吐数据），Channel
  // 不会再有新事件，不能依赖后端的 Done/Error 来结束 generator。
  const onAbort = () => {
    invoke("cancel_chat_completions", { requestId }).catch(() => {
      // ignore cancel errors
    });
    markFinished();
  };
  options?.signal?.addEventListener("abort", onAbort);

  try {
    // Start the backend stream (non-blocking, communicates via channel)
    const streamPromise = invoke("chat_completions_stream", {
      params: {
        messages,
        thinking: options?.thinking ?? "auto",
        enableTools: options?.enableTools ?? false,
        authorizedFileHashes: options?.authorizedFileHashes ?? [],
        requestId,
      },
      onEvent: channel,
    });

    // 后端命令一旦 settle（正常返回、panic 或 invoke 层错误），Channel
    // 不会再有新事件；唤醒 generator 排空队列后退出，避免它永远等待
    // （例如后端 panic 未发送 Error/Done、或 invoke 直接 reject 的死路）。
    streamPromise.then(markFinished, markFinished);

    // Yield events as they arrive
    while (!finished || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else if (!finished) {
        await new Promise<void>((resolve) => {
          resolveWait = resolve;
        });
      }
    }

    // 用户主动中止后不再等待后端命令返回：停滞的连接可能永不 settle，
    // 不能让 generator 挂死（由 useStreaming 的 aborted 检查走 onAbort，
    // 不显示为错误）。正常/错误路径仍等待以透传 invoke 层错误。
    if (!options?.signal?.aborted) {
      await streamPromise;
    }

    const duration = Math.round(performance.now() - start);
    info(`llmRequestCompleted: requestId=${requestId} durationMs=${duration}`);
  } catch (err) {
    const duration = Math.round(performance.now() - start);
    warn(
      `llmRequestFailed: error=${err} requestId=${requestId} durationMs=${duration}`
    );
    yield {
      type: "error",
      message: i18n.t("llm.error.requestFailed", { message: String(err) }),
    };
  } finally {
    options?.signal?.removeEventListener("abort", onAbort);
  }
}

/** Convert a structured LlmError to a human-readable message. */
function errorToMessage(error: LlmError): string {
  switch (error.kind) {
    case "network":
      return i18n.t("llm.error.network", { defaultValue: error.detail });
    case "auth":
      return i18n.t("llm.error.auth", { defaultValue: error.detail });
    case "modelNotFound":
      return i18n.t("llm.error.modelNotFound", {
        model: error.model,
        defaultValue: error.detail,
      });
    case "rateLimit":
      return i18n.t("llm.error.rateLimit", { defaultValue: error.detail });
    case "contextLengthExceeded":
      return i18n.t("llm.error.contextLengthExceeded", {
        defaultValue: error.detail,
      });
    case "serverError":
      return i18n.t("llm.error.serverError", {
        status: error.status,
        defaultValue: error.detail,
      });
    case "streamInterrupted":
      return i18n.t("llm.error.streamInterrupted", {
        defaultValue: "流式响应中断",
      });
    case "invalidConfig":
      return i18n.t("llm.error.invalidConfig", {
        field: error.field,
        defaultValue: error.detail,
      });
    case "toolError":
      return i18n.t("llm.error.toolError", {
        toolName: error.toolName,
        defaultValue: error.detail,
      });
    case "unknown":
      return i18n.t("llm.error.apiError", {
        status: error.status,
        detail: error.body,
      });
  }
}

/**
 * Test the LLM connection with current settings.
 * Returns success or a structured error.
 */
export async function testConnection(): Promise<{
  success: boolean;
  model: string;
  error?: LlmError;
}> {
  return invoke("test_connection");
}

export function buildSystemPrompt(
  action: "translate" | "explain" | "custom",
  targetLanguage: string,
  systemPrompts: SystemPrompts
): string {
  const raw =
    action === "translate" ? systemPrompts.translate : systemPrompts.explain;
  return raw.replace(/\{targetLanguage\}/g, targetLanguage);
}

export function buildCustomInterpretPrompt(
  prompt: string,
  sources: { fileName: string; page: number; text: string }[],
  targetLanguage: string
): string {
  const sourceText = sources
    .map((s, i) =>
      i18n.t("llm.customInterpretSource", {
        index: i + 1,
        fileName: s.fileName,
        page: s.page,
        text: s.text,
      })
    )
    .join("\n\n");
  return i18n.t("llm.customInterpretPrompt", {
    targetLanguage,
    prompt,
    sources: sourceText,
  });
}

export function buildSelectionPrompt(
  action: "explain" | "translate",
  text: string,
  targetLanguage: string,
  context: { fileName: string; page: number }
): string {
  switch (action) {
    case "explain":
      return i18n.t("llm.prompts.explain", {
        targetLanguage,
        text,
        fileName: context.fileName,
        page: context.page,
      });
    case "translate":
      return i18n.t("llm.prompts.translate", {
        targetLanguage,
        text,
        fileName: context.fileName,
        page: context.page,
      });
    default:
      return text;
  }
}
