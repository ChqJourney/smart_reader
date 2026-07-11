import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import MarkdownRenderer from "./MarkdownRenderer";

describe("MarkdownRenderer", () => {
  it("renders plain paragraphs", () => {
    render(
      <MarkdownRenderer
        content={`第一段\n\n第二段`}
      />
    );
    expect(screen.getByText("第一段")).toBeInTheDocument();
    expect(screen.getByText("第二段")).toBeInTheDocument();
  });

  it("renders GFM tables", () => {
    const content = `| 项目 | 值 |
|------|-----|
| A | 1 |
| B | 2 |`;
    render(<MarkdownRenderer content={content} />);
    expect(screen.getByText("项目")).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
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
    render(
      <MarkdownRenderer
        content={`- [x] 完成\n- [ ] 未完成`}
      />
    );
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

  it("renders raw SVG", () => {
    const content = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <circle cx="50" cy="50" r="40" fill="red" />
    </svg>`;
    render(<MarkdownRenderer content={content} />);
    const svg = document.querySelector(".markdown-content svg");
    expect(svg).toBeInTheDocument();
    expect(svg?.querySelector("circle")).toBeInTheDocument();
  });

  it("opens links in a new tab", () => {
    render(<MarkdownRenderer content="[链接](https://example.com)" />);
    const link = screen.getByRole("link", { name: "链接" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});
