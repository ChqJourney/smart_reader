import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ShortcutsModal from "./ShortcutsModal";

describe("ShortcutsModal", () => {
  it("renders dialog with all shortcut groups", () => {
    render(<ShortcutsModal onClose={() => {}} />);
    expect(
      screen.getByRole("dialog", { name: "键盘快捷键" })
    ).toBeInTheDocument();
    expect(screen.getByText("页面导航")).toBeInTheDocument();
    expect(screen.getByText("搜索")).toBeInTheDocument();
    expect(screen.getByText("视图")).toBeInTheDocument();
    expect(screen.getByText("面板与窗口")).toBeInTheDocument();
  });

  it("lists key rows with kbd tokens", () => {
    render(<ShortcutsModal onClose={() => {}} />);
    expect(screen.getByText("跳转到指定页")).toBeInTheDocument();
    expect(screen.getByText("全文搜索")).toBeInTheDocument();
    expect(screen.getByText("最近文件面板")).toBeInTheDocument();
    expect(screen.getByText("显示本快捷键列表")).toBeInTheDocument();
    // Ctrl/Cmd 出现在多条组合键中
    expect(screen.getAllByText("Ctrl/Cmd").length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText("PageUp")).toBeInTheDocument();
    expect(screen.getByText("滚轮")).toBeInTheDocument();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<ShortcutsModal onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes via the close button", () => {
    const onClose = vi.fn();
    render(<ShortcutsModal onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
