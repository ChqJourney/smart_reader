import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fs from 'fs';

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.HelveticaBold);

const pageSizes = [
  [612, 792],
  [612, 700],
  [612, 900],
  [612, 792],
  [612, 650],
  [612, 800],
  [612, 792],
  [612, 750],
  [612, 850],
  [612, 792],
];

for (let i = 0; i < pageSizes.length; i++) {
  const [width, height] = pageSizes[i];
  const page = doc.addPage([width, height]);
  const text = `PAGE ${i + 1}`;
  const textSize = 72;
  const textWidth = font.widthOfTextAtSize(text, textSize);
  page.drawText(text, {
    x: (width - textWidth) / 2,
    y: height / 2,
    size: textSize,
    font,
    color: rgb(0, 0, 0),
  });
}

const pdfBytes = await doc.save();
await fs.promises.mkdir('e2e/fixtures', { recursive: true });
fs.writeFileSync('e2e/fixtures/sample.pdf', pdfBytes);
console.log('Generated e2e/fixtures/sample.pdf');
