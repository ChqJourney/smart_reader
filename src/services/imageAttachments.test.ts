import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { pickImagePaths, readUserImageBytes } from "./imageAttachments";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

describe("pickImagePaths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("取消选择返回空数组", async () => {
    vi.mocked(open).mockResolvedValue(null);
    expect(await pickImagePaths()).toEqual([]);
  });

  it("单选结果归一化为数组", async () => {
    vi.mocked(open).mockResolvedValue("/pic/a.png");
    expect(await pickImagePaths()).toEqual(["/pic/a.png"]);
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        multiple: true,
        directory: false,
        filters: [
          {
            name: "Images",
            extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
          },
        ],
      })
    );
  });

  it("多选结果原样返回", async () => {
    vi.mocked(open).mockResolvedValue(["/a.png", "/b.jpg"]);
    expect(await pickImagePaths()).toEqual(["/a.png", "/b.jpg"]);
  });
});

describe("readUserImageBytes", () => {
  it("经 read_user_image 命令读取并转为 Uint8Array", async () => {
    vi.mocked(invoke).mockResolvedValue([1, 2, 3]);
    const bytes = await readUserImageBytes("/pic/a.png");
    expect(invoke).toHaveBeenCalledWith("read_user_image", {
      filePath: "/pic/a.png",
    });
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });
});
