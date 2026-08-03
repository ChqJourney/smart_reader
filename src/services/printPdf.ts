import { PDFDocument, PDFImage, PDFName, PDFPage } from "pdf-lib";
import { Annotation } from "./annotations";
import { clampPopupPosition } from "../utils/popupPosition";
import { renderAnnotationBox, type RenderedBox } from "./printBoxRenderer";

/**
 * 打印 PDF 生成层：把可见的翻译 / comment 批注以位图贴图形式覆盖到页面上，
 * 输出一份新的 PDF 字节。
 *
 * 两条页面路径（按文档自动选择）：
 * 1. 矢量路径：pdf-lib 直接加载原文件，同 context 内绘制贴图并整体重存
 *    （原页面矢量保留）。刻意不用 copyPages——跨 context 克隆对象对部分
 *    结构异常的 PDF 会静默丢失页面内容。
 * 2. 栅格兜底：pdf-lib 加载失败、源文件加密、或任一目标页的内容流引用
 *    解析不到（对象丢失，常见于损坏 xref / 签名增量更新等文件）时，由
 *    调用方注入的 rasterize（pdfjs 整页渲染）把页面整页转为位图。app 内
 *    渲染本就走 pdfjs，所见即所得，任何能打开的 PDF 都能正确打印。
 *    加密文档必须走此路径：pdf-lib 没有解密能力，ignoreEncryption 只能
 *    跳过报错，重存时内容流仍是密文、且尾部 /Encrypt 条目原样保留
 *    （PDFWriter 直接透传 trailerInfo.Encrypt），输出文件在阅读器里
 *    表现为空白页或要求密码（pdfjs 报 PasswordException）。pdfjs 会
 *    自动用空密码解密渲染，与 app 内所见一致。
 *
 * 坐标换算：批注 position 是 pdfjs scale=1 viewport 坐标（左上原点，数值
 * 与 PDF pt 一致），PDF 用户空间为左下原点，需要 y 翻转。浮层相对 marker
 * 的位置（水平居中、下方 12px）与页内 clamp 复用 popupPosition 的同一套
 * 计算，保证打印位置与屏幕所见一致（含用户拖动过的位置）。
 *
 * 已知限制：旋转页面（rotation ≠ 0）的贴图坐标未做旋转补偿，标准文献几乎
 * 不出现，暂不处理。
 */

export interface PrintOptions {
  /** 打印可见的翻译批注 */
  includeTranslations: boolean;
  /** 打印非空的 comment 批注 */
  includeComments: boolean;
  /** 1-based 页码清单（已去重排序）；缺省 = 全部页 */
  pages?: number[];
}

/** 整页栅格化能力（pdfjs），仅在矢量路径不可用时被调用。 */
export interface PageRasterizer {
  /** 文档总页数（pdfjs 给出；矢量路径失败时 pdf-lib 页数不可信） */
  numPages: number;
  /** 渲染整页为位图；width/height 为该页 pt 尺寸（scale-1） */
  render: (pageNum: number) => Promise<RenderedBox | null>;
}

export interface PrintPdfDeps {
  /** 批注浮层渲染（可注入替身；canvas 在 jsdom 中不可用） */
  renderBox?: (annotation: Annotation) => Promise<RenderedBox | null>;
  /** 整页栅格化兜底工厂（懒加载；矢量路径失败时必须提供，否则抛错） */
  rasterize?: () => Promise<PageRasterizer>;
}

/** 与浮层 CSS `translate(-50%, 12px)` 的纵向偏移一致 */
const POPUP_GAP_PX = 12;

/** 页面边缘最小留白（box 比页面宽时等比缩放到此宽度内） */
const PAGE_MARGIN = 8;

