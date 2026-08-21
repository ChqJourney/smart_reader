import * as pdfjsLib from "pdfjs-dist";
import i18n from "i18next";
import {
  getOpenFileHashes,
  getOpenPdfMeta,
  getPdfBytes,
  isAuthorized,
  setOpenPdfNumPages,
} from "./pdfToolsRegistry";

import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// 与 PdfViewer / print.ts 同一处全局配置；幂等设置一次，保证无 viewer 环境
// （如纯工具会话）下截图渲染也能工作。
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

/** 截图区域：归一化坐标（0-1），原点在页面左上角。 */
export interface ToolImageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 截图工具产出的页面图像（JPEG 字节）。 */
export interface ToolImage {
  data: Uint8Array;
  mimeType: "image/jpeg";
  fileHash: string;
  fileName: string;
  page: number;
  region?: ToolImageRegion;
}

export interface ToolCallResult {
  /** Short description for UI status indicators. */
  summary: string;
  /** Full text sent back to the model as the tool result. */
  result: string;
  /** 截图工具附带的图像；agent loop 负责落盘并作为 user 消息发给模型。 */
  images?: ToolImage[];
}

export interface ToolSession {
  executeToolCall(name: string, argsJson: string): Promise<ToolCallResult>;
  dispose(): Promise<void>;
}

interface LoadedDoc {
  pdf: pdfjsLib.PDFDocumentProxy;
  pageTextCache: Map<number, Promise<string>>;
}

const PAGE_TEXT_LIMIT = 8000;

/** 截图最长边像素上限：≈144 DPI 渲染与图片体积/token 消耗的平衡点 */
const SCREENSHOT_MAX_EDGE = 2048;
const SCREENSHOT_RENDER_SCALE = 2;

/**
 * 解析并 clamp 归一化区域参数。返回 null 表示整页；
 * 返回 string 表示参数错误（直接作为错误文本返回给模型）。
 */
function parseRegion(args: unknown): ToolImageRegion | null | string {
  if (args === undefined || args === null) return null;
  if (typeof args !== "object") {
    return "Error: region must be an object {x, y, width, height} with values in 0..1";
  }
  const r = args as Record<string, unknown>;
  const x = Number(r.x);
  const y = Number(r.y);
  const width = Number(r.width);
  const height = Number(r.height);
  if (
    ![x, y, width, height].every((v) => Number.isFinite(v)) ||
    width <= 0 ||
    height <= 0 ||
    x < 0 ||
    y < 0
  ) {
    return "Error: region values must be finite numbers with x/y >= 0 and width/height > 0 (normalized 0..1, origin at the page's top-left corner)";
  }
  if (x >= 1 || y >= 1) {
    return "Error: region origin is outside the page (x/y must be < 1)";
  }
  // clamp 到页面范围内
  return {
    x,
    y,
    width: Math.min(width, 1 - x),
    height: Math.min(height, 1 - y),
  };
}

/**
 * 把 PDF 页渲染成 JPEG 字节（整页或归一化区域裁剪）。
 * JPEG 无透明通道，先铺白底再渲染，否则页面空白处会编码成黑色。
 */
async function renderPageImage(
  pdf: pdfjsLib.PDFDocumentProxy,
  fileHash: string,
  fileName: string,
  pageNumber: number,
  region: ToolImageRegion | null
): Promise<ToolImage> {
  const page = await pdf.getPage(pageNumber);
  try {
    const baseViewport = page.getViewport({ scale: 1 });
    const longestEdge = Math.max(baseViewport.width, baseViewport.height);
    const scale = Math.min(
      SCREENSHOT_RENDER_SCALE,
      SCREENSHOT_MAX_EDGE / longestEdge
    );
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    let source: HTMLCanvasElement = canvas;
    if (region) {
      // 归一化坐标直接等比映射到渲染后的像素尺寸（两者都是左上角原点）
      const sx = Math.floor(region.x * canvas.width);
      const sy = Math.floor(region.y * canvas.height);
      const sw = Math.max(1, Math.round(region.width * canvas.width));
      const sh = Math.max(1, Math.round(region.height * canvas.height));
      const crop = document.createElement("canvas");
      crop.width = Math.min(sw, canvas.width - sx);
      crop.height = Math.min(sh, canvas.height - sy);
      const cropCtx = crop.getContext("2d");
      if (!cropCtx) throw new Error("canvas 2d context unavailable");
      cropCtx.drawImage(
        canvas,
        sx,
        sy,
        crop.width,
        crop.height,
        0,
        0,
        crop.width,
        crop.height
      );
      source = crop;
    }

    const blob = await new Promise<Blob | null>((resolve) =>
      source.toBlob(resolve, "image/jpeg", 0.85)
    );
    if (!blob) throw new Error("failed to encode JPEG");
    return {
      data: new Uint8Array(await blob.arrayBuffer()),
      mimeType: "image/jpeg",
      fileHash,
      fileName,
      page: pageNumber,
      region: region ?? undefined,
    };
  } finally {
    page.cleanup();
  }
}

