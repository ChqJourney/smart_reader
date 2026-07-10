import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildCustomInterpretPrompt,
  buildSelectionPrompt,
  buildSystemPrompt,
  streamChatCompletion,
  LlmConfig,
} from "../services/llm";

describe("llm service", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("buildSystemPrompt", () => {
    it("includes target language", () => {
      const prompt = buildSystemPrompt("English");
      expect(prompt).toContain("English");
      expect(prompt).toContain("检测认证");
    });
  });

  describe("buildSelectionPrompt", () => {
    it("builds explain prompt in target language", () => {
      const prompt = buildSelectionPrompt("explain", "Sample text", "中文");
      expect(prompt).toContain("Sample text");
      expect(prompt).toContain("解读");
      expect(prompt).toContain("中文");
    });

    it("builds translate prompt in target language", () => {
      const prompt = buildSelectionPrompt("translate", "Sample text", "English");
      expect(prompt).toContain("Sample text");
      expect(prompt).toContain("English");
    });

    it("returns text for unknown action", () => {
      const prompt = buildSelectionPrompt("unknown" as any, "Sample text", "中文");
      expect(prompt).toBe("Sample text");
    });
  });

  describe("buildCustomInterpretPrompt", () => {
    it("includes prompt, sources and target language", () => {
      const prompt = buildCustomInterpretPrompt(
        "解释这些片段",
        [
          { fileName: "a.pdf", page: 1, text: "text a" },
          { fileName: "b.pdf", page: 2, text: "text b" },
        ],
        "中文"
      );
      expect(prompt).toContain("解释这些片段");
      expect(prompt).toContain("text a");
      expect(prompt).toContain("text b");
      expect(prompt).toContain("中文");
    });
  });

  describe("streamChatCompletion", () => {
    const baseConfig: LlmConfig = {
      baseUrl: "https://api.example.com",
      apiKey: "sk-test",
      model: "gpt-4",
    };

    it("yields error when apiKey is missing", async () => {
      const gen = streamChatCompletion({ ...baseConfig, apiKey: "" }, []);
      const events = [];
      for await (const event of gen) {
        events.push(event);
      }

      expect(events).toEqual([
        {
          type: "error",
          message: "API Key 未配置，请先在设置中配置 LLM API。",
        },
      ]);
    });

    it("yields error when response is not ok", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });

      const events = [];
      for await (const event of streamChatCompletion(baseConfig, [])) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: "error", message: "LLM API 错误 (401): Unauthorized" },
      ]);
    });

    it("streams chunks from SSE response", async () => {
      const encoder = new TextEncoder();
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n',
        "data: [DONE]\n",
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: {
          getReader: () => {
            let i = 0;
            return {
              read: async () => {
                if (i < chunks.length) {
                  return { done: false, value: encoder.encode(chunks[i++]) };
                }
                return { done: true, value: undefined };
              },
            };
          },
        },
      });

      const events = [];
      for await (const event of streamChatCompletion(baseConfig, [])) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: "chunk", content: "Hello" },
        { type: "chunk", content: " world" },
      ]);
    });
  });
});
