import { invoke } from "@tauri-apps/api/core";
import { error } from "./logs";

export interface AnnotationPosition {
  page: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface Annotation {
  id: string;
  type: "translate" | "explain" | "stash" | "comment";
  text: string;
  position: AnnotationPosition;
  content: string;
  isStreaming: boolean;
  hidden?: boolean;
  createdAt: number;
  stashId?: string;
  sessionId?: string;
  interpretedGroupSize?: number;
  interpretedIndex?: number;
  fileHash?: string;
}

export interface PdfData {
  annotations: Annotation[];
  sessionIds: string[];
}

export async function loadPdfData(filePath: string): Promise<PdfData> {
  if (!filePath) return { annotations: [], sessionIds: [] };
  try {
    const result = await invoke<PdfData>("load_pdf_data", { filePath });
    // 历史脏数据自愈：旧版 TranslatePopup 在流式中卸载时只保存了部分内容、
    // 未复位 isStreaming，导致批注永久停留在「翻译中」。加载时把「已有内容
    // 但仍 streaming」的翻译批注重置为完成态（无内容的保留 streaming，
    // 挂载守卫会自动重启流）。
    return {
      ...result,
      annotations: result.annotations.map((a) =>
        a.type === "translate" && a.isStreaming && a.content
          ? { ...a, isStreaming: false }
          : a
      ),
    };
  } catch (err) {
    // 加载失败必须抛给调用方：若降级为空数据，后续防抖保存会把空桶覆盖
    // 写回磁盘，静默清空用户已有批注（文件损坏/瞬时 IO 错误都可能触发）。
    error(`Failed to load PDF data: ${err}`);
    throw err;
  }
}

export async function savePdfData(
  filePath: string,
  data: PdfData
): Promise<void> {
  if (!filePath) return;
  try {
    await invoke("save_pdf_data", { filePath, data });
  } catch (err) {
    error(`Failed to save PDF data: ${err}`);
  }
}

export async function authorizePdfPath(filePath: string): Promise<void> {
  if (!filePath) return;
  try {
    await invoke("authorize_pdf_path", { filePath });
  } catch (err) {
    error(`Failed to authorize PDF path: ${err}`);
  }
}

export async function getPdfHash(filePath: string): Promise<string> {
  return await invoke<string>("get_pdf_hash", { filePath });
}

/** 文件字节数（fs metadata，不读内容），供内存预算在加载字节前记账。 */
export async function getPdfFileSize(filePath: string): Promise<number> {
  return await invoke<number>("get_pdf_file_size", { filePath });
}

/**
 * 读取 PDF 原始字节。后端在同一遍读取中算好 SHA-256 并预热 hash 缓存，
 * 随后的 getPdfHash 只做 metadata 校验即命中——局域网文件整条打开链路
 * 只需一遍网络传输（原来 hash 与 bytes 各传一遍）。
 */
export async function readPdfBytes(filePath: string): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>("read_pdf_bytes", { filePath });
  return new Uint8Array(buffer);
}

export function createAnnotation(
  type: "translate" | "explain" | "stash" | "comment",
  text: string,
  page: number,
  x: number,
  y: number,
  options?: {
    stashId?: string;
    width?: number;
    height?: number;
    fileHash?: string;
  }
): Annotation {
  return {
    id: crypto.randomUUID(),
    type,
    text,
    position: { page, x, y, width: options?.width, height: options?.height },
    content: "",
    isStreaming: type === "comment" ? false : true,
    hidden: type === "translate" ? false : undefined,
    createdAt: Date.now(),
    stashId: options?.stashId,
    fileHash: options?.fileHash,
  };
}

export function updateAnnotation(
  annotations: Annotation[],
  id: string,
  patch: Partial<Omit<Annotation, "id">>
): Annotation[] {
  return annotations.map((a) => (a.id === id ? { ...a, ...patch } : a));
}

export function deleteAnnotation(
  annotations: Annotation[],
  id: string
): Annotation[] {
  return annotations.filter((a) => a.id !== id);
}
