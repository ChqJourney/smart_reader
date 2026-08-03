import { describe, it, expect, vi } from "vitest";
import { PDFDocument, PDFName, PDFRef } from "pdf-lib";
import {
  buildPrintPdf,
  computeBoxPlacement,
  filterPrintableAnnotations,
  parsePageRange,
} from "./printPdf";
import { layoutText } from "./printBoxRenderer";
import { Annotation } from "./annotations";

const makeAnnotation = (over: Partial<Annotation> = {}): Annotation => ({
  id: crypto.randomUUID(),
  type: "translate",
  text: "source text",
  position: { page: 1, x: 100, y: 100 },
  content: "译文内容",
  isStreaming: false,
  createdAt: 0,
  fileHash: "h1",
  ...over,
});

/** 生成一份 3 页空白 PDF（612x792） */
async function makeSourcePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage([612, 792]);
  return doc.save();
}

/**
 * 手工构造带 /Encrypt 尾条款的 PDF（xref 偏移量动态计算，内容全 ASCII）。
 * pdf-lib 的 isEncrypted 只看 /Encrypt 引用能否解析到对象，空字典即可
 * 触发；真实加密文件的内容流还是密文，矢量重存必然输出坏文件。
 */
function makeEncryptedPdf(): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    "<< >>", // 伪 Encrypt 字典
  ];
  let body = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (const off of offsets) {
    body += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 4 0 R >>\n`;
  body += `startxref\n${xrefStart}\n%%EOF`;
  // 全 ASCII；与上方 fixture 同款构造，避免 TextEncoder 产物与 pdf-lib
  // 的 instanceof Uint8Array 检查跨 realm 不兼容
  return Uint8Array.from(body, (c) => c.charCodeAt(0));
}

// 1x1 透明 PNG / 白色 JPEG，作为 renderBox 与 rasterize 替身的输出
const TINY_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  ),
  (c) => c.charCodeAt(0)
);

const TINY_JPEG = Uint8Array.from(
  atob(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD7LooooA//2Q=="
  ),
  (c) => c.charCodeAt(0)
);

describe("filterPrintableAnnotations", () => {
  const options = { includeTranslations: true, includeComments: true };

  it("keeps visible translate and comment annotations with content", () => {
    const annotations = [
      makeAnnotation({ type: "translate" }),
      makeAnnotation({ type: "comment", content: "备注" }),
    ];
    expect(filterPrintableAnnotations(annotations, "h1", options)).toHaveLength(
      2
    );
  });

  it("skips hidden annotations", () => {
    const annotations = [makeAnnotation({ hidden: true })];
    expect(filterPrintableAnnotations(annotations, "h1", options)).toHaveLength(
      0
    );
  });

  it("skips annotations with empty or whitespace content", () => {
    const annotations = [
      makeAnnotation({ content: "" }),
      makeAnnotation({ content: "   " }),
    ];
    expect(filterPrintableAnnotations(annotations, "h1", options)).toHaveLength(
      0
    );
  });

  it("respects the include toggles", () => {
    const annotations = [
      makeAnnotation({ type: "translate" }),
      makeAnnotation({ type: "comment", content: "备注" }),
    ];
    expect(
      filterPrintableAnnotations(annotations, "h1", {
        includeTranslations: false,
        includeComments: true,
      }).map((a) => a.type)
    ).toEqual(["comment"]);
    expect(
      filterPrintableAnnotations(annotations, "h1", {
        includeTranslations: true,
        includeComments: false,
      }).map((a) => a.type)
    ).toEqual(["translate"]);
  });

  it("excludes explain and stash annotations", () => {
    const annotations = [
      makeAnnotation({ type: "explain", content: "解读" }),
      makeAnnotation({ type: "stash", content: "暂存" }),
    ];
    expect(filterPrintableAnnotations(annotations, "h1", options)).toHaveLength(
      0
    );
  });

  it("filters by fileHash, including the legacy no-fileHash bucket", () => {
    const annotations = [
      makeAnnotation({ fileHash: "h1" }),
      makeAnnotation({ fileHash: "h2" }),
      makeAnnotation({ fileHash: undefined }),
    ];
    expect(filterPrintableAnnotations(annotations, "h1", options)).toHaveLength(
      1
    );
    expect(filterPrintableAnnotations(annotations, "", options)).toHaveLength(
      1
    );
  });
});

describe("parsePageRange", () => {
  it("parses single pages and ranges, deduped and sorted", () => {
    expect(parsePageRange("1-3,5", 10)).toEqual([1, 2, 3, 5]);
    expect(parsePageRange("3,1-2", 10)).toEqual([1, 2, 3]);
    expect(parsePageRange(" 2 - 4 , 6 ", 10)).toEqual([2, 3, 4, 6]);
    expect(parsePageRange("5", 10)).toEqual([5]);
  });

  it("returns null for invalid input", () => {
    expect(parsePageRange("", 10)).toBeNull();
    expect(parsePageRange("   ", 10)).toBeNull();
    expect(parsePageRange("abc", 10)).toBeNull();
    expect(parsePageRange("3-1", 10)).toBeNull();
    expect(parsePageRange("0", 10)).toBeNull();
    expect(parsePageRange("2-99", 10)).toBeNull();
    expect(parsePageRange("1,,2", 10)).toBeNull();
  });
});

describe("computeBoxPlacement", () => {
  // 页面 612x792，浮层规则：marker 下方 12px、水平居中
  it("centers the box below the marker and flips the y axis", () => {
    const p = computeBoxPlacement(306, 100, 320, 100, 612, 792);
    expect(p.x).toBe(306 - 160);
    expect(p.width).toBe(320);
    expect(p.height).toBe(100);
    // 视觉 top = 100 + 12 = 112 → pdfY = 792 - 112 - 100
    expect(p.y).toBe(792 - 112 - 100);
  });

  it("clamps the box into the page on the left edge", () => {
    const p = computeBoxPlacement(10, 100, 320, 100, 612, 792);
    expect(p.x).toBe(0);
  });

  it("clamps the box into the page at the bottom edge", () => {
    const p = computeBoxPlacement(306, 780, 320, 100, 612, 792);
    expect(p.y).toBe(0);
  });
});

describe("layoutText", () => {
  // 每个字符宽 10，行宽 100 → 每行最多 10 个字符
  const measure = (s: string) => s.length * 10;

  it("wraps long paragraphs by characters", () => {
    expect(layoutText("a".repeat(25), 100, measure)).toEqual([
      "a".repeat(10),
      "a".repeat(10),
      "a".repeat(5),
    ]);
  });

  it("splits paragraphs and keeps empty lines", () => {
    expect(layoutText("ab\n\ncd", 100, measure)).toEqual(["ab", "", "cd"]);
  });

  it("wraps CJK text the same way", () => {
    expect(layoutText("译".repeat(12), 100, measure)).toEqual([
      "译".repeat(10),
      "译".repeat(2),
    ]);
  });
});

describe("buildPrintPdf", () => {
  const fakeRenderBox = async () => ({
    data: TINY_PNG,
    width: 320,
    height: 100,
  });

  it("copies all pages when no page selection is given", async () => {
    const bytes = await makeSourcePdf();
    const out = await buildPrintPdf(bytes, [], "h1", {
      includeTranslations: true,
      includeComments: true,
    });
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(3);
  });

  it("copies only the selected pages", async () => {
    const bytes = await makeSourcePdf();
    const out = await buildPrintPdf(bytes, [], "h1", {
      includeTranslations: true,
      includeComments: true,
      pages: [2],
    });
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(1);
  });

  it("renders printable annotations onto their pages", async () => {
    const bytes = await makeSourcePdf();
    const renderBox = vi.fn(fakeRenderBox);
    const annotation = makeAnnotation({
      position: { page: 2, x: 306, y: 100 },
    });
    const out = await buildPrintPdf(
      bytes,
      [annotation],
      "h1",
      {
        includeTranslations: true,
        includeComments: true,
      },
      { renderBox }
    );
    expect(renderBox).toHaveBeenCalledTimes(1);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(3);
  });

  it("skips annotations on pages outside the selection", async () => {
    const bytes = await makeSourcePdf();
    const renderBox = vi.fn(fakeRenderBox);
    const annotation = makeAnnotation({
      position: { page: 2, x: 306, y: 100 },
    });
    await buildPrintPdf(
      bytes,
      [annotation],
      "h1",
      {
        includeTranslations: true,
        includeComments: true,
        pages: [1],
      },
      { renderBox }
    );
    expect(renderBox).not.toHaveBeenCalled();
  });

  it("tolerates renderBox returning null", async () => {
    const bytes = await makeSourcePdf();
    const out = await buildPrintPdf(
      bytes,
      [makeAnnotation()],
      "h1",
      { includeTranslations: true, includeComments: true },
      { renderBox: async () => null }
    );
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(3);
  });

  it("does not touch the rasterizer when the vector path succeeds", async () => {
    const bytes = await makeSourcePdf();
    const rasterize = vi.fn();
    await buildPrintPdf(
      bytes,
      [],
      "h1",
      { includeTranslations: true, includeComments: true },
      { rasterize }
    );
    expect(rasterize).not.toHaveBeenCalled();
  });

  it("falls back to rasterization when pdf-lib cannot parse the file", async () => {
    const garbage = new TextEncoder().encode("not a pdf at all");
    const rasterize = vi.fn().mockResolvedValue({
      numPages: 2,
      render: async () => ({
        data: TINY_JPEG,
        format: "jpeg" as const,
        width: 612,
        height: 792,
      }),
    });
    const out = await buildPrintPdf(
      garbage,
      [],
      "h1",
      { includeTranslations: true, includeComments: true },
      { rasterize }
    );
    expect(rasterize).toHaveBeenCalledTimes(1);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(2);
  });

  it("falls back to rasterization when a wanted page loses its content stream", async () => {
    // 构造 /Contents 悬空引用（对象丢失）：pdf-lib 重存会输出空白页
    const src = await PDFDocument.create();
    const p1 = src.addPage([612, 792]);
    p1.drawText("content page");
    const p2 = src.addPage([612, 792]);
    p2.node.set(PDFName.of("Contents"), PDFRef.of(9999, 0));
    const bytes = await src.save();

    const rasterize = vi.fn().mockResolvedValue({
      numPages: 2,
      render: async () => ({ data: TINY_PNG, width: 612, height: 792 }),
    });
    const out = await buildPrintPdf(
      bytes,
      [],
      "h1",
      { includeTranslations: true, includeComments: true, pages: [2] },
      { rasterize }
    );
    expect(rasterize).toHaveBeenCalledTimes(1);
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(1);
  });

  it("falls back to rasterization when the source is encrypted", async () => {
    // pdf-lib 无解密能力：加密源矢量重存会带出密文内容流与 /Encrypt 尾部
    // 条目，阅读器打开空白/要求密码（pdfjs PasswordException）
    const bytes = makeEncryptedPdf();
    const loaded = await PDFDocument.load(bytes, { ignoreEncryption: true });
    expect(loaded.isEncrypted).toBe(true);

    const rasterize = vi.fn().mockResolvedValue({
      numPages: 1,
      render: async () => ({ data: TINY_PNG, width: 612, height: 792 }),
    });
    const out = await buildPrintPdf(
      bytes,
      [],
      "h1",
      { includeTranslations: true, includeComments: true },
      { rasterize }
    );
    expect(rasterize).toHaveBeenCalledTimes(1);
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.isEncrypted).toBe(false);
    expect(reloaded.getPageCount()).toBe(1);
  });

  it("overlays annotations on the rasterized pages", async () => {
    const garbage = new TextEncoder().encode("not a pdf at all");
    const renderBox = vi.fn(fakeRenderBox);
    const rasterize = vi.fn().mockResolvedValue({
      numPages: 1,
      render: async () => ({ data: TINY_PNG, width: 612, height: 792 }),
    });
    await buildPrintPdf(
      garbage,
      [makeAnnotation()],
      "h1",
      { includeTranslations: true, includeComments: true },
      { renderBox, rasterize }
    );
    expect(renderBox).toHaveBeenCalledTimes(1);
  });

  it("throws when the file cannot be parsed and no rasterizer is provided", async () => {
    const garbage = new TextEncoder().encode("not a pdf at all");
    await expect(
      buildPrintPdf(garbage, [], "h1", {
        includeTranslations: true,
        includeComments: true,
      })
    ).rejects.toThrow();
  });
});
