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

  it("renders a single running hint while tool calls are in progress", () => {
    render(
      <ToolCallsIndicator
        toolEvents={makeEvents([
          { name: "search_in_pdf", summary: "搜索 clause", status: "running" },
        ])}
        isStreaming={true}
      />
    );

    expect(document.querySelector(".tool-calls-spinner")).toBeInTheDocument();
    expect(
      screen.getByText(/正在查阅文档|Looking up documents/)
    ).toBeInTheDocument();
    // 运行时不展开每个调用详情
    expect(document.querySelector(".tool-calls-list")).not.toBeInTheDocument();
    expect(screen.queryByText("搜索 clause")).not.toBeInTheDocument();
  });

  it("renders a single running hint for mixed running and done states", () => {
    render(
      <ToolCallsIndicator
        toolEvents={makeEvents([
          { name: "search_in_pdf", summary: "搜索 a", status: "done" },
          { name: "read_pdf_page", summary: "读取第 5 页", status: "running" },
        ])}
        isStreaming={true}
      />
    );

    expect(
      screen.getByText(/正在查阅文档|Looking up documents/)
    ).toBeInTheDocument();
    expect(document.querySelector(".tool-calls-list")).not.toBeInTheDocument();
    expect(screen.queryByText("搜索 a")).not.toBeInTheDocument();
    expect(screen.queryByText("读取第 5 页")).not.toBeInTheDocument();
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
});
