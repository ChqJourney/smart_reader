import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import RecentFilesBar from "./RecentFilesBar";
import type { RecentFile } from "../services/recentFiles";

const mockInvoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

const files: RecentFile[] = [
  { path: "/docs/a.pdf", fileName: "a.pdf", openedAt: NOW - HOUR },
  { path: "/docs/b.pdf", fileName: "b.pdf", openedAt: NOW - 2 * HOUR },
];

function renderBar(
  overrides: Partial<Parameters<typeof RecentFilesBar>[0]> = {}
) {
  const props = {
    files,
    onFileClick: vi.fn(),
    onOpenInSplit: vi.fn(),
    onTogglePin: vi.fn(),
    onRemove: vi.fn(),
    onClear: vi.fn(),
    ...overrides,
  };
  render(<RecentFilesBar {...props} />);
  return props;
}

function openPanel() {
  fireEvent.click(screen.getByTestId("recent-files-trigger"));
}

describe("RecentFilesBar", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    // 默认环境没有 Tauri，invoke 失败时服务层会把所有文件视为存在
    mockInvoke.mockRejectedValue(new Error("no tauri"));
  });

  it("renders the trigger button and keeps the panel closed", () => {
    renderBar();
    expect(screen.getByLabelText("最近打开的文件")).toBeInTheDocument();
    expect(screen.queryByText("a.pdf")).not.toBeInTheDocument();
  });

  it("shows the empty hint when there are no files", () => {
    renderBar({ files: [] });
    openPanel();
    expect(screen.getByText("最近打开的文件将显示在这里")).toBeInTheDocument();
    expect(screen.queryByText("清空全部")).not.toBeInTheDocument();
  });

  it("lists files with meta info after opening the panel", () => {
    renderBar({
      files: [
        {
          path: "/standards/IEC/IEC 60335-1-2020.pdf",
          fileName: "IEC 60335-1-2020.pdf",
          openedAt: NOW - 3 * HOUR,
          lastPage: 47,
        },
      ],
    });
    openPanel();
    expect(screen.getByText("IEC 60335-1-2020.pdf")).toBeInTheDocument();
    expect(
      screen.getByText(/\/standards\/IEC · 3 小时前 · 读到第 47 页/)
    ).toBeInTheDocument();
  });

  it("opens a file on row click and closes the panel", () => {
    const props = renderBar();
    openPanel();
    fireEvent.click(screen.getByText("b.pdf"));
    expect(props.onFileClick).toHaveBeenCalledWith(files[1]);
    expect(screen.queryByText("a.pdf")).not.toBeInTheDocument();
  });

  it("groups pinned files under the pinned section", () => {
    renderBar({
      files: [
        { path: "/docs/a.pdf", fileName: "a.pdf", openedAt: NOW - HOUR },
        {
          path: "/docs/b.pdf",
          fileName: "b.pdf",
          openedAt: NOW - 2 * HOUR,
          pinned: true,
        },
      ],
    });
    openPanel();
    expect(screen.getByText("已固定")).toBeInTheDocument();
    expect(screen.getByText("最近")).toBeInTheDocument();
    // 固定条目排在更晚打开的未固定条目之前
    const rows = screen.getAllByRole("option");
    expect(rows[0]).toHaveTextContent("b.pdf");
    expect(rows[1]).toHaveTextContent("a.pdf");
  });

  it("toggles pin without opening the file", () => {
    const props = renderBar();
    openPanel();
    const pinButtons = screen.getAllByLabelText("固定到顶部");
    fireEvent.click(pinButtons[1]);
    expect(props.onTogglePin).toHaveBeenCalledWith("/docs/b.pdf");
    expect(props.onFileClick).not.toHaveBeenCalled();
  });

  it("removes a single file", () => {
    const props = renderBar();
    openPanel();
    const removeButtons = screen.getAllByLabelText("从列表中移除");
    fireEvent.click(removeButtons[0]);
    expect(props.onRemove).toHaveBeenCalledWith("/docs/a.pdf");
    expect(props.onFileClick).not.toHaveBeenCalled();
  });

  it("opens a file in split view via the split button", () => {
    const props = renderBar();
    openPanel();
    const splitButtons = screen.getAllByLabelText("在右侧并排打开");
    fireEvent.click(splitButtons[0]);
    expect(props.onOpenInSplit).toHaveBeenCalledWith(files[0]);
    expect(props.onFileClick).not.toHaveBeenCalled();
  });

  it("shows the side-by-side hint when split opening is available", () => {
    renderBar();
    openPanel();
    expect(screen.getByText(/拖拽标签到阅读区/)).toBeInTheDocument();
  });

  it("hides the side-by-side hint when split opening is unavailable", () => {
    renderBar({ onOpenInSplit: undefined });
    openPanel();
    expect(screen.queryByText(/拖拽标签到阅读区/)).not.toBeInTheDocument();
  });

  it("requires two clicks to clear all", () => {
    const props = renderBar();
    openPanel();
    const clearBtn = screen.getByText("清空全部");
    fireEvent.click(clearBtn);
    expect(props.onClear).not.toHaveBeenCalled();
    expect(screen.getByText("再次点击确认清空")).toBeInTheDocument();
    fireEvent.click(screen.getByText("再次点击确认清空"));
    expect(props.onClear).toHaveBeenCalled();
  });

  it("marks already-open files", () => {
    renderBar({ openFilePaths: ["/docs/a.pdf"] });
    openPanel();
    expect(screen.getByText("已打开")).toBeInTheDocument();
  });

  it("derives the display name from Windows paths", () => {
    renderBar({
      files: [
        {
          path: "C:\\Users\\Alice\\report.pdf",
          fileName: "report.pdf",
          openedAt: NOW,
        },
      ],
    });
    openPanel();
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(
      screen.getByTitle("C:\\Users\\Alice\\report.pdf")
    ).toBeInTheDocument();
  });

  it("filters files with the search box when the list is long", () => {
    const manyFiles = Array.from({ length: 9 }, (_, i) => ({
      path: `/docs/standard-${i}.pdf`,
      fileName: `standard-${i}.pdf`,
      openedAt: NOW - i * HOUR,
    }));
    renderBar({ files: manyFiles });
    openPanel();
    const input = screen.getByPlaceholderText("搜索文件名或路径…");
    fireEvent.change(input, { target: { value: "standard-7" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByText("standard-7.pdf")).toBeInTheDocument();
  });

  it("hides the search box for short lists", () => {
    renderBar();
    openPanel();
    expect(
      screen.queryByPlaceholderText("搜索文件名或路径…")
    ).not.toBeInTheDocument();
  });

  it("supports keyboard navigation and Enter to open", () => {
    const props = renderBar();
    openPanel();
    const panel = screen.getByRole("dialog");
    fireEvent.keyDown(panel, { key: "ArrowDown" });
    fireEvent.keyDown(panel, { key: "Enter" });
    expect(props.onFileClick).toHaveBeenCalledWith(files[1]);
  });

  it("opens the first match on Enter after filtering", () => {
    const manyFiles = Array.from({ length: 9 }, (_, i) => ({
      path: `/docs/standard-${i}.pdf`,
      fileName: `standard-${i}.pdf`,
      openedAt: NOW - i * HOUR,
    }));
    const props = renderBar({ files: manyFiles });
    openPanel();
    fireEvent.change(screen.getByPlaceholderText("搜索文件名或路径…"), {
      target: { value: "standard-5" },
    });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(props.onFileClick).toHaveBeenCalledWith(manyFiles[5]);
  });

  it("opens in split view with Alt+Enter", () => {
    const props = renderBar();
    openPanel();
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Enter",
      altKey: true,
    });
    expect(props.onOpenInSplit).toHaveBeenCalledWith(files[0]);
  });

  it("closes the panel with Escape", () => {
    renderBar();
    openPanel();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("greys out missing files and blocks opening them", async () => {
    mockInvoke.mockImplementation((command: string) => {
      if (command === "check_files_exist") {
        return Promise.resolve([false, true]);
      }
      return Promise.reject(new Error(`unexpected: ${command}`));
    });
    const props = renderBar();
    openPanel();
    await waitFor(() =>
      expect(screen.getByText("文件已移动或删除")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByText("a.pdf"));
    expect(props.onFileClick).not.toHaveBeenCalled();
    // 失效条目仍然可以移除
    fireEvent.click(screen.getAllByLabelText("从列表中移除")[0]);
    expect(props.onRemove).toHaveBeenCalledWith("/docs/a.pdf");
  });
});
