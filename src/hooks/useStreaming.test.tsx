import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useStreaming } from "./useStreaming";
import type { ChatMessage } from "../services/llm";

vi.mock("../services/llm", async () => {
  const actual =
    await vi.importActual<typeof import("../services/llm")>("../services/llm");
  return {
    ...actual,
    streamChatCompletion: vi.fn(),
  };
});

import { streamChatCompletion } from "../services/llm";

const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

function makeHandlers() {
  return {
    onChunk: vi.fn(),
    onError: vi.fn(),
    onDone: vi.fn(),
    onAbort: vi.fn(),
  };
}

describe("useStreaming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("正常结束后调用 onDone", async () => {
    vi.mocked(streamChatCompletion).mockImplementation(async function* () {
      yield { type: "chunk" as const, content: "hello" };
    });

    const { result } = renderHook(() => useStreaming());
    const handlers = makeHandlers();

    await result.current.run("k1", messages, handlers);

    expect(handlers.onChunk).toHaveBeenCalledWith("hello", "hello");
    expect(handlers.onDone).toHaveBeenCalledTimes(1);
    expect(handlers.onAbort).not.toHaveBeenCalled();
  });

  // 回归：abort 发生在「两次 chunk 之间」的空闲期时，真实 generator 被唤醒后
  // 不再 yield 任何事件直接结束（llm.ts 的 markFinished 路径），for-await
  // 循环体内的 aborted 检查永远执行不到。必须在循环结束后补触发 onAbort，
  // 否则调用方（agent loop 的 runOneRound）的 Promise 永不 settle。
  it("空闲期中止：generator 空退出时仍触发 onAbort 且 run 返回", async () => {
    vi.mocked(streamChatCompletion).mockImplementation(
      async function* (_messages, options) {
        // 模拟真实 generator 的空闲等待：直到 abort 才结束，且不 yield 事件。
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve());
        });
        return;
      }
    );

    const { result } = renderHook(() => useStreaming());
    const handlers = makeHandlers();

    let settled = false;
    const runPromise = result.current
      .run("k2", messages, handlers)
      .finally(() => {
        settled = true;
      });

    await waitFor(() => {
      expect(streamChatCompletion).toHaveBeenCalled();
    });

    result.current.abort("k2");
    await runPromise;

    expect(settled).toBe(true);
    expect(handlers.onAbort).toHaveBeenCalledTimes(1);
    expect(handlers.onDone).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it("事件到达后发现已中止：走循环体内 onAbort，不重复触发", async () => {
    vi.mocked(streamChatCompletion).mockImplementation(
      async function* (_messages, options) {
        yield { type: "chunk" as const, content: "first" };
        // 等到 abort 后再 yield 一个事件，让循环体内的 aborted 检查命中。
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve());
        });
        yield { type: "chunk" as const, content: "second" };
      }
    );

    const { result } = renderHook(() => useStreaming());
    const handlers = makeHandlers();

    const runPromise = result.current.run("k3", messages, handlers);

    await waitFor(() => {
      expect(handlers.onChunk).toHaveBeenCalledWith("first", "first");
    });

    result.current.abort("k3");
    await runPromise;

    expect(handlers.onAbort).toHaveBeenCalledTimes(1);
    expect(handlers.onDone).not.toHaveBeenCalled();
  });
});