/**
 * Begin a transient tool session. Documents are loaded lazily and destroyed
 * when `dispose()` is called. Always use try/finally to dispose.
 */
export function beginToolSession(): ToolSession {
  const docs = new Map<string, LoadedDoc>();

  const loadDoc = async (
    fileHash: string
  ): Promise<pdfjsLib.PDFDocumentProxy> => {
    const existing = docs.get(fileHash);
    if (existing) return existing.pdf;

    if (!isAuthorized(fileHash)) {
      throw new Error(`PDF not open: ${fileHash}`);
    }

    const meta = getOpenPdfMeta(fileHash);
    if (!meta) {
      throw new Error(`PDF metadata missing: ${fileHash}`);
    }

    const bytes = await getPdfBytes(meta.filePath);
    const loadingTask = pdfjsLib.getDocument({ data: bytes });
    const pdf = await loadingTask.promise;
    setOpenPdfNumPages(fileHash, pdf.numPages);
    docs.set(fileHash, { pdf, pageTextCache: new Map() });
    return pdf;
  };

  const getPageText = async (
    fileHash: string,
    pageNumber: number
  ): Promise<string> => {
    const loaded = docs.get(fileHash);
    if (!loaded) {
      await loadDoc(fileHash);
      return getPageText(fileHash, pageNumber);
    }
    const cached = loaded.pageTextCache.get(pageNumber);
    if (cached) return cached;

    const promise = (async () => {
      const page = await loaded.pdf.getPage(pageNumber);
      try {
        const textContent = await page.getTextContent();
        const parts: string[] = [];
        for (const item of textContent.items) {
          if (typeof (item as any).str === "string") {
            parts.push((item as any).str);
            if ((item as any).hasEOL) {
              parts.push("\n");
            }
          }
        }
        const fullText = parts.join("");
        if (fullText.length > PAGE_TEXT_LIMIT) {
          return (
            fullText.slice(0, PAGE_TEXT_LIMIT) +
            `\n... [truncated, page has ${fullText.length} chars total]`
          );
        }
        return fullText;
      } finally {
        page.cleanup();
      }
    })();
    loaded.pageTextCache.set(pageNumber, promise);
    return promise;
  };

  const executeToolCall = async (
    name: string,
    argsJson: string
  ): Promise<ToolCallResult> => {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson);
    } catch {
      return {
        summary: i18n.t("tools.callUnknown", { name }),
        result: `Error: invalid arguments JSON for ${name}`,
      };
    }

    switch (name) {
      case "list_open_pdfs": {
        const hashes = getOpenFileHashes();
        const list = hashes
          .map((hash) => {
            const meta = getOpenPdfMeta(hash);
            const entry: Record<string, unknown> = {
              fileHash: hash,
              fileName: meta?.fileName ?? "",
            };
            if (meta?.numPages !== undefined) {
              entry.numPages = meta.numPages;
            }
            return entry;
          })
          .filter((entry) => entry.fileName);
        return {
          summary: i18n.t("tools.callList"),
          result: JSON.stringify(list),
        };
      }

      case "read_pdf_page": {
        const fileHash = String(args.file_hash ?? "");
        const pageNumber = Number(args.page_number ?? 0);
        if (!isAuthorized(fileHash)) {
          return {
            summary: i18n.t("tools.callReadPage", { page: pageNumber }),
            result: `Error: PDF not open: ${fileHash}`,
          };
        }
        try {
          const pdf = await loadDoc(fileHash);
          if (pageNumber < 1 || pageNumber > pdf.numPages) {
            return {
              summary: i18n.t("tools.callReadPage", { page: pageNumber }),
              result: `Error: page ${pageNumber} out of range (1..${pdf.numPages})`,
            };
          }
          const text = await getPageText(fileHash, pageNumber);
          return {
            summary: i18n.t("tools.callReadPage", { page: pageNumber }),
            result: text,
          };
        } catch (err) {
          return {
            summary: i18n.t("tools.callReadPage", { page: pageNumber }),
            result: `Error: ${err}`,
          };
        }
      }

      case "search_in_pdf": {
        const fileHash = String(args.file_hash ?? "");
        const query = String(args.query ?? "");
        let maxResults = Number(args.max_results ?? 5);
        maxResults = Math.max(1, Math.min(10, maxResults));
        if (!isAuthorized(fileHash)) {
          return {
            summary: i18n.t("tools.callSearch", { query }),
            result: `Error: PDF not open: ${fileHash}`,
          };
        }
        try {
          const pdf = await loadDoc(fileHash);
          const lowerQuery = query.toLowerCase();
          const results: { page: number; snippet: string }[] = [];
          for (
            let i = 1;
            i <= pdf.numPages && results.length < maxResults;
            i++
          ) {
            const text = await getPageText(fileHash, i);
            const lowerText = text.toLowerCase();
            const idx = lowerText.indexOf(lowerQuery);
            if (idx !== -1) {
              const start = Math.max(0, idx - 100);
              const end = Math.min(text.length, idx + query.length + 100);
              let snippet = text.slice(start, end).replace(/\s+/g, " ");
              if (start > 0) snippet = "..." + snippet;
              if (end < text.length) snippet = snippet + "...";
              results.push({ page: i, snippet });
            }
          }
          if (results.length === 0) {
            return {
              summary: i18n.t("tools.callSearch", { query }),
              result: `No matches found for "${query}".`,
            };
          }
          return {
            summary: i18n.t("tools.callSearch", { query }),
            result: JSON.stringify(results),
          };
        } catch (err) {
          return {
            summary: i18n.t("tools.callSearch", { query }),
            result: `Error: ${err}`,
          };
        }
      }

      case "screenshot_pdf_page": {
        const fileHash = String(args.file_hash ?? "");
        const pageNumber = Number(args.page_number ?? 0);
        const summary = i18n.t("tools.callScreenshot", { page: pageNumber });
        if (!isAuthorized(fileHash)) {
          return { summary, result: `Error: PDF not open: ${fileHash}` };
        }
        const region = parseRegion(args.region);
        if (typeof region === "string") {
          return { summary, result: region };
        }
        try {
          const pdf = await loadDoc(fileHash);
          if (pageNumber < 1 || pageNumber > pdf.numPages) {
            return {
              summary,
              result: `Error: page ${pageNumber} out of range (1..${pdf.numPages})`,
            };
          }
          const meta = getOpenPdfMeta(fileHash);
          const image = await renderPageImage(
            pdf,
            fileHash,
            meta?.fileName ?? "",
            pageNumber,
            region
          );
          return {
            summary,
            result: region
              ? `Screenshot captured: page ${pageNumber} of "${image.fileName}", region (x=${region.x}, y=${region.y}, width=${region.width}, height=${region.height}, normalized from top-left). The image is attached as the following user message.`
              : `Screenshot captured: full page ${pageNumber} of "${image.fileName}". The image is attached as the following user message.`,
            images: [image],
          };
        } catch (err) {
          return { summary, result: `Error: ${err}` };
        }
      }

      default:
        return {
          summary: i18n.t("tools.callUnknown", { name }),
          result: `Error: unknown tool ${name}`,
        };
    }
  };

  return {
    executeToolCall,
    dispose: async () => {
      for (const { pdf } of docs.values()) {
        try {
          await pdf.destroy();
        } catch {
          // ignore cleanup errors
        }
      }
      docs.clear();
    },
  };
}
