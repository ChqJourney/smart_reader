export type SelectionAction = "explain" | "translate";

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const STORAGE_KEY = "standardread-llm-config";

const DEFAULT_LLM_CONFIG: LlmConfig = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
};

export function loadLlmConfig(): LlmConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LlmConfig>;
      return { ...DEFAULT_LLM_CONFIG, ...parsed };
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_LLM_CONFIG };
}

export function saveLlmConfig(config: LlmConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function* streamChatCompletion(
  config: LlmConfig,
  messages: ChatMessage[]
): AsyncGenerator<{ type: "chunk"; content: string } | { type: "error"; message: string }, void> {
  if (!config.apiKey) {
    yield { type: "error", message: "API Key 未配置，请先在设置中配置 LLM API。" };
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
    yield { type: "error", message: `请求失败: ${err}` };
  }
}

export function buildSelectionPrompt(action: "explain" | "translate", text: string): string {
  switch (action) {
    case "explain":
      return `请用通俗易懂的中文解读以下标准条款/段落，说明其要求、意义、与测试工作的关系，并指出可能相关的其他条款：\n\n${text}`;
    case "translate":
      return `请将以下标准文档内容翻译成中文，保持专业术语准确，并在首次出现关键术语时保留原文：\n\n${text}`;
    default:
      return text;
  }
}

export const ACTION_LABELS: Record<"explain" | "translate", string> = {
  explain: "解读",
  translate: "翻译",
};
