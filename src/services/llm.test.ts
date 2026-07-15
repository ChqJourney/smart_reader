import { describe, it, expect, beforeEach } from "vitest";
import {
  buildCustomInterpretPrompt,
  buildSelectionPrompt,
  buildSystemPrompt,
} from "../services/llm";
import type { SystemPrompts } from "../services/llm";

const sampleSystemPrompts: SystemPrompts = {
  translate: "Translate to {targetLanguage}.",
  explain: "Explain in {targetLanguage}.",
};

describe("llm service", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("buildSystemPrompt", () => {
    it("uses translate prompt for translate action", () => {
      const prompt = buildSystemPrompt(
        "translate",
        "English",
        sampleSystemPrompts
      );
      expect(prompt).toBe("Translate to English.");
    });

    it("uses explain prompt for explain and custom actions", () => {
      const explain = buildSystemPrompt("explain", "中文", sampleSystemPrompts);
      const custom = buildSystemPrompt("custom", "中文", sampleSystemPrompts);
      expect(explain).toBe("Explain in 中文.");
      expect(custom).toBe("Explain in 中文.");
    });

    it("replaces all targetLanguage placeholders", () => {
      const prompt = buildSystemPrompt("translate", "English", {
        translate: "Use {targetLanguage} and only {targetLanguage}.",
        explain: "Explain.",
      });
      expect(prompt).toBe("Use English and only English.");
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
      const prompt = buildSelectionPrompt(
        "translate",
        "Sample text",
        "English"
      );
      expect(prompt).toContain("Sample text");
      expect(prompt).toContain("English");
    });

    it("returns text for unknown action", () => {
      const prompt = buildSelectionPrompt(
        "unknown" as any,
        "Sample text",
        "中文"
      );
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

  // Note: streamChatCompletion now uses Tauri invoke + Channel (bypasses webview
  // fetch entirely). Unit testing it requires mocking the Tauri runtime, which
  // is better covered by E2E tests with the real backend. The prompt-building
  // functions above remain unit-tested.
});
