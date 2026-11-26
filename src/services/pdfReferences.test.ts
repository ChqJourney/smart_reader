import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPdfReferenceIndex,
  clearPdfReferenceIndexes,
  resolvePdfReference,
  resolvePdfPageLabel,
} from "./pdfReferences";

const mocks = vi.hoisted(() => ({
  getOpenPdfMeta: vi.fn(),
  getPdfBytes: vi.fn(),
  getDocument: vi.fn(),
}));

vi.mock("./pdfToolsRegistry", () => ({
  getOpenPdfMeta: mocks.getOpenPdfMeta,
  getPdfBytes: mocks.getPdfBytes,
}));
vi.mock("./pdfjs", () => ({
  loadPdfjs: vi.fn(async () => ({ getDocument: mocks.getDocument })),
}));

function item(str: string, x: number, y: number) {
  return {
    str,
    transform: [1, 0, 0, 1, x, y],
    height: 10,
  };
}

function makePdf(pages: unknown[][][]) {
  return {
    numPages: pages.length,
    getPage: vi.fn(async (pageNumber: number) => ({
      getViewport: () => ({
        convertToViewportPoint: (x: number, y: number) => [x, y],
      }),
      getTextContent: vi.fn(async () => ({
        items: pages[pageNumber - 1].flat(),
      })),
      cleanup: vi.fn(),
    })),
    destroy: vi.fn(async () => {}),
    getPageLabels: vi.fn(async (): Promise<string[] | null> => null),
  };
}

const pdf = makePdf([
  [
    [item("Contents", 10, 20)],
    [item("5.2.3 Test requirements ........ 12", 10, 40)],
    [item("See Table 3 for details", 10, 60)],
  ],
  [
    [item("5.", 10, 20), item("2.3 Test requirements", 25, 20)],
    [item("Table 3 — Test conditions", 10, 60)],
    [item("Figure 2 — Test setup", 10, 80)],
  ],
  [
    [item("Table 3 — Alternative conditions", 10, 20)],
    [item("A.1 Annex test", 10, 40)],
    [item("Fig. 2 — Alternative setup", 10, 60)],
  ],
  [],
]);

beforeEach(() => {
  clearPdfReferenceIndexes();
  mocks.getOpenPdfMeta.mockReturnValue({
    fileHash: "hash-1",
    fileName: "standard.pdf",
    filePath: "/standard.pdf",
  });
  mocks.getPdfBytes.mockResolvedValue(new Uint8Array([1]));
  mocks.getDocument.mockReturnValue({ promise: Promise.resolve(pdf) });
});

describe("PDF reference index", () => {
  it("joins split headings and excludes contents and prose references", async () => {
    const index = await buildPdfReferenceIndex(pdf as never);
    const clause = index.references.find(
      (target) => target.kind === "clause" && target.normalizedId === "5.2.3"
    );
    expect(clause).toMatchObject({ page: 2, pdfY: 10 });
    expect(index.references).toHaveLength(6);
    expect(
      index.references.some((target) => target.caption.includes("........"))
    ).toBe(false);
    expect(
      index.references.some((target) => target.caption.startsWith("See Table"))
    ).toBe(false);
  });

  it("returns a unique target and caches the index per file", async () => {
    const resolution = await resolvePdfReference("hash-1", {
      kind: "clause",
      label: "Clause A.1",
      normalizedId: "A.1",
    });
    expect(resolution).toMatchObject({
      status: "found",
      target: { page: 3, pdfY: 30 },
    });
    await resolvePdfReference("hash-1", {
      kind: "figure",
      label: "Figure 2",
      normalizedId: "2",
    });
    expect(mocks.getDocument).toHaveBeenCalledTimes(1);
  });

  it("returns all candidates for duplicate table numbers", async () => {
    const resolution = await resolvePdfReference("hash-1", {
      kind: "table",
      label: "Table 3",
      normalizedId: "3",
    });
    expect(resolution.status).toBe("ambiguous");
    if (resolution.status === "ambiguous") {
      expect(resolution.candidates.map((target) => target.page)).toEqual([
        2, 3,
      ]);
    }
  });

  it("distinguishes missing references from an unavailable text layer", async () => {
    const missing = await resolvePdfReference("hash-1", {
      kind: "table",
      label: "Table 99",
      normalizedId: "99",
    });
    expect(missing.status).toBe("notFound");

    const scanned = makePdf([[], []]);
    mocks.getDocument.mockReturnValue({ promise: Promise.resolve(scanned) });
    clearPdfReferenceIndexes();
    const unavailable = await resolvePdfReference("hash-1", {
      kind: "figure",
      label: "Figure 2",
      normalizedId: "2",
    });
    expect(unavailable.status).toBe("textUnavailable");
  });

  it("distinguishes an unopened PDF from a missing reference", async () => {
    mocks.getOpenPdfMeta.mockReturnValue(undefined);

    expect(
      (
        await resolvePdfReference("hash-closed", {
          kind: "clause",
          label: "Clause A.1",
          normalizedId: "A.1",
        })
      ).status
    ).toBe("fileNotOpen");
    expect((await resolvePdfPageLabel("hash-closed", "II")).status).toBe(
      "fileNotOpen"
    );
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });

  it("maps printed labels to physical pages and reports duplicate labels", async () => {
    pdf.getPageLabels.mockResolvedValue(["i", "ii", "1", "1", "2"]);
    const roman = await resolvePdfPageLabel("hash-1", "II");
    expect(roman).toMatchObject({
      status: "found",
      target: { kind: "page", page: 2, pdfY: 0 },
    });

    const duplicate = await resolvePdfPageLabel("hash-1", "1");
    expect(duplicate.status).toBe("ambiguous");
    if (duplicate.status === "ambiguous") {
      expect(duplicate.candidates.map((target) => target.page)).toEqual([3, 4]);
    }

    expect((await resolvePdfPageLabel("hash-1", "96")).status).toBe("notFound");
  });
});
