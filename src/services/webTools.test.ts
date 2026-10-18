import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockTauriInvoke } from "../test/mocks/tauri";

describe("webTools service", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function importService() {
    return import("../services/webTools");
  }

  it("formats search results as a numbered list", async () => {
    const invoke = mockTauriInvoke({
      web_tools_search: () => ({
        results: [
          {
            title: "IEC 62368-1:2023 published",
            url: "https://example.com/a",
            summary: "New edition released.",
            site_name: "Example",
            date: "2026-10-01T00:00:00Z",
          },
          { title: "Second", url: "https://example.com/b" },
        ],
      }),
    });
    const { executeWebToolCall } = await importService();
    const { summary, result } = await executeWebToolCall(
      "web_search",
      JSON.stringify({ query: "IEC 62368-1 latest edition" })
    );
    expect(invoke).toHaveBeenCalledWith("web_tools_search", {
      query: "IEC 62368-1 latest edition",
      count: 5,
      needContent: false,
    });
    expect(summary).toContain("IEC 62368-1 latest edition");
    expect(result).toContain('Search results for "IEC 62368-1 latest edition"');
    expect(result).toContain("1. IEC 62368-1:2023 published");
    expect(result).toContain("URL: https://example.com/a");
    expect(result).toContain("2026-10-01");
    expect(result).toContain("2. Second");
  });

  it("clamps count and passes need_content", async () => {
    const invoke = mockTauriInvoke({
      web_tools_search: () => ({ results: [] }),
    });
    const { executeWebToolCall } = await importService();
    const { result } = await executeWebToolCall(
      "web_search",
      JSON.stringify({ query: "q", count: 999, need_content: true })
    );
    expect(invoke).toHaveBeenCalledWith("web_tools_search", {
      query: "q",
      count: 50,
      needContent: true,
    });
    expect(result).toContain("No results found");
  });

  it("rejects empty query without calling the backend", async () => {
    const invoke = mockTauriInvoke({});
    const { executeWebToolCall } = await importService();
    const { result } = await executeWebToolCall(
      "web_search",
      JSON.stringify({ query: "  " })
    );
    expect(result).toBe("Error: query is required");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("turns backend search errors into result text", async () => {
    mockTauriInvoke({
      web_tools_search: () => {
        throw new Error("未配置 DeepSeek API Key");
      },
    });
    const { executeWebToolCall } = await importService();
    const { result } = await executeWebToolCall(
      "web_search",
      JSON.stringify({ query: "q" })
    );
    expect(result).toContain("未配置 DeepSeek API Key");
  });

  it("formats fetch results with title and url header", async () => {
    const invoke = mockTauriInvoke({
      web_tools_fetch: () => ({
        title: "Page Title",
        content: "Body text",
      }),
    });
    const { executeWebToolCall } = await importService();
    const { summary, result } = await executeWebToolCall(
      "web_fetch",
      JSON.stringify({ url: "https://example.com/page" })
    );
    expect(invoke).toHaveBeenCalledWith("web_tools_fetch", {
      url: "https://example.com/page",
    });
    expect(summary).toContain("https://example.com/page");
    expect(result).toBe(
      "# Page Title\nURL: https://example.com/page\n\nBody text"
    );
  });

  it("truncates overlong fetch content", async () => {
    mockTauriInvoke({
      web_tools_fetch: () => ({ title: "", content: "x".repeat(20000) }),
    });
    const { executeWebToolCall } = await importService();
    const { result } = await executeWebToolCall(
      "web_fetch",
      JSON.stringify({ url: "https://example.com/big" })
    );
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBeLessThan(13000);
  });

  it("rejects empty url without calling the backend", async () => {
    const invoke = mockTauriInvoke({});
    const { executeWebToolCall } = await importService();
    const { result } = await executeWebToolCall("web_fetch", "{}");
    expect(result).toBe("Error: url is required");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns an error result for invalid arguments JSON", async () => {
    const invoke = mockTauriInvoke({});
    const { executeWebToolCall } = await importService();
    const { result } = await executeWebToolCall("web_search", "{not json");
    expect(result).toContain("invalid arguments JSON");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns an error result for unknown tools", async () => {
    const { executeWebToolCall } = await importService();
    const { result } = await executeWebToolCall("nope", "{}");
    expect(result).toContain("unknown tool nope");
  });
});
