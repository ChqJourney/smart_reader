import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import RecentFilesBar from "./RecentFilesBar";

const files = [
  { path: "/docs/a.pdf", fileName: "a.pdf", openedAt: 1 },
  { path: "/docs/b.pdf", fileName: "b.pdf", openedAt: 2 },
];

describe("RecentFilesBar", () => {
  it("renders empty hint when no files", () => {
    render(
      <RecentFilesBar files={[]} onFileClick={vi.fn()} onClear={vi.fn()} />
    );
    expect(screen.getByText("最近打开的文件将显示在这里")).toBeInTheDocument();
    expect(screen.queryByLabelText("清空最近文件")).not.toBeInTheDocument();
  });

  it("renders file cards with names", () => {
    render(
      <RecentFilesBar files={files} onFileClick={vi.fn()} onClear={vi.fn()} />
    );
    expect(screen.getByText("a.pdf")).toBeInTheDocument();
    expect(screen.getByText("b.pdf")).toBeInTheDocument();
  });

  it("derives the display name from the path on Windows", () => {
    const windowsFiles = [
      {
        path: "C:\\Users\\Alice\\report.pdf",
        fileName: "report.pdf",
        openedAt: 1,
      },
    ];
    render(
      <RecentFilesBar
        files={windowsFiles}
        onFileClick={vi.fn()}
        onClear={vi.fn()}
      />
    );
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(
      screen.getByTitle("C:\\Users\\Alice\\report.pdf")
    ).toBeInTheDocument();
  });

  it("shows the full path on hover even when fileName is a path", () => {
    const staleFiles = [
      {
        path: "C:\\Users\\Alice\\report.pdf",
        fileName: "C:\\Users\\Alice\\report.pdf",
        openedAt: 1,
      },
    ];
    render(
      <RecentFilesBar
        files={staleFiles}
        onFileClick={vi.fn()}
        onClear={vi.fn()}
      />
    );
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(
      screen.getByTitle("C:\\Users\\Alice\\report.pdf")
    ).toBeInTheDocument();
  });

  it("calls onFileClick with file when card clicked", () => {
    const onClick = vi.fn();
    render(
      <RecentFilesBar files={files} onFileClick={onClick} onClear={vi.fn()} />
    );
    fireEvent.click(screen.getByText("b.pdf"));
    expect(onClick).toHaveBeenCalledWith(files[1]);
  });

  it("marks active file", () => {
    render(
      <RecentFilesBar
        files={files}
        activeFilePath={files[0].path}
        onFileClick={vi.fn()}
        onClear={vi.fn()}
      />
    );
    const cards = screen.getAllByRole("button", { name: /\.pdf$/ });
    expect(cards[0]).toHaveClass("active");
    expect(cards[1]).not.toHaveClass("active");
  });

  it("calls onClear when clear button clicked", () => {
    const onClear = vi.fn();
    render(
      <RecentFilesBar files={files} onFileClick={vi.fn()} onClear={onClear} />
    );
    fireEvent.click(screen.getByLabelText("清空最近文件"));
    expect(onClear).toHaveBeenCalled();
  });
});
