import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { beginToolSession } from "./pdfTools";
import { OpenPdfMeta } from "./pdfToolsRegistry";

const mocks = vi.hoisted(() => {
  return {
    pdfjsNumPages: 3,
    pdfjsPageText: {
      1: [{ str: "Page one content about clause 6.2.1.", hasEOL: true }],
      2: [{ str: "Page two content about clause 6.2.2.", hasEOL: true }],
      3: [{ str: "Page three content about clause 6.2.3.", hasEOL: true }],
    } as Record<number, { str: string; hasEOL?: boolean }[]>,
    destroySpy: vi.fn(),
    getPageSpy: vi.fn(),
    getOpenFileHashes: vi.fn(() => ["hash-a"]),
    getOpenPdfMeta: vi.fn((hash: string): OpenPdfMeta | undefined => {
      if (hash === "hash-a") {
        return {
          fileHash: "hash-a",
          fileName: "a.pdf",
          filePath: "/a.pdf",
          numPages: mocks.pdfjsNumPages,
        };
      }
      return undefined;
    }),
    isAuthorized: vi.fn((hash: string) => hash === "hash-a"),
    setOpenPdfNumPages: vi.fn(),
    getPdfBytes: vi.fn((_filePath: string) =>
      Promise.resolve(new Uint8Array([1, 2, 3]))
    ),
  };
});

vi.mock("pdfjs-dist", () => ({
  getDocument: vi.fn(({ data: _data }: { data: Uint8Array }) => {
    return {
      promise: Promise.resolve({
        numPages: mocks.pdfjsNumPages,
        getPage: mocks.getPageSpy.mockImplementation((pageNumber: number) =>
          Promise.resolve({
            getTextContent: vi.fn(() =>
              Promise.resolve({
                items: mocks.pdfjsPageText[pageNumber] ?? [],
              })
            ),
            cleanup: vi.fn(),
          })
        ),
        destroy: mocks.destroySpy,
      }),
    };
  }),
}));

vi.mock("./pdfToolsRegistry", () => ({
  getOpenFileHashes: mocks.getOpenFileHashes,
  getOpenPdfMeta: mocks.getOpenPdfMeta,
  isAuthorized: mocks.isAuthorized,
  setOpenPdfNumPages: mocks.setOpenPdfNumPages,
  getPdfBytes: mocks.getPdfBytes,
}));

