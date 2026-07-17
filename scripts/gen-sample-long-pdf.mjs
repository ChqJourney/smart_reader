import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fs from "fs";

// 60-page fixture: crosses the 50-page viewport-preload threshold, so the
// viewport manager only preloads a window around the visible pages — the
// scenario behind the fit-to-width horizontal shift and the deep-zoom page
// jitter bugs.
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.HelveticaBold);

const NUM_PAGES = 60;

for (let i = 0; i < NUM_PAGES; i++) {
  const page = doc.addPage([612, 792]);
  const text = `PAGE ${i + 1}`;
  const textSize = 72;
  const textWidth = font.widthOfTextAtSize(text, textSize);
  page.drawText(text, {
    x: (612 - textWidth) / 2,
    y: 792 / 2,
    size: textSize,
    font,
    color: rgb(0, 0, 0),
  });
}

const pdfBytes = await doc.save();
await fs.promises.mkdir("e2e/fixtures", { recursive: true });
fs.writeFileSync("e2e/fixtures/sample-long.pdf", pdfBytes);
console.log("Generated e2e/fixtures/sample-long.pdf");