/** 过滤出需要上纸的批注：可见、非空、类型受选项控制、属于当前文档。 */
export function filterPrintableAnnotations(
  annotations: Annotation[],
  fileHash: string,
  options: Pick<PrintOptions, "includeTranslations" | "includeComments">
): Annotation[] {
  return annotations.filter((a) => {
    if (!(a.fileHash === fileHash || (!a.fileHash && fileHash === ""))) {
      return false;
    }
    if (a.hidden) return false;
    if (!a.content || !a.content.trim()) return false;
    if (a.type === "translate") return options.includeTranslations;
    if (a.type === "comment") return options.includeComments;
    return false;
  });
}

/**
 * 解析自定义页码范围（如 "1-3,5,8-9"）为去重排序的 1-based 页码数组。
 * 任何一段非法（格式错误 / 越界 / 倒序）或整体为空时返回 null。
 */
export function parsePageRange(
  input: string,
  numPages: number
): number[] | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const pages = new Set<number>();
  for (const part of trimmed.split(",")) {
    const seg = part.trim();
    const m = seg.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) return null;
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : start;
    if (start < 1 || end < start || end > numPages) return null;
    for (let p = start; p <= end; p++) pages.add(p);
  }
  if (pages.size === 0) return null;
  return [...pages].sort((a, b) => a - b);
}

export interface BoxPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 计算批注框在 PDF 用户空间中的位置（左下原点，单位 pt）。
 * marker 坐标为 pdfjs scale=1 坐标（左上原点）；先按浮层规则求出视觉
 * 左上角（marker 下方 12px、水平居中，clamp 进页面），再做 y 翻转。
 */
export function computeBoxPlacement(
  markerX: number,
  markerY: number,
  boxW: number,
  boxH: number,
  pageW: number,
  pageH: number
): BoxPlacement {
  const clamped = clampPopupPosition(
    markerX,
    markerY,
    boxW,
    boxH,
    pageW,
    pageH,
    { x: -boxW / 2, y: POPUP_GAP_PX }
  );
  const visualLeft = clamped.x - boxW / 2;
  const visualTop = clamped.y + POPUP_GAP_PX;
  return {
    x: visualLeft,
    y: pageH - visualTop - boxH,
    width: boxW,
    height: boxH,
  };
}

/**
 * 页面内容流是否完好。原生空白页（无 /Contents 键）视为完好——重存后仍是
 * 空白页，与原文件一致；只有“键存在但引用解析不到对象”才说明 pdf-lib
 * 读该文件时丢了对象（损坏 xref 修复 / 增量更新等），重存会输出空白页。
 */
function pageContentAvailable(page: PDFPage): boolean {
  if (!page.node.has(PDFName.of("Contents"))) return true;
  try {
    return page.node.lookup(PDFName.of("Contents")) !== undefined;
  } catch {
    return false;
  }
}

/**
 * 把批注贴图绘制到页面上。getPage 按 1-based 原页码取页对象；
 * embed 负责把 PNG 嵌入目标文档。
 */
async function drawAnnotations(
  printable: Annotation[],
  renderBox: (annotation: Annotation) => Promise<RenderedBox | null>,
  getPage: (pageNum: number) => PDFPage | undefined,
  embed: (png: Uint8Array) => Promise<PDFImage>
): Promise<void> {
  for (const annotation of printable) {
    const page = getPage(annotation.position.page);
    if (!page) continue;

    const box = await renderBox(annotation);
    if (!box) continue;

    const { width: pageW, height: pageH } = page.getSize();

    // 窄页面（如标签纸）上等比缩小盒子，保证完整落在页内
    let boxW = box.width;
    let boxH = box.height;
    const maxW = pageW - PAGE_MARGIN * 2;
    if (boxW > maxW && maxW > 0) {
      const ratio = maxW / boxW;
      boxW = maxW;
      boxH = boxH * ratio;
    }

    const placement = computeBoxPlacement(
      annotation.position.x,
      annotation.position.y,
      boxW,
      boxH,
      pageW,
      pageH
    );
    page.drawImage(await embed(box.data), placement);
  }
}

