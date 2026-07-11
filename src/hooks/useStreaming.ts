import { useCallback, useRef } from "react";
import { ChatMessage, LlmConfig, streamChatCompletion } from "../services/llm";

export interface StreamingHandlers {
  onChunk: (chunk: string, accumulated: string) => void;
  onError: (message: string) => void;
  onDone: () => void;
}

/**
 * Generic SSE streaming hook. Handles abort signalling, chunk accumulation,
 * error propagation and completion notification so callers only need to react
 * to streaming events.
 *
 * A `key` identifies each stream, allowing multiple concurrent streams and
 * targeted aborts.
 */
export function useStreaming() {
  const controllersRef = useRef<Map<string, AbortController>>(new Map());

  const run = useCallback(
    async (
      key: string,
      llmConfig: LlmConfig,
      messages: ChatMessage[],
      handlers: StreamingHandlers
    ) => {
      controllersRef.current.get(key)?.abort();
      const controller = new AbortController();
      controllersRef.current.set(key, controller);

      let accumulated = "";
      try {
        for await (const event of streamChatCompletion(
          llmConfig,
          messages,
          controller.signal
        )) {
          if (controller.signal.aborted) return;
          if (event.type === "chunk") {
            accumulated += event.content;
            handlers.onChunk(event.content, accumulated);
          } else if (event.type === "error") {
            handlers.onError(event.message);
            return;
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

  const abortAll = useCallback(() => {
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
  }, []);

  return { run, abort, abortAll };
}
