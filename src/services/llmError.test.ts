import { describe, it, expect, vi } from "vitest";

vi.mock("../services/logs", () => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}));

import { llmErrorToMessage } from "./llmError";
import { warn } from "../services/logs";

describe("llmErrorToMessage", () => {
  it("returns friendly Chinese for each error kind", () => {
    expect(llmErrorToMessage({ kind: "network", detail: "ECONNREFUSED" })).toBe(
      "网络无法连接。请检查网络连接后重试。"
    );
    expect(
      llmErrorToMessage({ kind: "auth", detail: "Incorrect API key provided" })
    ).toContain("密钥无效或未授权");
    expect(
      llmErrorToMessage({
        kind: "modelNotFound",
        model: "gpt-x",
        detail: "model not found",
      })
    ).toContain("gpt-x");
    expect(
      llmErrorToMessage({
        kind: "rateLimit",
        retryAfter: null,
        detail: "too many requests",
      })
    ).toContain("限流");
    expect(
      llmErrorToMessage({
        kind: "contextLengthExceeded",
        limit: 100,
        requested: 200,
        detail: "too long",
      })
    ).toContain("上下文长度");
    expect(
      llmErrorToMessage({
        kind: "serverError",
        status: 500,
        detail: "internal",
      })
    ).toContain("500");
    expect(
      llmErrorToMessage({ kind: "streamInterrupted", partialContent: "x" })
    ).toContain("中断");
    expect(
      llmErrorToMessage({
        kind: "invalidConfig",
        field: "baseUrl",
        detail: "bad url",
      })
    ).toContain("baseUrl");
    expect(
      llmErrorToMessage({
        kind: "toolError",
        toolName: "read_pdf_page",
        detail: "boom",
      })
    ).toContain("read_pdf_page");
    expect(
      llmErrorToMessage({ kind: "unknown", status: 0, body: "weird" })
    ).toBe("请求失败，请稍后重试。");
  });

  it("never leaks raw backend detail into the UI message", () => {
    const raw = "Incorrect API key provided: sk-abc123";
    const message = llmErrorToMessage({ kind: "auth", detail: raw });
    expect(message).not.toContain(raw);
    expect(message).not.toContain("sk-abc123");
  });

  it("logs the raw error for troubleshooting", () => {
    const err = { kind: "network" as const, detail: "ECONNREFUSED" };
    llmErrorToMessage(err);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
  });
});
