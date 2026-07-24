import { useCallback, useMemo, useRef } from "react";
import {
  ChatMessage,
  streamChatCompletion,
  StreamOptions,
} from "../services/llm";
import type { LlmError, TokenUsage } from "../types/llm";

export interface StreamingHandlers {
  onChunk: (chunk: string, accumulated: string) => void;
  onError: (message: string, error?: LlmError) => void;
  onDone: () => void;
  /** Called when reasoning/thinking content arrives (optional). */
  onReasoningChunk?: (chunk: string, accumulated: string) => void;
  /** Called when token usage info arrives (optional). */
  onUsage?: (usage: TokenUsage) => void;
  /** Called when a complete tool_call is received (optional). */
  onToolCall?: (name: string, args: string, callId: string) => void;
  /** Called when the stream is aborted before completion (optional). */
  onAbort?: () => void;
}

/**
 * Generic streaming hook. Handles abort signalling, chunk accumulation,
 * error propagation and completion notification so callers only need to react
 * to streaming events.
 *
 * A `key` identifies each stream, allowing multiple concurrent streams and
 * targeted aborts.
 *
 * Note: LLM config (baseUrl/model/apiKey) is read by the Rust backend from
 * settings + keyring. The frontend no longer needs to pass it.
 */
export function useStreaming() {
  const controllersRef = useRef<Map<string, AbortController>>(new Map());

  const run = useCallback(
    async (
      key: string,
      messages: ChatMessage[],
      handlers: StreamingHandlers,
      options?: StreamOptions
    ) => {
      controllersRef.current.get(key)?.abort();
      const controller = new AbortController();
      controllersRef.current.set(key, controller);

      let accumulated = "";
      let reasoningAccumulated = "";
      try {
        const streamOptions: StreamOptions = {
          ...options,
          signal: controller.signal,
        };

        for await (const event of streamChatCompletion(
          messages,
          streamOptions
        )) {
          if (controller.signal.aborted) {
            handlers.onAbort?.();
            return;
          }
          switch (event.type) {
            case "chunk":
              accumulated += event.content;
              handlers.onChunk(event.content, accumulated);
              break;
            case "reasoningChunk":
              reasoningAccumulated += event.content;
              handlers.onReasoningChunk?.(event.content, reasoningAccumulated);
              break;
            case "toolCall":
              handlers.onToolCall?.(event.name, event.args, event.callId);
              break;
            case "usage":
              handlers.onUsage?.(event.usage);
              break;
            case "error":
              handlers.onError(event.message, event.error);
              return;
            case "done":
              break;
          }
        }
        if (!controller.signal.aborted) {
          handlers.onDone();
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          handlers.onError(String(err));
        }
      } finally {
        controllersRef.current.delete(key);
      }
    },
    []
  );

  const abort = useCallback((key: string) => {
    controllersRef.current.get(key)?.abort();
    controllersRef.current.delete(key);
  }, []);

  const abortPrefix = useCallback((prefix: string) => {
    for (const [key, controller] of controllersRef.current.entries()) {
      if (key.startsWith(prefix)) {
        controller.abort();
        controllersRef.current.delete(key);
      }
    }
  }, []);

  const abortAll = useCallback(() => {
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
  }, []);

  // 返回对象用 useMemo 固定引用：usePersistence 的 runSessionStream 依赖
  // 本对象，对象字面量会让它在每次渲染重建并击穿上层 memo 链。
  return useMemo(
    () => ({ run, abort, abortPrefix, abortAll }),
    [run, abort, abortPrefix, abortAll]
  );
}
