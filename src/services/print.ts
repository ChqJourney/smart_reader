import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import * as pdfjsLib from "pdfjs-dist";
import { Annotation } from "./annotations";
import { buildPrintPdf, PageRasterizer, PrintOptions } from "./printPdf";

import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// 与 PdfViewer 同一处全局配置；在此幂等设置一次，保证打印路径独立可用。
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

/**
 * 打印编排层：取 PDF 字节（App 级缓存优先，未命中回退后端读取）→ 生成
 * 带批注的打印 PDF → 系统阅读器打开打印 / 另存为导出。
 *
 * 与 viewer 生命周期解耦：休眠 tab 也能打印（只需 filePath + annotations）。
 */

export interface PrintSource {
  filePath: string;
  fileHash: string;
  annotations: Annotation[];
  cachedBytes?: Uint8Array;
}

async function loadPdfBytes(source: PrintSource): Promise<Uint8Array> {
  if (source.cachedBytes && source.cachedBytes.length > 0) {
    return source.cachedBytes;
  }
  const buffer = await invoke<ArrayBuffer>("read_pdf_bytes", {
    filePath: source.filePath,
  });
  return new Uint8Array(buffer);
}

/** 整页栅格化倍率：≈144 DPI，打印清晰度与文件体积的平衡点 */
const PAGE_RASTER_SCALE = 2;

/**
 * 基于 pdfjs 的整页栅格化器（矢量重建失败时的兜底）。工厂函数懒加载：
 * 只有真的进入栅格路径才创建 PDFDocumentProxy。
 * JPEG 无透明通道，先铺白底再渲染，否则页面空白处会编码成黑色。
 */
function makeRasterizerFactory(
  pdfBytes: Uint8Array
): () => Promise<PageRasterizer> {
  let docPromise: Promise<pdfjsLib.PDFDocumentProxy> | null = null;
  const loadDoc = () => {
    // slice() 防止 pdfjs worker 传输（detach）共享 buffer
    docPromise ??= pdfjsLib.getDocument({ data: pdfBytes.slice() }).promise;
    return docPromise;
  };
  return async () => {
    const doc = await loadDoc();
    return {
      numPages: doc.numPages,
      async render(pageNum) {
        const page = await doc.getPage(pageNum);
        const baseViewport = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: PAGE_RASTER_SCALE });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", 0.85)
        );
        if (!blob) return null;
        return {
          data: new Uint8Array(await blob.arrayBuffer()),
          format: "jpeg",
          width: baseViewport.width,
          height: baseViewport.height,
        };
      },
    };
  };
}

/** 生成带批注贴图的打印 PDF 字节。 */
export async function generatePrintPdf(
  source: PrintSource,
  options: PrintOptions
): Promise<Uint8Array> {
  const bytes = await loadPdfBytes(source);
  return buildPrintPdf(bytes, source.annotations, source.fileHash, options, {
    rasterize: makeRasterizerFactory(bytes),
  });
}

/**
 * 生成临时文件并用平台指定阅读器打开（macOS Preview / Windows Edge），
 * 用户在其中完成打印。不走系统默认关联：若默认 PDF 阅读器是本应用自己，
 * 默认打开会回环成新 tab，无法打印。原始字节作为 IPC 请求体发送，
 * 由后端 `open_print_file` 落盘到 AppData 的 print/ 目录后打开。
 */
export async function openPrintPreview(pdfBytes: Uint8Array): Promise<void> {
  await invoke("open_print_file", pdfBytes);
}

/**
 * 弹系统保存对话框导出带批注的 PDF。返回 true 表示已导出，用户取消返回
 * false。data 以 number[] 传输（serde_json 数组 ↔ Vec<u8>；嵌套的
 * Uint8Array 会被序列化成对象，不能直接用）。
 */
export async function exportPrintPdf(
  pdfBytes: Uint8Array,
  defaultFileName: string
): Promise<boolean> {
  const path = await save({
    defaultPath: defaultFileName,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!path) return false;
  await invoke("export_binary_file", {
    filePath: path,
    data: Array.from(pdfBytes),
  });
  return true;
}
