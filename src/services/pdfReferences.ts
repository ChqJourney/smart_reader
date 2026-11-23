import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem as PdfjsTextItem } from "pdfjs-dist/types/src/display/api";
import type { PdfReference, PdfReferenceKind } from "./citations";
import { loadPdfjs } from "./pdfjs";
import { getOpenPdfMeta, getPdfBytes } from "./pdfToolsRegistry";

export interface PdfReferenceTarget extends PdfReference {
  page: number;
  pdfY: number;
  caption: string;
}

export type PdfReferenceResolution =
  | { status: "found"; target: PdfReferenceTarget }
  | { status: "ambiguous"; candidates: PdfReferenceTarget[] }
  | { status: "notFound" | "textUnavailable" };

interface PdfReferenceIndex {
  references: PdfReferenceTarget[];
  hasText: boolean;
}

interface PositionedTextItem {
  text: string;
  x: number;
  baselineY: number;
  top: number;
  height: number;
}

interface TextLine {
  items: PositionedTextItem[];
  baselineY: number;
}

const indexCache = new Map<string, Promise<PdfReferenceIndex>>();
const pageLabelsCache = new Map<string, Promise<string[] | null>>();
const REFERENCE_ID = String.raw`(?:[A-Z](?:\.\d+)+|\d+(?:\.\d+)*)(?:[A-Z])?`;
const CLAUSE_PATTERN = new RegExp(
  String.raw`^(?:第\s*)?(${REFERENCE_ID})(?![\d.])`,
  "i"
);
const TABLE_PATTERN = new RegExp(
  String.raw`^(?:TABLE|表)\s*(${REFERENCE_ID})(?![\d.A-Z])`,
  "i"
);
const FIGURE_PATTERN = new RegExp(
  String.raw`^(?:FIGURE|FIG\.|图)\s*(${REFERENCE_ID})(?![\d.A-Z])`,
  "i"
);

function normalizedCaption(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\s*\.\s*/g, ".")
    .trim();
}

function referenceTarget(
  kind: PdfReferenceKind,
  normalizedId: string,
  page: number,
  line: TextLine
): PdfReferenceTarget {
  const items = [...line.items].sort((a, b) => a.x - b.x);
  const caption = normalizedCaption(items.map((item) => item.text).join(" "));
  return {
    kind,
    label: caption,
    normalizedId: normalizedId.toUpperCase(),
    page,
    pdfY: Math.max(0, Math.min(...items.map((item) => item.top))),
    caption: caption.slice(0, 240),
  };
}

function collectLineReferences(
  page: number,
  line: TextLine
): PdfReferenceTarget[] {
  const text = normalizedCaption(
    [...line.items]
      .sort((a, b) => a.x - b.x)
      .map((item) => item.text)
      .join(" ")
  );
  if (!text || /\.{3,}|…{2,}/.test(text)) return [];
  const targets: PdfReferenceTarget[] = [];
  const clause = text.match(CLAUSE_PATTERN)?.[1];
  if (clause) {
    targets.push(referenceTarget("clause", clause, page, line));
  }
  const table = text.match(TABLE_PATTERN)?.[1];
  if (table) {
    targets.push(referenceTarget("table", table, page, line));
  }
  const figure = text.match(FIGURE_PATTERN)?.[1];
  if (figure) {
    targets.push(referenceTarget("figure", figure, page, line));
  }
  return targets;
}

function buildLines(
  items: readonly unknown[],
  viewport: {
    convertToViewportPoint(x: number, y: number): number[];
  }
): { lines: TextLine[]; hasText: boolean } {
  const lines: TextLine[] = [];
  let hasText = false;
  for (const item of items) {
    if (!item || typeof item !== "object" || !("str" in item)) continue;
    const textItem = item as PdfjsTextItem;
    const text = textItem.str.replace(/\s+/g, " ").trim();
    if (!text) continue;
    hasText = true;
    const [x, baselineY] = viewport.convertToViewportPoint(
      textItem.transform[4],
      textItem.transform[5]
    );
    const height = textItem.height || 10;
    const positioned = {
      text,
      x,
      baselineY,
      top: baselineY - height,
      height,
    };
    const previous = lines[lines.length - 1];
    const tolerance = Math.max(2, height * 0.5);
    if (previous && Math.abs(previous.baselineY - baselineY) <= tolerance) {
      previous.items.push(positioned);
      previous.baselineY = baselineY;
    } else {
      lines.push({ items: [positioned], baselineY });
    }
  }
  return { lines, hasText };
}

