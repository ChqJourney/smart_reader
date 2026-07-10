import { LlmConfig } from "./settings";

export type { LlmConfig };

export type SelectionAction = "explain" | "translate";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function* streamChatCompletion(
  config: LlmConfig,
  messages: ChatMessage[],
  signal?: AbortSignal
): AsyncGenerator<{ type: "chunk"; content: string } | { type: "error"; message: string }, void> {
  if (!config.apiKey) {
    yield { type: "error", message: "API Key 未配置，请先在设置中配置 LLM API。" };
    return;
  }

  if (signal?.aborted) {
    return;
  }

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
      const errorText = await response.text();
      yield { type: "error", message: `LLM API 错误 (${response.status}): ${errorText}` };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: "error", message: "无法读取 LLM 响应流。" };
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
            yield { type: "error", message: `LLM API 错误: ${JSON.stringify(data.error)}` };
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
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return;
    }
    yield { type: "error", message: `请求失败: ${err}` };
  }
}

export function buildSystemPrompt(targetLanguage: string): string {
  return `你是一位检测认证行业标准文档阅读助手，擅长把复杂的英文标准条款解释得清晰易懂。请基于用户提供的文档片段用${targetLanguage}回答，不要编造片段中未提及的条款或页码。`;
}

export function buildCustomInterpretPrompt(
  prompt: string,
  sources: { fileName: string; page: number; text: string }[],
  targetLanguage: string
): string {
  const sourceText = sources
    .map((s, i) => `片段 ${i + 1}（${s.fileName} 第 ${s.page} 页）：\n${s.text}`)
    .join("\n\n");
  return `请用${targetLanguage}回答以下问题：\n\n${prompt}\n\n${sourceText}`;
}

export function buildSelectionPrompt(
  action: "explain" | "translate",
  text: string,
  targetLanguage: string
): string {
  switch (action) {
    case "explain":
      return `请用通俗易懂的${targetLanguage}解读以下标准条款/段落，说明其要求、意义、与测试工作的关系，并指出可能相关的其他条款：\n\n${text}`;
    case "translate":
      return `请将以下标准文档内容翻译成${targetLanguage}，保持专业术语准确，并在首次出现关键术语时保留原文：\n\n${text}`;
    default:
      return text;
  }
}

export const ACTION_LABELS: Record<"explain" | "translate", string> = {
  explain: "解读",
  translate: "翻译",
};
