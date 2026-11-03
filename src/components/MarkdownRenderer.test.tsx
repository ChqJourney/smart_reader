import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import MarkdownRenderer from "./MarkdownRenderer";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  save: vi.fn(),
  copyToClipboard: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));
vi.mock("../utils/clipboard", () => ({
  copyToClipboard: mocks.copyToClipboard,
}));

describe("MarkdownRenderer", () => {
  beforeEach(() => {
    mocks.invoke.mockReset().mockResolvedValue(undefined);
    mocks.save.mockReset();
    mocks.copyToClipboard.mockReset().mockResolvedValue(undefined);
  });

  it("renders plain paragraphs", () => {
    render(<MarkdownRenderer content={`第一段\n\n第二段`} />);
    expect(screen.getByText("第一段")).toBeInTheDocument();
    expect(screen.getByText("第二段")).toBeInTheDocument();
  });

  it("renders GFM tables in a horizontal scroll container", () => {
    const content = `| 项目 | 值 |
|------|-----|
| A | 1 |
| B | 2 |`;
    render(<MarkdownRenderer content={content} />);
    expect(screen.getByText("项目")).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(document.querySelector(".markdown-table-scroll table")).toHaveClass(
      "markdown-table"
    );
  });

  it("expands a table into a dialog and closes it", () => {
    render(
      <MarkdownRenderer content={"| 项目 | 值 |\n|------|-----|\n| A | 1 |"} />
    );
    fireEvent.click(screen.getByRole("button", { name: "展开表格" }));

    const dialog = screen.getByRole("dialog", { name: "表格详情" });
    expect(within(dialog).getByText("项目")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders inline code and fenced code blocks", () => {
    const content = `使用 \`npm install\` 安装。\n\n\`\`\`\ncode line\n\`\`\``;
    render(<MarkdownRenderer content={content} />);
    expect(screen.getByText("npm install")).toBeInTheDocument();
    const pre = document.querySelector(".markdown-content pre");
    expect(pre).toBeInTheDocument();
    expect(pre?.textContent).toContain("code line");
  });

  it("renders task lists", () => {
    render(<MarkdownRenderer content={`- [x] 完成\n- [ ] 未完成`} />);
    expect(screen.getByText("完成")).toBeInTheDocument();
    expect(screen.getByText("未完成")).toBeInTheDocument();
  });

  it("renders KaTeX inline math", () => {
    render(<MarkdownRenderer content="能量公式 $E = mc^2$" />);
    const container = document.querySelector(".markdown-content");
    expect(container?.querySelector(".katex")).toBeInTheDocument();
  });

  it("renders KaTeX block math", () => {
    render(<MarkdownRenderer content="$$\\int_a^b f(x) dx$$" />);
    const container = document.querySelector(".markdown-content");
    expect(container?.querySelector(".katex")).toBeInTheDocument();
  });

  it("renders raw SVG in a preview card", () => {
    const content = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <circle cx="50" cy="50" r="40" fill="red" />
    </svg>`;
    render(<MarkdownRenderer content={content} />);
    const card = document.querySelector(".markdown-svg-card");
    expect(card).toBeInTheDocument();
    expect(card?.querySelector("svg circle")).toBeInTheDocument();
  });

  it("renders a closed SVG fence as a preview", () => {
    const content = `\`\`\`svg
<svg viewBox="0 0 100 100"><rect width="100" height="100" /></svg>
\`\`\``;
    render(<MarkdownRenderer content={content} />);
    expect(
      document.querySelector(".markdown-svg-card .markdown-svg-stage rect")
    ).toBeInTheDocument();
  });

  it("keeps an incomplete streaming SVG fence in source mode until closed", async () => {
    const incomplete = `\`\`\`svg
<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" /></svg>`;
    const { rerender } = render(<MarkdownRenderer content={incomplete} />);

    expect(screen.getByRole("button", { name: "预览" })).toBeDisabled();
    expect(document.querySelector(".markdown-svg-source")).toHaveTextContent(
      "<circle"
    );
    expect(document.querySelector(".markdown-svg-stage")).toBeNull();

    rerender(<MarkdownRenderer content={`${incomplete}\n\`\`\``} />);
    await waitFor(() =>
      expect(
        document.querySelector(".markdown-svg-card .markdown-svg-stage circle")
      ).toBeInTheDocument()
    );
  });

  it("switches a raw SVG between preview and source", () => {
    render(
      <MarkdownRenderer content='<svg viewBox="0 0 10 10"><path d="M0 0L10 10" /></svg>' />
    );
    fireEvent.click(screen.getByRole("button", { name: "源代码" }));
    expect(document.querySelector(".markdown-svg-source")).toHaveTextContent(
      "<svg"
    );

    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    expect(
      document.querySelector(".markdown-svg-stage path")
    ).toBeInTheDocument();
  });

  it("copies the sanitized SVG rather than unsafe source markup", async () => {
    render(
      <MarkdownRenderer content='<svg onload="alert(1)"><script>alert(1)</script><circle cx="5" cy="5" r="4" /></svg>' />
    );
    fireEvent.click(screen.getByRole("button", { name: "复制 SVG" }));

    await waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledOnce());
    const copied = mocks.copyToClipboard.mock.calls[0][0] as string;
    expect(copied).toContain("<circle");
    expect(copied).not.toContain("script");
    expect(copied).not.toContain("onload");
  });

  it("exports SVG through the system save dialog", async () => {
    mocks.save.mockResolvedValue("/tmp/diagram.svg");
    render(
      <MarkdownRenderer content={'```svg\n<svg><circle r="4" /></svg>\n```'} />
    );
    fireEvent.click(screen.getByRole("button", { name: "下载 SVG" }));

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("export_text_file", {
        filePath: "/tmp/diagram.svg",
        content: expect.stringContaining("<circle"),
      })
    );
  });

  it("expands an SVG into a dialog", () => {
    render(<MarkdownRenderer content='<svg><circle r="4" /></svg>' />);
    fireEvent.click(screen.getByRole("button", { name: "放大 SVG" }));
    expect(screen.getByRole("dialog", { name: "SVG 图" })).toBeInTheDocument();
    expect(
      document.querySelectorAll(
        ".markdown-svg-stage svg, .markdown-svg-dialog-stage svg"
      )
    ).toHaveLength(2);
  });

  it("opens links in a new tab", () => {
    render(<MarkdownRenderer content="[链接](https://example.com)" />);
    const link = screen.getByRole("link", { name: "链接" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});
