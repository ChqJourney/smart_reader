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
export interface SearchMatchRegion {
  pdfX: number;
  pdfY: number;
  pdfWidth: number;
  pdfHeight: number;
}

export interface SearchMatch {
  id: string;
  page: number;
  /**
   * Bounding box of the first contributing text item. Kept for compatibility
   * with consumers that use a match as a page-navigation target.
   */
  pdfX: number;
  pdfY: number;
  pdfWidth: number;
  pdfHeight: number;
  text: string;
  /** Every text item which contributes characters to this match. */
  regions: SearchMatchRegion[];
}

interface IndexedTextItem extends SearchMatchRegion {
  start: number;
  end: number;
  hasEOL: boolean;
}

interface TextItemPosition {
  x: number;
  y: number;
  width: number;
  height: number;
  charWidth: number;
  hasEOL: boolean;
}

/** Return whether adjacent PDF.js items are separated by a visible word gap. */
function needsSeparator(previous: TextItemPosition, current: TextItemPosition) {
  if (previous.hasEOL) return true;

  const verticalDelta = Math.abs(current.y - previous.y);
  if (verticalDelta > Math.max(previous.height, current.height) / 2) return true;

  const horizontalGap = current.x - (previous.x + previous.width);
  return horizontalGap > Math.max(1, previous.charWidth / 4);
}

/**
 * PDF.js may split visually continuous text into separate TextItems at line
 * breaks, font transitions, or even word boundaries. Build a logical page
 * string with one normalized separator between non-empty items, preserving a
 * character range for each item so a cross-item query can still be highlighted
 * at its original locations.
 */
interface SearchPageViewport {
  convertToViewportPoint(x: number, y: number): number[];
}

function buildPageTextIndex(
  items: readonly unknown[],
  pageViewport: SearchPageViewport
): { text: string; items: IndexedTextItem[] } {
  let text = "";
  const indexedItems: IndexedTextItem[] = [];
  let previousPosition: TextItemPosition | null = null;

  for (const item of items) {
    if (!item || typeof item !== "object" || !("str" in item)) continue;
    const textItem = item as PdfjsTextItem;
    const itemText = textItem.str.replace(/\s+/g, " ").trim();
    if (!itemText) continue;

    const [x, baselineY] = pageViewport.convertToViewportPoint(
      textItem.transform[4],
      textItem.transform[5]
    );
    const height = textItem.height || 10;
    const position: TextItemPosition = {
      x,
      y: baselineY - height,
      width: textItem.width,
      height,
      charWidth: textItem.width / itemText.length,
      hasEOL: textItem.hasEOL,
    };
    if (previousPosition && needsSeparator(previousPosition, position)) text += " ";
    const start = text.length;
    text += itemText;
    indexedItems.push({
      start,
      end: text.length,
      pdfX: position.x,
      pdfY: position.y,
      pdfWidth: position.width,
      pdfHeight: position.height,
      hasEOL: position.hasEOL,
    });
    previousPosition = position;
  }

  return { text, items: indexedItems };
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
          const pageIndex = buildPageTextIndex(textContent.items, pageViewport);
          const searchableText = pageIndex.text.toLowerCase();
          let matchStart = searchableText.indexOf(queryLower);
          while (matchStart !== -1) {
            const matchEnd = matchStart + queryLower.length;
            const regions = pageIndex.items
              .filter((item) => item.start < matchEnd && item.end > matchStart)
              .map(({ start: _start, end: _end, ...region }) => region);

            if (regions.length > 0) {
              const firstRegion = regions[0];
              matches.push({
                id: `match-${p}-${matches.length}`,
                page: p,
                text: pageIndex.text.slice(matchStart, matchEnd),
                ...firstRegion,
                regions,
              });
            }
            matchStart = searchableText.indexOf(queryLower, matchStart + 1);
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
    searchMatches.forEach((match, matchIndex) => {
      const list = map.get(match.page) || [];
      match.regions.forEach((region, regionIndex) => {
        list.push({
          id: `${match.id}-${regionIndex}`,
          page: match.page,
          x: region.pdfX * scale,
          y: region.pdfY * scale,
          width: region.pdfWidth * scale,
          height: region.pdfHeight * scale,
          isActive: matchIndex === searchActiveIndex,
        });
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
