/**
 * Registry of currently open PDFs used by the agent tool layer.
 *
 * Only lightweight metadata is kept resident (no pdfjs instances). The actual
 * PDFDocumentProxy objects are created transiently inside a ToolSession and
 * destroyed when the agent loop ends.
 */

import { invoke } from "@tauri-apps/api/core";

export interface OpenPdfMeta {
  fileHash: string;
  fileName: string;
  filePath: string;
  numPages?: number;
}

interface Registry {
  pdfs: Map<string, OpenPdfMeta>;
  getCachedBytes?: (filePath: string) => Uint8Array | undefined;
}

const registry: Registry = {
  pdfs: new Map(),
};

/**
 * Synchronize the registry with the currently open tabs.
 * Called from App.tsx whenever tabs change.
 */
export function syncOpenPdfs(
  tabs: { fileHash: string; fileName: string; filePath: string }[],
  getCachedBytes?: (filePath: string) => Uint8Array | undefined
): void {
  registry.getCachedBytes = getCachedBytes;
  const next = new Map<string, OpenPdfMeta>();
  for (const tab of tabs) {
    const existing = registry.pdfs.get(tab.fileHash);
    next.set(tab.fileHash, {
      ...tab,
      numPages: existing?.numPages,
    });
  }
  registry.pdfs = next;
}

/** Return all currently authorized file hashes. */
export function getOpenFileHashes(): string[] {
  return Array.from(registry.pdfs.keys());
}

/** Check whether a file hash is currently authorized (i.e. an open tab). */
export function isAuthorized(fileHash: string): boolean {
  return registry.pdfs.has(fileHash);
}

/** Look up metadata for an authorized file hash. */
export function getOpenPdfMeta(fileHash: string): OpenPdfMeta | undefined {
  return registry.pdfs.get(fileHash);
}

/**
 * Update the numPages field for a file hash after a document has been loaded.
 */
export function setOpenPdfNumPages(fileHash: string, numPages: number): void {
  const meta = registry.pdfs.get(fileHash);
  if (meta) {
    meta.numPages = numPages;
  }
}

/**
 * Get PDF bytes for a file path. Prefer the App-level cache; fall back to
 * reading from disk via the backend.
 */
export async function getPdfBytes(filePath: string): Promise<Uint8Array> {
  const cached = registry.getCachedBytes?.(filePath);
  if (cached) {
    return cached.slice();
  }
  return invoke<Uint8Array>("read_pdf_bytes", { filePath });
}
