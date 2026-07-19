import * as pdfjsLib from "pdfjs-dist";
import i18n from "i18next";
import {
  getOpenFileHashes,
  getOpenPdfMeta,
  getPdfBytes,
  isAuthorized,
  setOpenPdfNumPages,
} from "./pdfToolsRegistry";

export interface ToolCallResult {
  /** Short description for UI status indicators. */
  summary: string;
  /** Full text sent back to the model as the tool result. */
  result: string;
}

export interface ToolSession {
  executeToolCall(name: string, argsJson: string): Promise<ToolCallResult>;
  dispose(): Promise<void>;
}

interface LoadedDoc {
  pdf: pdfjsLib.PDFDocumentProxy;
  pageTextCache: Map<number, Promise<string>>;
}

const PAGE_TEXT_LIMIT = 8000;

/**
 * Begin a transient tool session. Documents are loaded lazily and destroyed
 * when `dispose()` is called. Always use try/finally to dispose.
 */
export function beginToolSession(): ToolSession {
  const docs = new Map<string, LoadedDoc>();

  const loadDoc = async (fileHash: string): Promise<pdfjsLib.PDFDocumentProxy> => {
    const existing = docs.get(fileHash);
    if (existing) return existing.pdf;

    if (!isAuthorized(fileHash)) {
      throw new Error(`PDF not open: ${fileHash}`);
    }

    const meta = getOpenPdfMeta(fileHash);
    if (!meta) {
      throw new Error(`PDF metadata missing: ${fileHash}`);
    }

    const bytes = await getPdfBytes(meta.filePath);
    const loadingTask = pdfjsLib.getDocument({ data: bytes });
    const pdf = await loadingTask.promise;
    setOpenPdfNumPages(fileHash, pdf.numPages);
    docs.set(fileHash, { pdf, pageTextCache: new Map() });
    return pdf;
  };

  const getPageText = async (fileHash: string, pageNumber: number): Promise<string> => {
    const loaded = docs.get(fileHash);
    if (!loaded) {
      await loadDoc(fileHash);
      return getPageText(fileHash, pageNumber);
    }
    const cached = loaded.pageTextCache.get(pageNumber);
    if (cached) return cached;

    const promise = (async () => {
      const page = await loaded.pdf.getPage(pageNumber);
      try {
        const textContent = await page.getTextContent();
        const parts: string[] = [];
        for (const item of textContent.items) {
          if (typeof (item as any).str === "string") {
            parts.push((item as any).str);
            if ((item as any).hasEOL) {
              parts.push("\n");
            }
          }
        }
        const fullText = parts.join("");
        if (fullText.length > PAGE_TEXT_LIMIT) {
          return (
            fullText.slice(0, PAGE_TEXT_LIMIT) +
            `\n... [truncated, page has ${fullText.length} chars total]`
          );
        }
        return fullText;
      } finally {
        page.cleanup();
      }
    })();
    loaded.pageTextCache.set(pageNumber, promise);
    return promise;
  };

  const executeToolCall = async (
    name: string,
    argsJson: string
  ): Promise<ToolCallResult> => {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson);
    } catch {
      return {
        summary: i18n.t("tools.callUnknown", { name }),
        result: `Error: invalid arguments JSON for ${name}`,
      };
    }

    switch (name) {
      case "list_open_pdfs": {
        const hashes = getOpenFileHashes();
        const list = hashes
          .map((hash) => {
            const meta = getOpenPdfMeta(hash);
            const entry: Record<string, unknown> = {
              fileHash: hash,
              fileName: meta?.fileName ?? "",
            };
            if (meta?.numPages !== undefined) {
              entry.numPages = meta.numPages;
            }
            return entry;
          })
          .filter((entry) => entry.fileName);
        return {
          summary: i18n.t("tools.callList"),
          result: JSON.stringify(list),
        };
      }

      case "read_pdf_page": {
        const fileHash = String(args.file_hash ?? "");
        const pageNumber = Number(args.page_number ?? 0);
        if (!isAuthorized(fileHash)) {
          return {
            summary: i18n.t("tools.callReadPage", { page: pageNumber }),
            result: `Error: PDF not open: ${fileHash}`,
          };
        }
        try {
          const pdf = await loadDoc(fileHash);
          if (pageNumber < 1 || pageNumber > pdf.numPages) {
            return {
              summary: i18n.t("tools.callReadPage", { page: pageNumber }),
              result: `Error: page ${pageNumber} out of range (1..${pdf.numPages})`,
            };
          }
          const text = await getPageText(fileHash, pageNumber);
          return {
            summary: i18n.t("tools.callReadPage", { page: pageNumber }),
            result: text,
          };
        } catch (err) {
          return {
            summary: i18n.t("tools.callReadPage", { page: pageNumber }),
            result: `Error: ${err}`,
          };
        }
      }

      case "search_in_pdf": {
        const fileHash = String(args.file_hash ?? "");
        const query = String(args.query ?? "");
        let maxResults = Number(args.max_results ?? 5);
        maxResults = Math.max(1, Math.min(10, maxResults));
        if (!isAuthorized(fileHash)) {
          return {
            summary: i18n.t("tools.callSearch", { query }),
            result: `Error: PDF not open: ${fileHash}`,
          };
        }
        try {
          const pdf = await loadDoc(fileHash);
          const lowerQuery = query.toLowerCase();
          const results: { page: number; snippet: string }[] = [];
          for (let i = 1; i <= pdf.numPages && results.length < maxResults; i++) {
            const text = await getPageText(fileHash, i);
            const lowerText = text.toLowerCase();
            const idx = lowerText.indexOf(lowerQuery);
            if (idx !== -1) {
              const start = Math.max(0, idx - 100);
              const end = Math.min(text.length, idx + query.length + 100);
              let snippet = text.slice(start, end).replace(/\s+/g, " ");
              if (start > 0) snippet = "..." + snippet;
              if (end < text.length) snippet = snippet + "...";
              results.push({ page: i, snippet });
            }
          }
          if (results.length === 0) {
            return {
              summary: i18n.t("tools.callSearch", { query }),
              result: `No matches found for "${query}".`,
            };
          }
          return {
            summary: i18n.t("tools.callSearch", { query }),
            result: JSON.stringify(results),
          };
        } catch (err) {
          return {
            summary: i18n.t("tools.callSearch", { query }),
            result: `Error: ${err}`,
          };
        }
      }

      default:
        return {
          summary: i18n.t("tools.callUnknown", { name }),
          result: `Error: unknown tool ${name}`,
        };
    }
  };

  return {
    executeToolCall,
    dispose: async () => {
      for (const { pdf } of docs.values()) {
        try {
          await pdf.destroy();
        } catch {
          // ignore cleanup errors
        }
      }
      docs.clear();
    },
  };
}
