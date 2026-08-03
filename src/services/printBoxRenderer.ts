import i18n from "i18next";
import { Annotation } from "./annotations";

/**
 * 把单条批注（翻译 / comment）渲染成 PNG 位图，供打印 PDF 贴图使用。
 *
 * 为什么用 canvas 光栅化而不是嵌入字体绘制文本：pdf-lib 标准字体不支持
 * CJK，嵌入中文字体需额外引入 fontkit 与数 MB 的字体文件；canvas 直接复用
 * 系统字体，无打包体积成本，且样式可以复刻屏幕上的浮层外观。
 *
 * 坐标/尺寸约定：与 pdfjs scale=1 的 viewport 单位一致（1 单位 = 1 CSS px
 * = 1 PDF pt），内部按 2x 光栅化保证打印清晰度。
 */

export interface RenderedBox {
  /** 位图字节（PNG 或 JPEG，见 format） */
  data: Uint8Array;
  /** 位图格式；缺省 png。整页栅格化建议 jpeg 以控制体积 */
  format?: "png" | "jpeg";
  /** 盒子逻辑宽度（pt，scale-1 px） */
  width: number;
  /** 盒子逻辑高度（pt，scale-1 px） */
  height: number;
}

const RASTER_SCALE = 2;
const FONT_SIZE = 13; // ≈ 浮层 body 0.8rem
const LINE_HEIGHT = Math.round(FONT_SIZE * 1.6);
const PAD_X = 12;
const PAD_Y = 10;
const HEADER_HEIGHT = 26;
const CORNER_RADIUS = 10;
const MAX_BODY_HEIGHT = 254; // ≈ 浮层 max-height 280 - header

interface BoxSpec {
  width: number;
  titleKey: string;
}

function specFor(annotation: Annotation): BoxSpec {
  // 与 TranslatePopup.css / CommentPopup.css 的宽度保持一致
  return annotation.type === "comment"
    ? { width: 300, titleKey: "comment.title" }
    : { width: 320, titleKey: "translate.title" };
}

/**
 * 纯文本排版：按 \n 分段，段内按字符贪心换行（CJK 无空格断词，逐字符
 * 换行对中英文都安全）。空段保留为空行。measure 由调用方注入以便测试。
 */
export function layoutText(
  text: string,
  maxWidth: number,
  measure: (s: string) => number
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    let current = "";
    for (const ch of paragraph) {
      if (current !== "" && measure(current + ch) > maxWidth) {
        lines.push(current);
        current = ch;
      } else {
        current += ch;
      }
    }
    if (current !== "") lines.push(current);
  }
  return lines;
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * 渲染批注浮层为 PNG。webview 环境拿不到 2d context 或 toBlob 失败时返回
 * null（调用方跳过该条，不阻断整份打印）。
 */
export async function renderAnnotationBox(
  annotation: Annotation
): Promise<RenderedBox | null> {
  const spec = specFor(annotation);
  const title = i18n.t(spec.titleKey);

  const canvas = document.createElement("canvas");
  const measureCtx = canvas.getContext("2d");
  if (!measureCtx) return null;

  measureCtx.font = `${FONT_SIZE}px sans-serif`;
  const contentWidth = spec.width - PAD_X * 2;
  const lines = layoutText(
    annotation.content.trim(),
    contentWidth,
    (s) => measureCtx.measureText(s).width
  );
  if (lines.length === 0) return null;

  const bodyHeight = Math.min(
    lines.length * LINE_HEIGHT + PAD_Y * 2,
    MAX_BODY_HEIGHT
  );
  const boxHeight = HEADER_HEIGHT + bodyHeight;

  canvas.width = Math.ceil(spec.width * RASTER_SCALE);
  canvas.height = Math.ceil(boxHeight * RASTER_SCALE);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(RASTER_SCALE, RASTER_SCALE);

  // 背景与标题栏（裁剪进圆角）
  roundedRectPath(ctx, 0, 0, spec.width, boxHeight, CORNER_RADIUS);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = "rgba(255, 255, 255, 0.98)";
  ctx.fillRect(0, 0, spec.width, boxHeight);
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, spec.width, HEADER_HEIGHT);
  ctx.strokeStyle = "#e8e8e8";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, HEADER_HEIGHT + 0.5);
  ctx.lineTo(spec.width, HEADER_HEIGHT + 0.5);
  ctx.stroke();

  ctx.font = `bold ${FONT_SIZE}px sans-serif`;
  ctx.fillStyle = "#1f1f1f";
  ctx.textBaseline = "middle";
  ctx.fillText(title, PAD_X, HEADER_HEIGHT / 2);

  // 正文（裁剪到 body 区，超长内容截断与浮层滚动区域语义一致）
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, HEADER_HEIGHT, spec.width, bodyHeight);
  ctx.clip();
  ctx.font = `${FONT_SIZE}px sans-serif`;
  ctx.fillStyle = "#333333";
  ctx.textBaseline = "top";
  lines.forEach((line, i) => {
    ctx.fillText(line, PAD_X, HEADER_HEIGHT + PAD_Y + i * LINE_HEIGHT);
  });
  ctx.restore();
  ctx.restore();

  // 外边框
  roundedRectPath(ctx, 0.5, 0.5, spec.width - 1, boxHeight - 1, CORNER_RADIUS);
  ctx.strokeStyle = "#d0d0d0";
  ctx.lineWidth = 1;
  ctx.stroke();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png")
  );
  if (!blob) return null;

  return {
    data: new Uint8Array(await blob.arrayBuffer()),
    width: spec.width,
    height: boxHeight,
  };
}