export async function buildPdfReferenceIndex(
  pdf: PDFDocumentProxy
): Promise<PdfReferenceIndex> {
  const references: PdfReferenceTarget[] = [];
  let hasText = false;
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    try {
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const pageLines = buildLines(content.items, viewport);
      hasText ||= pageLines.hasText;
      for (const line of pageLines.lines) {
        references.push(...collectLineReferences(pageNumber, line));
      }
    } finally {
      page.cleanup();
    }
  }
  return { references, hasText };
}

async function loadReferenceIndex(
  fileHash: string
): Promise<PdfReferenceIndex> {
  const cached = indexCache.get(fileHash);
  if (cached) return cached;
  const pending = (async () => {
    const meta = getOpenPdfMeta(fileHash);
    if (!meta) return { references: [], hasText: false };
    const bytes = await getPdfBytes(meta.filePath);
    const { getDocument } = await loadPdfjs();
    const pdf = await getDocument({ data: bytes }).promise;
    try {
      return await buildPdfReferenceIndex(pdf);
    } finally {
      await pdf.destroy();
    }
  })();
  indexCache.set(fileHash, pending);
  try {
    return await pending;
  } catch (error) {
    indexCache.delete(fileHash);
    throw error;
  }
}

export async function resolvePdfReference(
  fileHash: string,
  reference: PdfReference
): Promise<PdfReferenceResolution> {
  if (!getOpenPdfMeta(fileHash)) return { status: "notFound" };
  const index = await loadReferenceIndex(fileHash);
  const matches = index.references.filter(
    (candidate) =>
      candidate.kind === reference.kind &&
      candidate.normalizedId === reference.normalizedId
  );
  const candidates = Array.from(
    new Map(
      matches.map((candidate) => [
        `${candidate.page}:${candidate.pdfY}:${candidate.caption}`,
        candidate,
      ])
    ).values()
  );
  if (candidates.length === 1) {
    return { status: "found", target: candidates[0] };
  }
  if (candidates.length > 1) return { status: "ambiguous", candidates };
  return { status: index.hasText ? "notFound" : "textUnavailable" };
}

async function loadPageLabels(fileHash: string): Promise<string[] | null> {
  const cached = pageLabelsCache.get(fileHash);
  if (cached) return cached;
  const pending = (async () => {
    const meta = getOpenPdfMeta(fileHash);
    if (!meta) return null;
    const bytes = await getPdfBytes(meta.filePath);
    const { getDocument } = await loadPdfjs();
    const pdf = await getDocument({ data: bytes }).promise;
    try {
      return await pdf.getPageLabels();
    } finally {
      await pdf.destroy();
    }
  })();
  pageLabelsCache.set(fileHash, pending);
  try {
    return await pending;
  } catch (error) {
    pageLabelsCache.delete(fileHash);
    throw error;
  }
}

export async function resolvePdfPageLabel(
  fileHash: string,
  printedPage: string
): Promise<PdfReferenceResolution> {
  if (!getOpenPdfMeta(fileHash)) return { status: "notFound" };
  const labels = await loadPageLabels(fileHash);
  const normalized = printedPage.trim().toLowerCase();
  const pages = (labels ?? [])
    .map((label, index) => ({
      label: label.trim().toLowerCase(),
      page: index + 1,
    }))
    .filter((entry) => entry.label === normalized)
    .map((entry) => entry.page);
  const candidates = pages.map((page) => ({
    kind: "page" as const,
    label: printedPage,
    normalizedId: printedPage.toUpperCase(),
    page,
    pdfY: 0,
    caption: printedPage,
  }));
  if (candidates.length === 1) {
    return { status: "found", target: candidates[0] };
  }
  if (candidates.length > 1) return { status: "ambiguous", candidates };
  return { status: "notFound" };
}

export function prunePdfReferenceIndexes(): void {
  for (const fileHash of indexCache.keys()) {
    if (!getOpenPdfMeta(fileHash)) indexCache.delete(fileHash);
  }
  for (const fileHash of pageLabelsCache.keys()) {
    if (!getOpenPdfMeta(fileHash)) pageLabelsCache.delete(fileHash);
  }
}

export function clearPdfReferenceIndexes(): void {
  indexCache.clear();
  pageLabelsCache.clear();
}
