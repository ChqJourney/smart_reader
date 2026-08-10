import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ToolCallsIndicator from "./ToolCallsIndicator";
import { ToolEvent } from "../services/sessions";

function makeEvents(overrides: Partial<ToolEvent>[] = [{}]): ToolEvent[] {
  return overrides.map((o, i) => ({
    name: o.name ?? "search_in_pdf",
    summary: o.summary ?? `搜索 query-${i}`,
    status: o.status ?? "running",
  }));
}

describe("ToolCallsIndicator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when there are no tool events", () => {
    const { container } = render(
      <ToolCallsIndicator toolEvents={[]} isStreaming={false} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("auto-expands the call list while streaming before final content", () => {
    render(
      <ToolCallsIndicator
        toolEvents={makeEvents([
          { name: "search_in_pdf", summary: "搜索 clause", status: "done" },
          { name: "read_pdf_page", summary: "读取第 5 页", status: "running" },
        ])}
        isStreaming={true}
      />
    );

    // 头部仍是运行中提示
    expect(
      screen.getByText(/正在查阅文档|Looking up documents/)
    ).toBeInTheDocument();
    // 运行中展开全部调用明细（同一气泡内）
    expect(document.querySelector(".tool-calls-list")).toBeInTheDocument();
    expect(screen.getByText("搜索 clause")).toBeInTheDocument();
    expect(screen.getByText("读取第 5 页")).toBeInTheDocument();
    // 运行中的条目显示 spinner
    expect(document.querySelector(".tool-calls-spinner")).toBeInTheDocument();
  });

  it("collapses to a summary once final content starts streaming", () => {
    render(
      <ToolCallsIndicator
        toolEvents={makeEvents([
          { name: "search_in_pdf", summary: "搜索 clause", status: "done" },
        ])}
        isStreaming={true}
        hasFinalContent={true}
      />
    );

    expect(screen.getByText(/查阅了|Looked up/)).toBeInTheDocument();
    expect(document.querySelector(".tool-calls-list")).not.toBeInTheDocument();
    expect(screen.queryByText("搜索 clause")).not.toBeInTheDocument();
  });

  it("renders a collapsible summary when all calls are done", () => {
    render(
      <ToolCallsIndicator
        toolEvents={makeEvents([
          { name: "search_in_pdf", summary: "搜索 a", status: "done" },
          { name: "read_pdf_page", summary: "读取第 5 页", status: "done" },
        ])}
        isStreaming={false}
      />
    );

    expect(screen.getByText(/查阅了|Looked up/)).toBeInTheDocument();
    expect(document.querySelector(".tool-calls-summary")).toBeInTheDocument();
    expect(document.querySelector(".tool-calls-list")).not.toBeInTheDocument();
  });

  it("expands and collapses the call list on summary click", () => {
    render(
      <ToolCallsIndicator
        toolEvents={makeEvents([
          { name: "search_in_pdf", summary: "搜索 a", status: "done" },
        ])}
        isStreaming={false}
      />
    );

    expect(document.querySelector(".tool-calls-list")).not.toBeInTheDocument();

    fireEvent.click(document.querySelector(".tool-calls-summary")!);
    expect(document.querySelector(".tool-calls-list")).toBeInTheDocument();
    expect(screen.getByText("搜索 a")).toBeInTheDocument();

    fireEvent.click(document.querySelector(".tool-calls-summary")!);
    expect(document.querySelector(".tool-calls-list")).not.toBeInTheDocument();
  });

  it("manual collapse wins over auto-expand while streaming", () => {
    render(
      <ToolCallsIndicator
        toolEvents={makeEvents([
          { name: "search_in_pdf", summary: "搜索 a", status: "running" },
        ])}
        isStreaming={true}
      />
    );

    // 自动展开中，点击后收拢
    expect(document.querySelector(".tool-calls-list")).toBeInTheDocument();
    fireEvent.click(document.querySelector(".tool-calls-summary")!);
    expect(document.querySelector(".tool-calls-list")).not.toBeInTheDocument();
  });
});
