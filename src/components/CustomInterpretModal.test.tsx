import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import CustomInterpretModal from "../components/CustomInterpretModal";
import { StashItem, StashSource } from "../services/stash";

function makeSource(overrides: Partial<StashSource> = {}): StashSource {
  return {
    tabId: "tab-1",
    fileName: "file.pdf",
    filePath: "/path/to/file.pdf",
    fileHash: "hash-file",
    page: 3,
    pdfX: 100,
    pdfY: 200,
    ...overrides,
  };
}

function makeStash(
  id: string,
  text: string,
  overrides: Partial<StashItem> = {}
): StashItem {
  return {
    id,
    source: makeSource(),
    text,
    createdAt: 1000,
    ...overrides,
  };
}

describe("CustomInterpretModal", () => {
  it("renders stash checklist, prompt input and action buttons", () => {
    const stashes = [
      makeStash("stash-1", "first excerpt"),
      makeStash("stash-2", "second excerpt"),
    ];
    render(
      <CustomInterpretModal
        stashes={stashes}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText(/自定义解读/)).toBeInTheDocument();
    // 默认全选
    expect(screen.getByText(/基于 2 个选中片段/)).toBeInTheDocument();
    expect(screen.getByText(/first excerpt/)).toBeInTheDocument();
    expect(screen.getByText(/second excerpt/)).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getByPlaceholderText(/输入你的解读要求/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /发送/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /取消/i })).toBeInTheDocument();
  });

  it("calls onSubmit with trimmed prompt and all stashes by default", () => {
    const onSubmit = vi.fn();
    const stashes = [makeStash("stash-1", "text")];
    render(
      <CustomInterpretModal
        stashes={stashes}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText(/输入你的解读要求/);
    fireEvent.change(input, { target: { value: "  请分析关系  " } });
    fireEvent.click(screen.getByRole("button", { name: /发送/i }));

    expect(onSubmit).toHaveBeenCalledWith("请分析关系", stashes);
  });

  it("submits only checked stashes after unchecking", () => {
    const onSubmit = vi.fn();
    const stashes = [
      makeStash("stash-1", "first excerpt"),
      makeStash("stash-2", "second excerpt"),
    ];
    render(
      <CustomInterpretModal
        stashes={stashes}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />
    );

    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[1]);
    expect(screen.getByText(/基于 1 个选中片段/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/输入你的解读要求/), {
      target: { value: "请分析" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/i }));

    expect(onSubmit).toHaveBeenCalledWith("请分析", [stashes[0]]);
  });

  it("honors initialSelectedIds over select-all", () => {
    const onSubmit = vi.fn();
    const stashes = [
      makeStash("stash-1", "first excerpt"),
      makeStash("stash-2", "second excerpt"),
    ];
    render(
      <CustomInterpretModal
        stashes={stashes}
        initialSelectedIds={new Set(["stash-2"])}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText(/基于 1 个选中片段/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/输入你的解读要求/), {
      target: { value: "请分析" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/i }));

    expect(onSubmit).toHaveBeenCalledWith("请分析", [stashes[1]]);
  });

  it("disables submit when nothing is selected", () => {
    const stashes = [makeStash("stash-1", "text")];
    render(
      <CustomInterpretModal
        stashes={stashes}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByPlaceholderText(/输入你的解读要求/), {
      target: { value: "请分析" },
    });

    expect(screen.getByRole("button", { name: /发送/i })).toBeDisabled();
  });

  it("does not submit when prompt is empty", () => {
    const onSubmit = vi.fn();
    render(
      <CustomInterpretModal
        stashes={[makeStash("stash-1", "text")]}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /发送/i }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onClose when clicking cancel", () => {
    const onClose = vi.fn();
    render(
      <CustomInterpretModal
        stashes={[makeStash("stash-1", "text")]}
        onSubmit={vi.fn()}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /取消/i }));

    expect(onClose).toHaveBeenCalled();
  });

  it("does not close when clicking the overlay", () => {
    const onClose = vi.fn();
    const { container } = render(
      <CustomInterpretModal
        stashes={[makeStash("stash-1", "text")]}
        onSubmit={vi.fn()}
        onClose={onClose}
      />
    );

    fireEvent.click(container.querySelector(".modal-overlay")!);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close on Escape key", () => {
    const onClose = vi.fn();
    render(
      <CustomInterpretModal
        stashes={[makeStash("stash-1", "text")]}
        onSubmit={vi.fn()}
        onClose={onClose}
      />
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("submits on Enter key", () => {
    const onSubmit = vi.fn();
    const stashes = [makeStash("stash-1", "text")];
    render(
      <CustomInterpretModal
        stashes={stashes}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText(/输入你的解读要求/);
    fireEvent.change(input, { target: { value: "追问" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("追问", stashes);
  });

  it("focuses the prompt textarea on open (not the first checkbox)", () => {
    render(
      <CustomInterpretModal
        stashes={[makeStash("stash-1", "text")]}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(document.activeElement).toBe(
      screen.getByPlaceholderText(/输入你的解读要求/)
    );
  });

  it("keeps textarea focus when the parent re-renders with a new onClose identity", () => {
    // 回归：App 传的是内联 onClose（每次渲染新引用）。修复前 useModal 的
    // effect 依赖 onClose，App 任意重渲染（流式会话更新、updater 回调等）都会
    // 让 effect 重跑——cleanup 把焦点还给弹窗外元素、新 run 把焦点抢到首个
    // checkbox，导致输入中焦点跑掉（Windows 上表现为无法输入）。
    const stashes = [makeStash("stash-1", "text")];
    const { rerender } = render(
      <CustomInterpretModal
        stashes={stashes}
        onSubmit={vi.fn()}
        onClose={() => {}}
      />
    );

    const textarea = screen.getByPlaceholderText(/输入你的解读要求/);
    expect(document.activeElement).toBe(textarea);

    rerender(
      <CustomInterpretModal
        stashes={stashes}
        onSubmit={vi.fn()}
        onClose={() => {}}
      />
    );

    expect(document.activeElement).toBe(textarea);
  });

  it("does not submit on Enter while IME composition is active", () => {
    const onSubmit = vi.fn();
    const stashes = [makeStash("stash-1", "text")];
    render(
      <CustomInterpretModal
        stashes={stashes}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText(/输入你的解读要求/);
    fireEvent.change(input, { target: { value: "请分析" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("fills the textarea with the preset prompt when a preset is selected", () => {
    const onSubmit = vi.fn();
    const stashes = [makeStash("stash-1", "text")];
    render(
      <CustomInterpretModal
        stashes={stashes}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "自由提问" }));
    fireEvent.click(
      screen.getByRole("option", { name: "提炼测试要求与判定准则" })
    );

    const input = screen.getByPlaceholderText(/输入你的解读要求/);
    expect(input).toHaveValue(
      "请从选中片段中提炼所有可执行的测试要求及其判定准则，按条款逐条列出，并注明原文出处。"
    );

    // 预设填入后可直接发送
    fireEvent.click(screen.getByRole("button", { name: /发送/i }));
    expect(onSubmit).toHaveBeenCalledWith(
      "请从选中片段中提炼所有可执行的测试要求及其判定准则，按条款逐条列出，并注明原文出处。",
      stashes
    );
  });

  it("flips the select back to custom when the preset text is edited", () => {
    render(
      <CustomInterpretModal
        stashes={[makeStash("stash-1", "text")]}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "自由提问" }));
    fireEvent.click(screen.getByRole("option", { name: "总结要点" }));
    expect(
      screen.getByRole("button", { name: "总结要点" })
    ).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/输入你的解读要求/), {
      target: { value: "改过的要求" },
    });
    expect(
      screen.getByRole("button", { name: "自由提问" })
    ).toBeInTheDocument();
  });
});
