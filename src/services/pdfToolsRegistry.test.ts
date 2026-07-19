import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  syncOpenPdfs,
  getOpenFileHashes,
  isAuthorized,
  getOpenPdfMeta,
  setOpenPdfNumPages,
  getPdfBytes,
} from "./pdfToolsRegistry";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("pdfToolsRegistry", () => {
  beforeEach(() => {
    // Reset the module-level registry to a clean state.
    syncOpenPdfs([]);
    invokeMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("syncOpenPdfs", () => {
    it("adds open tabs and exposes their hashes", () => {
      syncOpenPdfs([
        { fileHash: "hash-a", fileName: "a.pdf", filePath: "/a.pdf" },
        { fileHash: "hash-b", fileName: "b.pdf", filePath: "/b.pdf" },
      ]);

      expect(getOpenFileHashes()).toEqual(["hash-a", "hash-b"]);
      expect(isAuthorized("hash-a")).toBe(true);
      expect(isAuthorized("hash-b")).toBe(true);
      expect(isAuthorized("hash-c")).toBe(false);
    });

    it("removes closed tabs so they are no longer authorized", () => {
      syncOpenPdfs([
        { fileHash: "hash-a", fileName: "a.pdf", filePath: "/a.pdf" },
        { fileHash: "hash-b", fileName: "b.pdf", filePath: "/b.pdf" },
      ]);

      syncOpenPdfs([
        { fileHash: "hash-a", fileName: "a.pdf", filePath: "/a.pdf" },
      ]);

      expect(getOpenFileHashes()).toEqual(["hash-a"]);
      expect(isAuthorized("hash-b")).toBe(false);
      expect(getOpenPdfMeta("hash-b")).toBeUndefined();
    });

    it("preserves numPages when re-syncing the same hash", () => {
      syncOpenPdfs([
        { fileHash: "hash-a", fileName: "a.pdf", filePath: "/a.pdf" },
      ]);
      setOpenPdfNumPages("hash-a", 42);

      syncOpenPdfs([
        { fileHash: "hash-a", fileName: "a.pdf", filePath: "/a.pdf" },
      ]);

      expect(getOpenPdfMeta("hash-a")?.numPages).toBe(42);
    });

    it("drops numPages for hashes that are removed", () => {
      syncOpenPdfs([
        { fileHash: "hash-a", fileName: "a.pdf", filePath: "/a.pdf" },
      ]);
      setOpenPdfNumPages("hash-a", 42);

      syncOpenPdfs([]);
      syncOpenPdfs([
        { fileHash: "hash-a", fileName: "a.pdf", filePath: "/a.pdf" },
      ]);

      expect(getOpenPdfMeta("hash-a")?.numPages).toBeUndefined();
    });
  });

  describe("getPdfBytes", () => {
    it("returns cached bytes when available", async () => {
      const cached = new Uint8Array([10, 20, 30]);
      syncOpenPdfs(
        [{ fileHash: "hash-a", fileName: "a.pdf", filePath: "/a.pdf" }],
        () => cached
      );

      const result = await getPdfBytes("/a.pdf");

      expect(result).toEqual(cached);
      expect(result).not.toBe(cached); // should be a copy
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it("falls back to read_pdf_bytes when cache misses", async () => {
      syncOpenPdfs(
        [{ fileHash: "hash-a", fileName: "a.pdf", filePath: "/a.pdf" }],
        () => undefined
      );
      invokeMock.mockResolvedValue(new Uint8Array([1, 2, 3]));

      const result = await getPdfBytes("/a.pdf");

      expect(result).toEqual(new Uint8Array([1, 2, 3]));
      expect(invokeMock).toHaveBeenCalledWith("read_pdf_bytes", {
        filePath: "/a.pdf",
      });
    });

    it("falls back to read_pdf_bytes when no cache getter is registered", async () => {
      syncOpenPdfs([
        { fileHash: "hash-a", fileName: "a.pdf", filePath: "/a.pdf" },
      ]);
      invokeMock.mockResolvedValue(new Uint8Array([4, 5, 6]));

      const result = await getPdfBytes("/a.pdf");

      expect(result).toEqual(new Uint8Array([4, 5, 6]));
      expect(invokeMock).toHaveBeenCalledWith("read_pdf_bytes", {
        filePath: "/a.pdf",
      });
    });
  });
});
