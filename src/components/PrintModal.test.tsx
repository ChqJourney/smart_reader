import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import PrintModal from "./PrintModal";

const defaultProps = {
  numPages: 10,
  currentPage: 3,
  onPrint: vi.fn().mockResolvedValue(undefined),
  onExport: vi.fn().mockResolvedValue(undefined),
  onClose: vi.fn(),
};

describe("PrintModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders with all pages and both annotation types enabled by default", () => {
    render(<PrintModal {...defaultProps} />);
    expect(screen.getByText("全部页（共 10 页）")).toBeInTheDocument();
    expect(screen.getByText("当前页（第 3 页）")).toBeInTheDocument();
    expect(screen.getByLabelText("翻译批注")).toBeChecked();
    expect(screen.getByLabelText("批注")).toBeChecked();
  });

  it("prints all pages with default options", async () => {
    render(<PrintModal {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: /^打印$/ }));
    await waitFor(() => expect(defaultProps.onPrint).toHaveBeenCalled());
    expect(defaultProps.onPrint).toHaveBeenCalledWith({
      includeTranslations: true,
      includeComments: true,
      pages: undefined,
    });
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("passes the current page when the current-page range is selected", async () => {
    render(<PrintModal {...defaultProps} />);
    fireEvent.click(screen.getByText("当前页（第 3 页）"));
    fireEvent.click(screen.getByRole("button", { name: /^打印$/ }));
    await waitFor(() => expect(defaultProps.onPrint).toHaveBeenCalled());
    expect(defaultProps.onPrint).toHaveBeenCalledWith({
      includeTranslations: true,
      includeComments: true,
      pages: [3],
    });
  });

  it("parses a custom range and disables actions while invalid", () => {
    render(<PrintModal {...defaultProps} />);
    fireEvent.click(screen.getByText("自定义范围"));

    const input = screen.getByPlaceholderText("如 1-3,5,8-9");
    fireEvent.change(input, { target: { value: "abc" } });
    expect(screen.getByText("页码范围格式不正确")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^打印$/ })).toBeDisabled();

    fireEvent.change(input, { target: { value: "1-2,4" } });
    expect(screen.getByRole("button", { name: /^打印$/ })).toBeEnabled();
  });

  it("forwards a parsed custom range to the action", async () => {
    render(<PrintModal {...defaultProps} />);
    fireEvent.click(screen.getByText("自定义范围"));
    fireEvent.change(screen.getByPlaceholderText("如 1-3,5,8-9"), {
      target: { value: "1-2,4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "导出 PDF" }));
    await waitFor(() => expect(defaultProps.onExport).toHaveBeenCalled());
    expect(defaultProps.onExport).toHaveBeenCalledWith({
      includeTranslations: true,
      includeComments: true,
      pages: [1, 2, 4],
    });
  });

  it("shows a friendly error when the action fails and stays open", async () => {
    const onPrint = vi.fn().mockRejectedValue(new Error("boom"));
    render(<PrintModal {...defaultProps} onPrint={onPrint} />);
    fireEvent.click(screen.getByRole("button", { name: /^打印$/ }));
    expect(
      await screen.findByText("生成打印文件失败，请查看日志")
    ).toBeInTheDocument();
    expect(defaultProps.onClose).not.toHaveBeenCalled();
  });
});
