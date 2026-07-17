import { useEffect, useMemo, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem as PdfjsTextItem } from "pdfjs-dist/types/src/display/api";
import type { SearchHighlight } from "../components/PdfPage";
import { error as logError } from "../services/logs";

/**
 * A single search hit, stored in PDF-space coordinates (scale-independent).
 *
 * Why PDF space: the previous implementation stored matches in wrapper-space
 * coordinates (× current scale) and listed `scale` as a dependency of the
 * index-build effect. That forced a full re-scan of every page on every zoom,
 * and during the rebuild the old (stale-scale) highlights were still rendered,
 * visibly drifting from the text (issues 9.1 / 9.6).
 *
 * Storing `pdfX/pdfY/pdfWidth/pdfHeight` (= scale=1 viewport coords, which
 * equal wrapper coords / scale, the same space as `annotation.position`)
 * means the index is stable across zooms. Rendering multiplies by the live
 * `scale` in `searchHighlightsByPage`.
 */
export interface SearchMatch {
  id: string;
  page: number;
  pdfX: number;
  pdfY: number;
  pdfWidth: number;
  pdfHeight: number;
  text: string;
}

export interface UseSearchDomainOptions {
  pdf: PDFDocumentProxy | null;
  numPages: number;
  /** Live scale — used ONLY to render highlights, never to build the index. */
  scale: number;
  /** Ref to the current page number, for initial active-match selection. */
  currentPageRef: React.RefObject<number>;
  /**
   * Ref to the page-navigation function. Stored as a ref (not a dependency)
   * so the active-match effect does NOT re-run when the function's identity
   * changes — which happens whenever `pageViewports` updates and is the root
   * cause of the "search pulls the user back to the active match page" loop
   * (issue 10.2).
   */
  goToPageRef: React.RefObject<(page: number) => void>;
}

export interface UseSearchDomainResult {
  searchOpen: boolean;
  setSearchOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  searchMatches: SearchMatch[];
  searchActiveIndex: number;
  setSearchActiveIndex: (v: number | ((prev: number) => number)) => void;
  searchLoading: boolean;
  /** Highlights in wrapper coords (already ×scale), grouped by page. */
  searchHighlightsByPage: Map<number, SearchHighlight[]>;
  goToNextMatch: () => void;
  goToPrevMatch: () => void;
}

/**
 * Self-contained search domain: index build, active-match navigation, and
 * highlight rendering. Extracted from PdfViewer so the search lifecycle no
 * longer couples to the viewer's effect graph.
 */
export function useSearchDomain({
  pdf,
  numPages,
  scale,
  currentPageRef,
  goToPageRef,
}: UseSearchDomainOptions): UseSearchDomainResult {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [searchActiveIndex, setSearchActiveIndex] = useState(-1);
  const [searchLoading, setSearchLoading] = useState(false);

  // Build the index. `scale` is intentionally absent from the dependency
  // array: matches are stored in PDF space (scale=1 viewport coords), so zoom
  // never invalidates the index (fixes 9.1 / 9.6).
  useEffect(() => {
    if (!searchOpen || !pdf || numPages === 0) {
      setSearchMatches([]);
      setSearchActiveIndex(-1);
      // Reset the loading flag on every early-return path: a cancelled build
      // skips its own `setSearchLoading(false)`, so closing search or
      // clearing the query mid-build would otherwise leave the spinner
      // stuck on (docs/REFACTOR_REVIEW_2026-07-17.md #5).
      setSearchLoading(false);
      return;
    }
    const trimmed = searchQuery.trim();
    if (trimmed === "") {
      setSearchMatches([]);
      setSearchActiveIndex(-1);
      setSearchLoading(false);
      return;
    }

    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const build = async () => {
      setSearchLoading(true);
      const queryLower = trimmed.toLowerCase();
      const matches: SearchMatch[] = [];
      for (let p = 1; p <= numPages; p++) {
        try {
          const page = await pdf.getPage(p);
          if (cancelled) return;
          // scale=1 viewport yields scale-independent (PDF-space) coords.
          const pageViewport = page.getViewport({ scale: 1 });
          const textContent = await page.getTextContent();
          if (cancelled) return;
          for (const item of textContent.items) {
            if (!("str" in item)) continue;
            const text = (item as PdfjsTextItem).str;
            if (!text.trim()) continue;
            if (text.toLowerCase().includes(queryLower)) {
              const ti = item as PdfjsTextItem;
              const [x, y] = pageViewport.convertToViewportPoint(
                ti.transform[4],
                ti.transform[5]
              );
              const width = ti.width; // scale=1
              const height = ti.height || 10; // scale=1
              matches.push({
                id: `match-${p}-${matches.length}`,
                page: p,
                text,
                pdfX: x,
                pdfY: y - height,
                pdfWidth: width,
                pdfHeight: height,
              });
            }
          }
        } catch (err) {
          logError(`Failed to build search index for page ${p}: ${err}`);
        }
      }
      if (!cancelled) {
        setSearchMatches(matches);
        const cur = currentPageRef.current ?? 1;
        const startIndex = matches.findIndex((m) => m.page >= cur);
        setSearchActiveIndex(
          startIndex >= 0 ? startIndex : matches.length > 0 ? 0 : -1
        );
      }
      if (!cancelled) setSearchLoading(false);
    };

    timeout = setTimeout(build, 250);

    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen, searchQuery, pdf, numPages]);

  // Scroll to the active match. goToPage is read from a ref so this effect
  // depends only on [searchActiveIndex, searchMatches] — NOT on goToPage's
  // identity. This breaks the "pageViewports update → goToPage changes →
  // effect re-runs → pulls user back" loop (issue 10.2).
  useEffect(() => {
    if (searchActiveIndex < 0 || searchActiveIndex >= searchMatches.length)
      return;
    const match = searchMatches[searchActiveIndex];
    goToPageRef.current?.(match.page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchActiveIndex, searchMatches]);

  const goToNextMatch = () => {
    if (searchMatches.length === 0) return;
    setSearchActiveIndex((i) => (i + 1) % searchMatches.length);
  };

  const goToPrevMatch = () => {
    if (searchMatches.length === 0) return;
    setSearchActiveIndex(
      (i) => (i - 1 + searchMatches.length) % searchMatches.length
    );
  };

  // Render highlights: convert PDF-space matches to wrapper coords (×scale).
  // Recomputes on scale change, but does NOT rebuild the index.
  const searchHighlightsByPage = useMemo(() => {
    const map = new Map<number, SearchHighlight[]>();
    searchMatches.forEach((match, index) => {
      const list = map.get(match.page) || [];
      list.push({
        id: match.id,
        page: match.page,
        x: match.pdfX * scale,
        y: match.pdfY * scale,
        width: match.pdfWidth * scale,
        height: match.pdfHeight * scale,
        isActive: index === searchActiveIndex,
      });
      map.set(match.page, list);
    });
    return map;
  }, [searchMatches, searchActiveIndex, scale]);

  return {
    searchOpen,
    setSearchOpen,
    searchQuery,
    setSearchQuery,
    searchMatches,
    searchActiveIndex,
    setSearchActiveIndex,
    searchLoading,
    searchHighlightsByPage,
    goToNextMatch,
    goToPrevMatch,
  };
}
