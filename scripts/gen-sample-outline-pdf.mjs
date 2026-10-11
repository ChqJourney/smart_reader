// 生成带大纲（outline / 书签）的测试 PDF：5 页，每页 10 行位置已知的文本，
// 大纲条目用 /XYZ dest 指向特定行的基线，用于验证大纲点击跳转是否精确
// 滚动到目标行（而不是只到页首）。
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from "pdf-lib";
import fs from "fs";

const PAGE_W = 612;
const PAGE_H = 792;
const LINE_STEP = 60;
const LINES_PER_PAGE = 10;
const FONT_SIZE = 12;

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);

// lines[page][row] = 该行文本基线的 user-space y
const lines = [];
for (let p = 0; p < 5; p++) {
  const page = doc.addPage([PAGE_W, PAGE_H]);
  lines.push([]);
  for (let r = 0; r < LINES_PER_PAGE; r++) {
    const baselineY = PAGE_H - 72 - r * LINE_STEP; // 首行基线 y=720
    page.drawText(`P${p + 1} LINE ${r}`, {
      x: 72,
      y: baselineY,
      size: FONT_SIZE,
      font,
      color: rgb(0, 0, 0),
    });
    lines[p].push(baselineY);
  }
}

// 大纲条目：分别指向 3p 第 6 行 / 4p 第 1 行 / 5p 第 8 行（0-based 行号）
const targets = [
  { page: 2, row: 6 },
  { page: 3, row: 1 },
  { page: 4, row: 8 },
];
const ctx = doc.context;
// 先注册为间接对象再互链（Parent ↔ First/Last 会形成引用环，直接对象会栈溢出）
const outlineItems = targets.map((t) =>
  ctx.register(
    ctx.obj({
      Title: PDFString.of(`goto p${t.page + 1} line ${t.row}`),
      Dest: [doc.getPage(t.page).ref, PDFName.of("XYZ"), 72, lines[t.page][t.row], 0],
    })
  )
);
const outlineRoot = ctx.register(
  ctx.obj({
    Type: "Outlines",
    First: outlineItems[0],
    Last: outlineItems[outlineItems.length - 1],
    Count: outlineItems.length,
  })
);
outlineItems.forEach((ref, i) => {
  const d = ctx.lookup(ref);
  d.set(PDFName.of("Parent"), outlineRoot);
  if (i > 0) d.set(PDFName.of("Prev"), outlineItems[i - 1]);
  if (i < outlineItems.length - 1) d.set(PDFName.of("Next"), outlineItems[i + 1]);
});
doc.catalog.set(PDFName.of("Outlines"), outlineRoot);

const pdfBytes = await doc.save();
await fs.promises.mkdir("e2e/fixtures", { recursive: true });
fs.writeFileSync("e2e/fixtures/sample-outline.pdf", pdfBytes);
console.log("Generated e2e/fixtures/sample-outline.pdf");
