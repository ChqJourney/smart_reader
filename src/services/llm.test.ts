import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildSelectionPrompt,
  loadLlmConfig,
  saveLlmConfig,
  streamChatCompletion,
  LlmConfig,
} from "../services/llm";

const STORAGE_KEY = "standardread-llm-config";

describe("llm service", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("loadLlmConfig", () => {
    it("returns default config when localStorage is empty", () => {
      const config = loadLlmConfig();
      expect(config).toEqual({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        model: "gpt-4o-mini",
      });
    });

    it("parses stored config", () => {
      const stored: LlmConfig = {
        baseUrl: "https://custom.example.com",
        apiKey: "sk-test",
        model: "gpt-4",
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));

      expect(loadLlmConfig()).toEqual(stored);
    });

    it("falls back to defaults on partial stored config", () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ apiKey: "partial" }));

      const config = loadLlmConfig();

      expect(config).toEqual({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "partial",
        model: "gpt-4o-mini",
      });
    });
  });

  describe("saveLlmConfig", () => {
    it("stores config in localStorage", () => {
      const config: LlmConfig = {
        baseUrl: "https://api.example.com",
        apiKey: "key",
        model: "model",
      };

      saveLlmConfig(config);

      expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(config));
    });
  });

  describe("buildSelectionPrompt", () => {
    it("builds explain prompt in Chinese", () => {
      const prompt = buildSelectionPrompt("explain", "Sample text");
      expect(prompt).toContain("Sample text");
      expect(prompt).toContain("解读");
    });

    it("builds translate prompt in Chinese", () => {
      const prompt = buildSelectionPrompt("translate", "Sample text");
      expect(prompt).toContain("Sample text");
      expect(prompt).toContain("翻译");
    });

    it("returns text for unknown action", () => {
      const prompt = buildSelectionPrompt("unknown" as any, "Sample text");
      expect(prompt).toBe("Sample text");
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
