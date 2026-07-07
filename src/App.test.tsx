import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import App from "./App";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("./components/PdfViewer", () => ({
  default: React.forwardRef(({ onToggleVisibility }: { onToggleVisibility?: () => void }, ref: React.Ref<HTMLDivElement>) => (
    <div data-testid="pdf-viewer" ref={ref}>
      PdfViewer
      {onToggleVisibility && (
        <button title="隐藏 PDF 面板" onClick={onToggleVisibility}>隐藏</button>
      )}
    </div>
  )),
}));

describe("App", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    vi.clearAllMocks();
  });

  it("renders header and open button", () => {
    render(<App />);
    expect(screen.getByText("StandardRead AI")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open PDF/i })).toBeInTheDocument();
  });

  it("toggles left and right panels", () => {
    render(<App />);

    const hidePdfBtn = screen.getByTitle(/隐藏 PDF/i);
    fireEvent.click(hidePdfBtn);
    expect(screen.queryByTestId("pdf-viewer")).not.toBeInTheDocument();

    const showPdfBtn = screen.getByTitle(/显示 PDF/i);
    fireEvent.click(showPdfBtn);
    expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument();

    const hideAiBtn = screen.getByTitle(/隐藏面板/i);
    fireEvent.click(hideAiBtn);
    expect(screen.queryByText(/解读记录/i)).not.toBeInTheDocument();

    const showAiBtn = screen.getByTitle(/显示 AI 助手/i);
    fireEvent.click(showAiBtn);
    expect(screen.getByText(/解读记录/i)).toBeInTheDocument();
  });
});
