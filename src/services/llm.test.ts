import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  buildCustomInterpretPrompt,
  buildSelectionPrompt,
  buildSystemPrompt,
} from "../services/llm";
import type { ChatMessage, StreamEvent, SystemPrompts } from "../services/llm";

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
    it("builds explain prompt with document context and target language", () => {
      const prompt = buildSelectionPrompt("explain", "Sample text", "中文", {
        fileName: "IEC 60601-1.pdf",
        page: 42,
      });
      expect(prompt).toContain("Sample text");
      expect(prompt).toContain("解读");
      expect(prompt).toContain("中文");
      expect(prompt).toContain("IEC 60601-1.pdf");
      expect(prompt).toContain("42");
    });

    it("builds translate prompt with document context and target language", () => {
      const prompt = buildSelectionPrompt(
        "translate",
        "Sample text",
        "English",
        { fileName: "IEC 60601-1.pdf", page: 42 }
      );
      expect(prompt).toContain("Sample text");
      expect(prompt).toContain("English");
      expect(prompt).toContain("IEC 60601-1.pdf");
      expect(prompt).toContain("42");
    });

    it("returns text for unknown action", () => {
      const prompt = buildSelectionPrompt(
        "unknown" as any,
        "Sample text",
        "中文",
        { fileName: "a.pdf", page: 1 }
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

  // streamChatCompletion 通过 Tauri invoke + Channel 桥接后端流。下面的
  // 测试用 vi.doMock 替换 @tauri-apps/api/core（invoke + Channel），
  // 重点覆盖「后端停滞 / 命令异常时 generator 必须终止」的回归。
  describe("streamChatCompletion", () => {
    interface BackendChannel {
      onmessage: (msg: Record<string, unknown>) => void;
    }

    interface MockSetup {
      invoke: ReturnType<typeof vi.fn>;
    }

    /**
     * mock @tauri-apps/api/core 并动态 import llm 模块。
     * streamHandler 返回 chat_completions_stream 的 invoke 结果（Promise）。
     */
    async function setupStreamMock(
      streamHandler: (channel: BackendChannel) => Promise<unknown>
    ): Promise<
      MockSetup & {
        streamChatCompletion: typeof import("../services/llm").streamChatCompletion;
      }
    > {
      vi.resetModules();

      class MockChannel {
        onmessage: (msg: Record<string, unknown>) => void = () => {};
      }

      const invoke = vi.fn((command: string, args?: Record<string, any>) => {
        if (command === "chat_completions_stream") {
          const ch = args?.onEvent as unknown as BackendChannel;
          if (!ch) throw new Error("channel not provided");
          return streamHandler(ch);
        }
        if (command === "cancel_chat_completions") {
          return Promise.resolve();
        }
        return Promise.reject(new Error(`No mock handler for: ${command}`));
      });

      vi.doMock("@tauri-apps/api/core", () => ({
        invoke,
        Channel: MockChannel,
      }));

      const mod = await import("../services/llm");
      return { invoke, streamChatCompletion: mod.streamChatCompletion };
    }

    const sampleMessages: ChatMessage[] = [{ role: "user", content: "hi" }];

    async function collectEvents(
      gen: AsyncGenerator<StreamEvent, void>
    ): Promise<StreamEvent[]> {
      const events: StreamEvent[] = [];
      for await (const event of gen) {
        events.push(event);
      }
      return events;
    }

    it("yields chunk/usage/done events from the channel in order", async () => {
      const { streamChatCompletion } = await setupStreamMock((channel) => {
        // 后端行为：异步推送事件，最后发 done，然后命令返回。
        setTimeout(() => {
          channel.onmessage({ type: "chunk", content: "hello" });
          channel.onmessage({
            type: "usage",
            usage: {
              promptTokens: 1,
              completionTokens: 2,
              totalTokens: 3,
            },
          });
          channel.onmessage({ type: "done" });
        }, 0);
        return new Promise((resolve) => setTimeout(resolve, 5));
      });

      const events = await collectEvents(streamChatCompletion(sampleMessages));
      expect(events.map((e) => e.type)).toEqual(["chunk", "usage", "done"]);
    });

    it("terminates the generator on abort even when the stream stalls", async () => {
      // 停滞的后端：连接已建立但不再吐数据，invoke 永不 settle。
      const { invoke, streamChatCompletion } = await setupStreamMock(
        () => new Promise(() => {})
      );

      const controller = new AbortController();
      const gen = streamChatCompletion(sampleMessages, {
        signal: controller.signal,
      });

      const events: StreamEvent[] = [];
      const consume = (async () => {
        for await (const event of gen) {
          events.push(event);
        }
      })();

      // 等 generator 进入等待态（invoke 已发出）再中止。
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort();

      // generator 必须在不依赖后端的情况下结束。
      await consume;
      // 用户主动中止不产生 error 事件（由 useStreaming 的 aborted 检查兜底）。
      expect(events).toEqual([]);
      expect(invoke).toHaveBeenCalledWith("cancel_chat_completions", {
        requestId: expect.any(String),
      });
    });

    it("yields an error event instead of hanging when the invoke rejects", async () => {
      // 后端命令 panic / invoke 层直接失败：不会有任何 Channel 事件。
      const { streamChatCompletion } = await setupStreamMock(() =>
        Promise.reject(new Error("backend panic"))
      );

      const events = await collectEvents(streamChatCompletion(sampleMessages));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("error");
      expect((events[0] as { message: string }).message).toContain(
        "backend panic"
      );
    });
  });

  // Note: prompt-building functions above are pure and unit-tested directly.
});
