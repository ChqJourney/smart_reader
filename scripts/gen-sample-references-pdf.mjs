import { PDFDocument, PDFName, StandardFonts, degrees } from "pdf-lib";
import fs from "fs";

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const pages = [
  [
    "Contents",
    "5.2.3 Test requirements ........ 3",
    "Table 3 Test conditions ........ 3",
    "Figure 2 Test setup ........ 4",
  ],
  ["Introduction", "See Table 3 and Figure 2 for details."],
  ["5.2.3 Test requirements", "Table 3 Test conditions"],
  ["Figure 2 Test setup", "Table 4 First candidate"],
  ["Table 4 Second candidate"],
];
const baselines = [600, 500, 400, 300];

pages.forEach((lines, pageIndex) => {
  const page = doc.addPage([612, 792]);
  if (pageIndex === 4) page.setRotation(degrees(90));
  lines.forEach((text, index) => {
    page.drawText(text, {
      x: 72,
      y: baselines[index],
      size: 12,
      font,
    });
  });
});

doc.catalog.set(
  PDFName.of("PageLabels"),
  doc.context.obj({ Nums: [0, { S: "r" }, 2, { S: "D", St: 1 }] })
);
const bytes = await doc.save();
await fs.promises.mkdir("e2e/fixtures", { recursive: true });
await fs.promises.writeFile("e2e/fixtures/sample-references.pdf", bytes);
console.log("Generated e2e/fixtures/sample-references.pdf");
