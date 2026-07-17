import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as pdfjsLib from "pdfjs-dist";
import { error as logError } from "../services/logs";

/**
 * Outline (bookmark) tree item, mirroring pdf.js' outline shape. Exported here
 * so PdfViewer and any future consumer share a single definition.
 */
export interface OutlineItem {
  title: string;
  dest?: string | unknown[] | null;
  url?: string | null;
  items: OutlineItem[];
}

export interface UsePdfDocumentOptions {
  filePath: string;
  /** Cached file bytes (tab cache). When present, skips re-reading from disk. */
  cachedBytes?: Uint8Array;
  /** Notifies the parent of freshly-read bytes so it can cache them. */
  onPdfLoaded?: (filePath: string, bytes: Uint8Array) => void;
}

export interface UsePdfDocumentResult {
  pdf: pdfjsLib.PDFDocumentProxy | null;
  numPages: number;
  isLoading: boolean;
  error: string;
  outline: OutlineItem[];
}

/**
 * Owns PDF document loading, caching, and outline extraction.
 *
 * Extracted from PdfViewer so the load lifecycle (filePath change → read bytes
 * → pdf.js getDocument → cleanup on unmount) is isolated from the viewer's
 * viewport/scroll state. The viewer keeps responsibility for resetting its own
 * viewport/page state when `filePath` changes (via a separate effect), since
 * that state lives outside this hook.
 *
 * Why each viewer keeps its own PDFDocumentProxy: pdf.js transport state is
 * not safe to share across instances; reusing a destroyed proxy renders blank.
 */
export function usePdfDocument({
  filePath,
  cachedBytes,
  onPdfLoaded,
}: UsePdfDocumentOptions): UsePdfDocumentResult {
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [outline, setOutline] = useState<OutlineItem[]>([]);

  // Keep the latest onPdfLoaded in a ref so the load effect (bound on
  // filePath) always calls the freshest callback without re-binding. Synced
  // in an effect (not during render) per the React concurrent-mode rule
  // against render-phase ref writes.
  const onPdfLoadedRef = useRef(onPdfLoaded);
  useEffect(() => {
    onPdfLoadedRef.current = onPdfLoaded;
  }, [onPdfLoaded]);

  useEffect(() => {
    if (!filePath) {
      setPdf(null);
      setNumPages(0);
      setError("");
      setIsLoading(false);
      return;
    }

    // Clear the previous document immediately so we never render with a
    // destroyed PDFDocumentProxy while the new file is loading.
    setPdf(null);
    setNumPages(0);
    setError("");
    setIsLoading(true);

    let isCancelled = false;
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
    let loadedPdf: pdfjsLib.PDFDocumentProxy | null = null;

    const loadPdf = async () => {
      try {
        let data: Uint8Array;
        if (cachedBytes) {
          // Copy before handing to PDF.js so its worker cannot detach the
          // shared cached buffer.
          data = cachedBytes.slice();
        } else {
          const bytes = await invoke<ArrayBuffer>("read_pdf_bytes", {
            filePath,
          });
          if (isCancelled) return;
          const view = new Uint8Array(bytes);
          // PDF.js may transfer/detach the underlying ArrayBuffer while
          // loading. Cache a detached-buffer-safe copy and pass a separate
          // view to PDF.js so reopening never reuses a detached buffer.
          onPdfLoadedRef.current?.(filePath, view.slice());
          data = view;
        }

        loadingTask = pdfjsLib.getDocument({ data });
        loadedPdf = await loadingTask.promise;
        if (isCancelled) {
          loadedPdf.destroy();
          loadedPdf = null;
          return;
        }

        setPdf(loadedPdf);
        setNumPages(loadedPdf.numPages);
      } catch (err) {
        if (!isCancelled) {
          logError(`Error loading PDF: ${err}`);
          setError(`Failed to load PDF: ${err}`);
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    };

    loadPdf();

    return () => {
      isCancelled = true;
      if (loadedPdf) {
        loadedPdf.destroy();
        loadedPdf = null;
      } else if (loadingTask) {
        loadingTask.destroy();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  // Load outline (bookmarks) when the PDF changes.
  useEffect(() => {
    if (!pdf) {
      setOutline([]);
      return;
    }
    let cancelled = false;
    const loadOutline = async () => {
      try {
        const outlineData = (await pdf.getOutline()) || [];
        if (!cancelled) setOutline(outlineData as OutlineItem[]);
      } catch (err) {
        logError(`Failed to load PDF outline: ${err}`);
      }
    };
    loadOutline();
    return () => {
      cancelled = true;
    };
  }, [pdf]);

  return { pdf, numPages, isLoading, error, outline };
}
