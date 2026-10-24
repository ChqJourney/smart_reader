import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

/** 一条消息最多附带的图片数量 */
export const MAX_IMAGE_ATTACHMENTS = 3;

/** 归一化后最长边像素上限：与 pdfTools 截图管线一致（体积/token 消耗平衡点） */
const NORMALIZED_MAX_EDGE = 2048;
const JPEG_QUALITY = 0.85;

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

/** 归一化后的图片：JPEG 字节 + 缩略图 object URL（调用方负责 revoke） */
export interface NormalizedImage {
  data: Uint8Array;
  previewUrl: string;
}

/** 系统文件对话框选择图片，返回选中的路径（取消返回空数组） */
export async function pickImagePaths(): Promise<string[]> {
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }],
  });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

/** 读取用户选择的图片字节（后端扩展名白名单 + 20MB 上限校验） */
export async function readUserImageBytes(path: string): Promise<Uint8Array> {
  const data = await invoke<number[]>("read_user_image", { filePath: path });
  return new Uint8Array(data);
}

/**
 * 把任意格式的图片字节统一转码为 JPEG：铺白底（JPEG 无透明通道，透明
 * 区域否则会编码成黑色）、最长边限制 2048 等比缩放。与会话图片 .jpg
 * 命名和 buildImageUserMessage 的 image/jpeg data URL 保持一致。
 */
export async function normalizeImage(
  bytes: Uint8Array
): Promise<NormalizedImage> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
  try {
    const longestEdge = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, NORMALIZED_MAX_EDGE / longestEdge);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const jpegBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY)
    );
    if (!jpegBlob) throw new Error("Failed to encode image as JPEG");
    return {
      data: new Uint8Array(await jpegBlob.arrayBuffer()),
      previewUrl: URL.createObjectURL(jpegBlob),
    };
  } finally {
    bitmap.close();
  }
}

/** 粘贴路径入口：File（clipboardData.files）→ 归一化图片 */
export async function normalizeImageFile(file: File): Promise<NormalizedImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return normalizeImage(bytes);
}
