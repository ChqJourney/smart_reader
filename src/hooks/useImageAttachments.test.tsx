import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useImageAttachments } from "./useImageAttachments";
import {
  normalizeImage,
  normalizeImageFile,
  pickImagePaths,
  readUserImageBytes,
} from "../services/imageAttachments";
import { showMessage } from "../services/dialog";

vi.mock("../services/imageAttachments", async () => {
  const actual = await vi.importActual<
    typeof import("../services/imageAttachments")
  >("../services/imageAttachments");
  return {
    ...actual,
    pickImagePaths: vi.fn(),
    readUserImageBytes: vi.fn(),
    normalizeImage: vi.fn(),
    normalizeImageFile: vi.fn(),
  };
});

vi.mock("../services/dialog", () => ({
  showMessage: vi.fn(() => Promise.resolve()),
}));

vi.mock("../services/logs", () => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

const revokeSpy = vi.fn();

beforeAll(() => {
  // jsdom 未实现 object URL：hook 只 revoke（创建由被 mock 的 normalize 返回）
  URL.revokeObjectURL = revokeSpy;
});

function mockDialogPick(paths: string[]) {
  vi.mocked(pickImagePaths).mockResolvedValue(paths);
  vi.mocked(readUserImageBytes).mockResolvedValue(new Uint8Array([1]));
  vi.mocked(normalizeImage).mockImplementation(async () => ({
    data: new Uint8Array([1]),
    previewUrl: `blob:${crypto.randomUUID()}`,
  }));
}

describe("useImageAttachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("addFromDialog 归一化并追加图片", async () => {
    mockDialogPick(["/a.png", "/b.jpg"]);
    const { result } = renderHook(() => useImageAttachments());

    await act(async () => {
      await result.current.addFromDialog();
    });

    expect(result.current.images).toHaveLength(2);
    expect(result.current.canAdd).toBe(true);
  });

  it("达 3 张上限后继续添加：拒绝并提示", async () => {
    mockDialogPick(["/a.png", "/b.jpg", "/c.png"]);
    const { result } = renderHook(() => useImageAttachments());
    await act(async () => {
      await result.current.addFromDialog();
    });
    expect(result.current.images).toHaveLength(3);
    expect(result.current.canAdd).toBe(false);

    vi.mocked(normalizeImageFile).mockResolvedValue({
      data: new Uint8Array([9]),
      previewUrl: "blob:extra",
    });
    await act(async () => {
      await result.current.addFromPaste(new File([""], "x.png"));
    });

    expect(result.current.images).toHaveLength(3);
    expect(showMessage).toHaveBeenCalled();
    // 多出的候选图片 object URL 被释放
    expect(revokeSpy).toHaveBeenCalledWith("blob:extra");
  });

  it("一次选择超过剩余名额时截断并提示", async () => {
    mockDialogPick(["/a.png"]);
    const { result } = renderHook(() => useImageAttachments());
    await act(async () => {
      await result.current.addFromDialog();
    });
    expect(result.current.images).toHaveLength(1);

    mockDialogPick(["/b.png", "/c.png", "/d.png"]);
    await act(async () => {
      await result.current.addFromDialog();
    });

    expect(result.current.images).toHaveLength(3);
    expect(showMessage).toHaveBeenCalled();
  });

  it("remove 释放 object URL 并移除对应图片", async () => {
    mockDialogPick(["/a.png", "/b.png"]);
    const { result } = renderHook(() => useImageAttachments());
    await act(async () => {
      await result.current.addFromDialog();
    });
    const [first, second] = result.current.images;

    act(() => {
      result.current.remove(first.id);
    });

    expect(result.current.images).toEqual([second]);
    expect(revokeSpy).toHaveBeenCalledWith(first.previewUrl);
  });

  it("clear 释放全部 object URL 并清空", async () => {
    mockDialogPick(["/a.png", "/b.png"]);
    const { result } = renderHook(() => useImageAttachments());
    await act(async () => {
      await result.current.addFromDialog();
    });
    const urls = result.current.images.map((img) => img.previewUrl);

    act(() => {
      result.current.clear();
    });

    expect(result.current.images).toEqual([]);
    for (const url of urls) expect(revokeSpy).toHaveBeenCalledWith(url);
  });

  it("取消对话框选择不变更状态", async () => {
    vi.mocked(pickImagePaths).mockResolvedValue([]);
    const { result } = renderHook(() => useImageAttachments());

    await act(async () => {
      await result.current.addFromDialog();
    });

    expect(result.current.images).toEqual([]);
    expect(normalizeImage).not.toHaveBeenCalled();
  });
});
