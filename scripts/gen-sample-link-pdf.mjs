/**
 * 生成带内部交叉引用链接（GoTo dest）的样例 PDF，供条款链接悬停预览（画中画）
 * 功能演示 / 落地页录制使用。输出 e2e/fixtures/sample-links.pdf。
 *
 * 结构：封面 + 第 4 章（含多条"见 X.Y"引用链接）+ 被引用章节 + 附录 A/B。
 * 引用文字绘制成蓝色带下划线，链接注释指向目标章节标题的 XYZ dest，
 * 与真实标准 PDF 的内部链接形态一致。
 */
import { PDFDocument, PDFName, PDFArray, rgb, StandardFonts } from "pdf-lib";
import fs from "fs";

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_X = 72;
const HEADING_Y = PAGE_H - 100;

const doc = await PDFDocument.create();
const titleFont = await doc.embedFont(StandardFonts.HelveticaBold);
const bodyFont = await doc.embedFont(StandardFonts.Helvetica);
const linkColor = rgb(0.1, 0.3, 0.8);
const textColor = rgb(0.1, 0.1, 0.1);

// 先建页，后绘制（链接 dest 需要目标页 ref）
const NUM_PAGES = 9;
const pages = [];
for (let i = 0; i < NUM_PAGES; i++) {
  pages.push(doc.addPage([PAGE_W, PAGE_H]));
}

function addLinkAnnot(page, rect, destPage, destY) {
  const annot = doc.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: rect,
    Border: [0, 0, 0],
    Dest: [destPage.ref, PDFName.of("XYZ"), null, destY, null],
  });
  const ref = doc.context.register(annot);
  const annotsKey = PDFName.of("Annots");
  if (page.node.get(annotsKey)) {
    page.node.lookup(annotsKey, PDFArray).push(ref);
  } else {
    page.node.set(annotsKey, doc.context.obj([ref]));
  }
}

function drawHeading(page, text, y = HEADING_Y) {
  page.drawText(text, {
    x: MARGIN_X,
    y,
    size: 16,
    font: titleFont,
    color: textColor,
  });
}

function drawBodyLine(page, text, y) {
  page.drawText(text, {
    x: MARGIN_X,
    y,
    size: 11,
    font: bodyFont,
    color: textColor,
  });
}

// 绘制一行含引用链接的文字。segments: [{ text, target?: { pageIndex, y } }]
function drawRefLine(page, y, segments) {
  let x = MARGIN_X;
  const size = 11;
  for (const seg of segments) {
    const w = bodyFont.widthOfTextAtSize(seg.text, size);
    if (seg.target) {
      page.drawText(seg.text, { x, y, size, font: bodyFont, color: linkColor });
      page.drawLine({
        start: { x, y: y - 2 },
        end: { x: x + w, y: y - 2 },
        thickness: 0.7,
        color: linkColor,
      });
      addLinkAnnot(
        page,
        [x, y - 3, x + w, y + 9],
        pages[seg.target.pageIndex],
        seg.target.y
      );
    } else {
      page.drawText(seg.text, { x, y, size, font: bodyFont, color: textColor });
    }
    x += w;
  }
}

// 被引用章节标题位置表（pageIndex 从 0 起）
const T = {
  5.1: { pageIndex: 3, y: HEADING_Y },
  5.2: { pageIndex: 4, y: HEADING_Y },
  6.3: { pageIndex: 5, y: HEADING_Y },
  7.2: { pageIndex: 6, y: HEADING_Y },
  annexA: { pageIndex: 7, y: HEADING_Y },
  annexB: { pageIndex: 8, y: HEADING_Y },
};

// ---- Page 1: 封面 ----
const cover = pages[0];
const title = "SPEC-2025-001";
cover.drawText(title, {
  x: (PAGE_W - titleFont.widthOfTextAtSize(title, 40)) / 2,
  y: PAGE_H / 2 + 40,
  size: 40,
  font: titleFont,
  color: textColor,
});
const sub = "Sample Standard for Link Preview Demo";
cover.drawText(sub, {
  x: (PAGE_W - titleFont.widthOfTextAtSize(sub, 16)) / 2,
  y: PAGE_H / 2,
  size: 16,
  font: titleFont,
  color: textColor,
});
const note = "Self-made demo document - not a real standard.";
cover.drawText(note, {
  x: (PAGE_W - bodyFont.widthOfTextAtSize(note, 11)) / 2,
  y: PAGE_H / 2 - 30,
  size: 11,
  font: bodyFont,
  color: rgb(0.5, 0.5, 0.5),
});

// ---- Page 2: Clause 4（含引用链接） ----
const p2 = pages[1];
drawHeading(p2, "4 Test conditions");
drawBodyLine(p2, "4.1 General", PAGE_H - 140);
drawRefLine(p2, PAGE_H - 170, [
  {
    text: "Unless otherwise specified, the tests shall be carried out according to the",
  },
]);
drawRefLine(p2, PAGE_H - 190, [
  { text: "sequence given in " },
  { text: "5.2", target: T["5.2"] },
  { text: "." },
]);
drawRefLine(p2, PAGE_H - 230, [
  { text: "The test sample shall comply with the general requirements of " },
  { text: "5.1", target: T["5.1"] },
  { text: "." },
]);
drawRefLine(p2, PAGE_H - 270, [
  {
    text: "Where measurement results are evaluated, the uncertainty stated in",
  },
]);
drawRefLine(p2, PAGE_H - 290, [
  { text: "6.3", target: T["6.3"] },
  { text: " shall be taken into account." },
]);

// ---- Page 3: Clause 4 续（含引用链接） ----
const p3 = pages[2];
drawHeading(p3, "4.2 Environmental conditions");
drawRefLine(p3, PAGE_H - 140, [
  {
    text: "Tests shall be performed under the ambient conditions specified in ",
  },
  { text: "Annex A", target: T.annexA },
  { text: "." },
]);
drawRefLine(p3, PAGE_H - 180, [
  { text: "The acceptance criteria of " },
  { text: "7.2", target: T["7.2"] },
  { text: " apply to all type tests." },
]);
drawRefLine(p3, PAGE_H - 220, [
  { text: "For the marking requirements, see " },
  { text: "Annex B", target: T.annexB },
  { text: "." },
]);

// ---- Pages 4-9: 被引用章节 ----
const targets = [
  { page: pages[3], heading: "5.1 General requirements" },
  { page: pages[4], heading: "5.2 Test sequence" },
  { page: pages[5], heading: "6.3 Measurement uncertainty" },
  { page: pages[6], heading: "7.2 Acceptance criteria" },
  { page: pages[7], heading: "Annex A (normative) Ambient test conditions" },
  { page: pages[8], heading: "Annex B (informative) Marking examples" },
];
for (const t of targets) {
  drawHeading(t.page, t.heading);
  for (let i = 0; i < 8; i++) {
    drawBodyLine(
      t.page,
      `Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor ${i + 1}.`,
      PAGE_H - 150 - i * 22
    );
  }
}

const pdfBytes = await doc.save();
await fs.promises.mkdir("e2e/fixtures", { recursive: true });
fs.writeFileSync("e2e/fixtures/sample-links.pdf", pdfBytes);
console.log(
  "Generated e2e/fixtures/sample-links.pdf (9 pages, internal links on pages 2-3)"
);
