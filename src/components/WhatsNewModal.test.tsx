import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import WhatsNewModal from "./WhatsNewModal";

// MarkdownRenderer 是 lazy 加载的重组件（react-markdown + katex），
// 这里只验证内容透传，不测试 markdown 渲染本身。
vi.mock("./MarkdownRenderer", () => ({
  default: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

describe("WhatsNewModal", () => {
  it("渲染标题与 markdown 正文", async () => {
    render(
      <WhatsNewModal
        title="本次更新内容（v1.4.0）"
        content={"### Added\n\n- 新功能"}
        onClose={() => {}}
      />
    );
    expect(screen.getByText("本次更新内容（v1.4.0）")).toBeInTheDocument();
    expect(await screen.findByTestId("markdown")).toHaveTextContent("新功能");
  });

  it("无主操作时点「知道了」关闭", async () => {
    const onClose = vi.fn();
    render(<WhatsNewModal title="t" content="c" onClose={onClose} />);
    await screen.findByTestId("markdown");
    fireEvent.click(screen.getByText("知道了"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("有主操作时显示「稍后」与主操作按钮", async () => {
    const onClose = vi.fn();
    const onUpgrade = vi.fn();
    render(
      <WhatsNewModal
        title="发现新版本 1.5.0"
        content="c"
        onClose={onClose}
        primaryAction={{ label: "马上升级", onClick: onUpgrade }}
      />
    );
    await screen.findByTestId("markdown");
    fireEvent.click(screen.getByText("马上升级"));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("稍后"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("右上角关闭按钮触发 onClose", async () => {
    const onClose = vi.fn();
    render(<WhatsNewModal title="t" content="c" onClose={onClose} />);
    await screen.findByTestId("markdown");
    fireEvent.click(screen.getByLabelText("关闭"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