describe("pdfTools", () => {
  beforeEach(() => {
    mocks.pdfjsNumPages = 3;
    mocks.pdfjsPageText = {
      1: [{ str: "Page one content about clause 6.2.1.", hasEOL: true }],
      2: [{ str: "Page two content about clause 6.2.2.", hasEOL: true }],
      3: [{ str: "Page three content about clause 6.2.3.", hasEOL: true }],
    };
    mocks.destroySpy.mockReset();
    mocks.getPageSpy.mockClear();
    mocks.getOpenFileHashes.mockReturnValue(["hash-a"]);
    mocks.getOpenPdfMeta.mockImplementation(
      (hash: string): OpenPdfMeta | undefined => {
        if (hash === "hash-a") {
          return {
            fileHash: "hash-a",
            fileName: "a.pdf",
            filePath: "/a.pdf",
            numPages: mocks.pdfjsNumPages,
          };
        }
        return undefined;
      }
    );
    mocks.isAuthorized.mockImplementation((hash: string) => hash === "hash-a");
    mocks.setOpenPdfNumPages.mockReset();
    mocks.getPdfBytes.mockImplementation((_filePath: string) =>
      Promise.resolve(new Uint8Array([1, 2, 3]))
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("list_open_pdfs", () => {
    it("returns authorized PDFs with fileHash and fileName", async () => {
      const session = beginToolSession();
      const { result } = await session.executeToolCall("list_open_pdfs", "{}");
      await session.dispose();

      expect(JSON.parse(result)).toEqual([
        { fileHash: "hash-a", fileName: "a.pdf", numPages: 3 },
      ]);
    });

    it("omits entries with empty fileName", async () => {
      mocks.getOpenPdfMeta.mockReturnValue({
        fileHash: "hash-a",
        fileName: "",
        filePath: "/a.pdf",
      } as OpenPdfMeta);
      const session = beginToolSession();
      const { result } = await session.executeToolCall("list_open_pdfs", "{}");
      await session.dispose();

      expect(JSON.parse(result)).toEqual([]);
    });
  });

  describe("read_pdf_page", () => {
    it("returns the requested page text", async () => {
      const session = beginToolSession();
      const { result } = await session.executeToolCall(
        "read_pdf_page",
        JSON.stringify({ file_hash: "hash-a", page_number: 2 })
      );
      await session.dispose();

      expect(result).toContain("Page two content");
      expect(mocks.getPageSpy).toHaveBeenCalledWith(2);
      expect(mocks.setOpenPdfNumPages).toHaveBeenCalledWith("hash-a", 3);
    });

    it("returns error when file hash is not authorized", async () => {
      const session = beginToolSession();
      const { result } = await session.executeToolCall(
        "read_pdf_page",
        JSON.stringify({ file_hash: "hash-b", page_number: 1 })
      );
      await session.dispose();

      expect(result).toMatch(/^Error: PDF not open/);
    });

    it("returns error when page number is out of range", async () => {
      const session = beginToolSession();
      const { result: tooLow } = await session.executeToolCall(
        "read_pdf_page",
        JSON.stringify({ file_hash: "hash-a", page_number: 0 })
      );
      const { result: tooHigh } = await session.executeToolCall(
        "read_pdf_page",
        JSON.stringify({ file_hash: "hash-a", page_number: 100 })
      );
      await session.dispose();

      expect(tooLow).toMatch(/out of range/);
      expect(tooHigh).toMatch(/out of range/);
    });

    it("truncates pages longer than the character limit", async () => {
      const longText = "a".repeat(9000);
      mocks.pdfjsPageText = {
        1: [{ str: longText, hasEOL: false }],
      };
      const session = beginToolSession();
      const { result } = await session.executeToolCall(
        "read_pdf_page",
        JSON.stringify({ file_hash: "hash-a", page_number: 1 })
      );
      await session.dispose();

      expect(result.length).toBeLessThan(longText.length);
      expect(result).toContain("... [truncated, page has 9000 chars total]");
    });
  });

  describe("search_in_pdf", () => {
    it("returns matching page snippets", async () => {
      const session = beginToolSession();
      const { result } = await session.executeToolCall(
        "search_in_pdf",
        JSON.stringify({ file_hash: "hash-a", query: "clause 6.2.2" })
      );
      await session.dispose();

      const parsed = JSON.parse(result);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].page).toBe(2);
      expect(parsed[0].snippet).toContain("clause 6.2.2");
    });

    it("respects max_results and clamps it to 1..10", async () => {
      mocks.pdfjsPageText = {
        1: [{ str: "first hit", hasEOL: false }],
        2: [{ str: "second hit", hasEOL: false }],
        3: [{ str: "third hit", hasEOL: false }],
      };
      const session = beginToolSession();
      const { result } = await session.executeToolCall(
        "search_in_pdf",
        JSON.stringify({ file_hash: "hash-a", query: "hit", max_results: 2 })
      );
      await session.dispose();

      expect(JSON.parse(result)).toHaveLength(2);
    });

    it("returns no-match text when query is not found", async () => {
      const session = beginToolSession();
      const { result } = await session.executeToolCall(
        "search_in_pdf",
        JSON.stringify({ file_hash: "hash-a", query: "not-present" })
      );
      await session.dispose();

      expect(result).toContain("No matches found");
    });

    it("returns error when file hash is not authorized", async () => {
      const session = beginToolSession();
      const { result } = await session.executeToolCall(
        "search_in_pdf",
        JSON.stringify({ file_hash: "hash-b", query: "clause" })
      );
      await session.dispose();

      expect(result).toMatch(/^Error: PDF not open/);
    });
  });

  describe("error handling", () => {
    it("returns error text for unknown tool names", async () => {
      const session = beginToolSession();
      const { result } = await session.executeToolCall("unknown_tool", "{}");
      await session.dispose();

      expect(result).toContain("unknown tool unknown_tool");
    });

    it("returns error text for invalid JSON arguments", async () => {
      const session = beginToolSession();
      const { result } = await session.executeToolCall(
        "read_pdf_page",
        "not-json"
      );
      await session.dispose();

      expect(result).toContain("invalid arguments JSON");
    });

    it("turns execution exceptions into error text", async () => {
      mocks.getPdfBytes.mockRejectedValue(new Error("disk read failed"));
      const session = beginToolSession();
      const { result } = await session.executeToolCall(
        "read_pdf_page",
        JSON.stringify({ file_hash: "hash-a", page_number: 1 })
      );
      await session.dispose();

      expect(result).toContain("Error:");
      expect(result).toContain("disk read failed");
    });
  });

  describe("session lifecycle", () => {
    it("destroys loaded documents on dispose", async () => {
      const session = beginToolSession();
      await session.executeToolCall(
        "read_pdf_page",
        JSON.stringify({ file_hash: "hash-a", page_number: 1 })
      );
      expect(mocks.destroySpy).not.toHaveBeenCalled();

      await session.dispose();

      expect(mocks.destroySpy).toHaveBeenCalledTimes(1);
    });

    it("caches page text within a session", async () => {
      const session = beginToolSession();
      await session.executeToolCall(
        "read_pdf_page",
        JSON.stringify({ file_hash: "hash-a", page_number: 1 })
      );
      await session.executeToolCall(
        "search_in_pdf",
        JSON.stringify({ file_hash: "hash-a", query: "clause" })
      );
      await session.dispose();

      // read_pdf_page loads page 1; search_in_pdf scans pages 1..3.
      // Page 1 should be reused from cache, so getPage is called once for page 1.
      const page1Calls = mocks.getPageSpy.mock.calls.filter(([p]) => p === 1);
      expect(page1Calls).toHaveLength(1);
    });

    it("dispose is idempotent", async () => {
      const session = beginToolSession();
      await session.executeToolCall(
        "read_pdf_page",
        JSON.stringify({ file_hash: "hash-a", page_number: 1 })
      );
      await session.dispose();
      await session.dispose();

      expect(mocks.destroySpy).toHaveBeenCalledTimes(1);
    });
  });
});