/** 矢量路径：同 context 内直接绘制（不用 copyPages），倒序删除未选中页。 */
async function buildVectorPdf(
  doc: PDFDocument,
  wanted: Set<number>,
  printable: Annotation[],
  renderBox: (annotation: Annotation) => Promise<RenderedBox | null>
): Promise<Uint8Array> {
  const total = doc.getPageCount();

  for (let p = total; p >= 1; p--) {
    if (!wanted.has(p)) doc.removePage(p - 1);
  }

  // 保留页顺序与原页序一致：建立 原页码 → 页对象 的映射
  const remaining = doc.getPages();
  const pageByNumber = new Map<number, PDFPage>();
  let index = 0;
  for (let p = 1; p <= total; p++) {
    if (!wanted.has(p)) continue;
    if (index < remaining.length) pageByNumber.set(p, remaining[index]);
    index++;
  }

  await drawAnnotations(
    printable,
    renderBox,
    (pageNum) => pageByNumber.get(pageNum),
    (png) => doc.embedPng(png)
  );

  return doc.save();
}

/** 栅格兜底：整页位图重建文档后再叠加批注贴图。 */
async function buildRasterPdf(
  wanted: number[],
  printable: Annotation[],
  renderBox: (annotation: Annotation) => Promise<RenderedBox | null>,
  rasterize: PageRasterizer
): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const pageByNumber = new Map<number, PDFPage>();

  for (const pageNum of wanted) {
    const image = await rasterize.render(pageNum);
    if (!image) continue;
    const page = out.addPage([image.width, image.height]);
    // 整页位图默认 JPEG（体积小一个量级），PNG 兜底
    const embedded =
      image.format === "jpeg"
        ? await out.embedJpg(image.data)
        : await out.embedPng(image.data);
    page.drawImage(embedded, {
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
    });
    pageByNumber.set(pageNum, page);
  }

  await drawAnnotations(
    printable,
    renderBox,
    (pageNum) => pageByNumber.get(pageNum),
    (png) => out.embedPng(png)
  );

  return out.save();
}

/**
 * 生成带批注贴图的打印 PDF。优先矢量路径；源文件加密、加载失败或目标页
 * 内容对象丢失时降级为整页栅格化（需 deps.rasterize）。
 */
export async function buildPrintPdf(
  pdfBytes: Uint8Array,
  annotations: Annotation[],
  fileHash: string,
  options: PrintOptions,
  deps: PrintPdfDeps = {}
): Promise<Uint8Array> {
  const renderBox = deps.renderBox ?? renderAnnotationBox;
  const printable = filterPrintableAnnotations(annotations, fileHash, options);

  try {
    const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    // pdf-lib 无解密能力：加密源重存只会带出密文内容流与 /Encrypt 尾部
    // 条目，输出在阅读器里表现为空白/要求密码。必须落入栅格兜底
    // （pdfjs 自动用空密码解密渲染，与 app 内所见一致）。
    if (!doc.isEncrypted) {
      const total = doc.getPageCount();
      const wanted = new Set(
        (options.pages ?? Array.from({ length: total }, (_, i) => i + 1)).filter(
          (p) => p >= 1 && p <= total
        )
      );

      // 目标页的内容流引用必须都能解析到对象，否则 pdf-lib 对该文件的
      // 解析不完整，重存会输出空白页（栅格兜底也不依赖 pdf-lib 解析）。
      const pages = doc.getPages();
      const contentIntact = [...wanted].every(
        (p) => p - 1 < pages.length && pageContentAvailable(pages[p - 1])
      );
      if (contentIntact) {
        return await buildVectorPdf(doc, wanted, printable, renderBox);
      }
    }
  } catch {
    // pdf-lib 无法解析该文件，落入栅格兜底
  }

  if (!deps.rasterize) {
    throw new Error(
      "PDF cannot be rebuilt losslessly and no rasterizer was provided"
    );
  }
  // 矢量路径失败时以 rasterize 的 numPages（pdfjs）为准重建页码清单
  const rasterize = await deps.rasterize();
  const pages =
    options.pages ??
    Array.from({ length: rasterize.numPages }, (_, i) => i + 1);
  return buildRasterPdf(pages, printable, renderBox, rasterize);
}
