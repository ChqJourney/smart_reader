import i18n from "i18next";
import { info, warn, redactSensitiveInfo } from "./logs";
import { LlmConfig, SystemPrompts } from "./settings";

export type { LlmConfig, SystemPrompts };

export type SelectionAction = "explain" | "translate";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function* streamChatCompletion(
  config: LlmConfig,
  messages: ChatMessage[],
  signal?: AbortSignal
): AsyncGenerator<
  { type: "chunk"; content: string } | { type: "error"; message: string },
  void
> {
  if (!config.apiKey) {
    yield {
      type: "error",
      message: i18n.t("llm.error.apiKeyMissing"),
    };
    return;
  }

  if (signal?.aborted) {
    return;
  }

  info(`llmRequestStarted: model=${config.model}`);
  const start = performance.now();

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: true,
      }),
      signal,
    });

    if (!response.ok) {
      const errorText = redactSensitiveInfo(await response.text());
      const duration = Math.round(performance.now() - start);
      warn(
        `llmRequestFailed: status=${response.status} model=${config.model} durationMs=${duration}`
      );
      yield {
        type: "error",
        message: i18n.t("llm.error.apiError", {
          status: response.status,
          detail: errorText,
        }),
      };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      const duration = Math.round(performance.now() - start);
      warn(
        `llmRequestFailed: empty response body model=${config.model} durationMs=${duration}`
      );
      yield { type: "error", message: i18n.t("llm.error.streamReadError") };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      if (signal?.aborted) {
        await reader.cancel();
        return;
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;

        try {
          const data = JSON.parse(trimmed.slice(6));
          if (data.error) {
            const duration = Math.round(performance.now() - start);
            warn(
              `llmRequestFailed: apiError model=${config.model} durationMs=${duration}`
            );
            yield {
              type: "error",
              message: i18n.t("llm.error.llmApiError", {
                detail: JSON.stringify(data.error),
              }),
            };
            return;
          }
          const delta = data.choices?.[0]?.delta?.content;
          if (delta) {
            yield { type: "chunk", content: delta };
          }
        } catch {
          // ignore malformed SSE data
        }
      }
    }

    const duration = Math.round(performance.now() - start);
    info(`llmRequestCompleted: model=${config.model} durationMs=${duration}`);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return;
    }
    const duration = Math.round(performance.now() - start);
    warn(
      `llmRequestFailed: error=${err} model=${config.model} durationMs=${duration}`
    );
    yield {
      type: "error",
      message: i18n.t("llm.error.requestFailed", { message: String(err) }),
    };
  }
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
  targetLanguage: string
): string {
  switch (action) {
    case "explain":
      return i18n.t("llm.prompts.explain", { targetLanguage, text });
    case "translate":
      return i18n.t("llm.prompts.translate", { targetLanguage, text });
    default:
      return text;
  }
}
