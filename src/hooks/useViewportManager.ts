import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { error as logError } from "../services/logs";

/**
 * Pre-computed viewport size for a single page. Lives here (not in PdfViewer)
 * because the viewport manager is the single source of truth for these
 * entries — PdfViewer now re-exports the type for backward compatibility with
 * PdfPage and the existing tests.
 */
export interface PageViewportInfo {
  width: number;
  height: number;
  /**
   * Scale this entry was computed for. Viewport sizes are exactly linear in
   * scale, so consumers may rescale a stale-scale entry to the live scale at
   * render time instead of awaiting a reload (see PdfPage's sizing logic).
   */
  scale: number;
}

/**
 * For small documents we can afford to preload every viewport and get exact
 * continuous-mode jumps. For large documents we lazily compute only the visible
 * pages plus a small window to avoid blocking the main thread.
 */
const VIEWPORT_PRELOAD_THRESHOLD = 50;

/**
 * Coalescing window for self-loaded viewport write-backs. Long enough to merge
 * a mount-time self-load storm into a few commits, short enough that a
 * mount-time tab restore (which waits for the entries) is not delayed
 * perceptibly.
 */
const SELF_LOAD_FLUSH_MS = 100;

export interface UseViewportManagerOptions {
  pdf: PDFDocumentProxy | null;
  numPages: number;
  /** Current (live) scale. Viewports are (re)computed for this scale. */
  scale: number;
  /** Current page; included in the large-doc preload window. */
  pageNum: number;
}

export interface UseViewportManagerResult {
  pageViewports: Map<number, PageViewportInfo>;
  visiblePages: Set<number>;
  /** Scale for which `pageViewports` currently holds entries. */
  viewportsForScale: number;
  /** True once viewports have been committed for the current scale. */
  isReady: boolean;
  /** IntersectionObserver callback (wired to PdfPage's onVisibilityChange). */
  setPageVisible: (page: number, ratio: number) => void;
  /** Refs to each page wrapper div, indexed by page-1. */
  pageWrapperRefs: React.MutableRefObject<(HTMLDivElement | null)[]>;
  /** Stable per-page ref-callback factory for continuous-mode wrappers. */
  setPageWrapperRef: (page: number) => (el: HTMLDivElement | null) => void;
  /**
   * Ensure the viewport entry for a single page is loaded for the current
   * scale. Returns the loaded entry (or null on failure / no pdf). Used by
   * fitToWidth to fix 9.4: instead of silently bailing when a page's viewport
   * is missing (e.g. a large document where the target page was never
   * preloaded), the caller can now trigger an on-demand load and then proceed.
   *
   * De-duplicates concurrent loads for the same page via an in-flight map so
   * the preload effect and an explicit fitToWidth call racing for the same
   * page do not double-fetch.
   *
   * NOTE: intentionally does NOT touch `viewportsForScale`. A single-page
   * load must not flip the global readiness flag — the rest of the map may
   * still hold old-scale entries, and the zoom-restore / fit-center effects
   * gate on that flag (see docs/REFACTOR_REVIEW_2026-07-17.md #1).
   */
  ensureViewport: (page: number) => Promise<PageViewportInfo | null>;
  /**
   * Latest IntersectionObserver ratios per page (write-only elsewhere).
   * Exposed so scroll page-sync can skip off-screen pages without a DOM read.
   */
  pageVisibilityRatios: React.MutableRefObject<Map<number, number>>;
  /**
   * Merge a viewport that a PdfPage computed itself (self-load, used when the
   * manager's map has no entry for that page yet — e.g. off-window pages of a
   * large document). Batched (100ms) so a 200-page mount-time self-load storm
   * produces a handful of commits instead of one re-render per page. Results
   * computed for a stale scale (a zoom happened mid-load) are dropped.
   * Never touches `viewportsForScale` (same rule as ensureViewport).
   */
  reportViewportLoaded: (
    page: number,
    info: PageViewportInfo,
    forScale: number
  ) => void;
}

/**
 * Owns page-viewport preloading, visible-page tracking, and the page-wrapper
 * ref machinery.
 *
 * Extraction rationale (see docs/REFACTOR_PLAN.md #13): `pageViewports` /
 * `visiblePages` / `viewportsForScale` form one cohesive concern (knowing the
 * size and visibility of every page so the viewer can scroll, jump, and render
 * accurately) and were spread across multiple states, an effect, and three
 * refs inside PdfViewer. Centralizing them removes a large class of "which
 * scale is this viewport entry for?" / "is the page actually visible yet?"
 * bugs and lets fitToWidth trigger on-demand loads (9.4).
 *
 * Design notes:
 * - `pageViewports` is NEVER cleared on a scale change. Clearing collapsed
 *   every page wrapper to a 400px placeholder during the async recompute,
 *   making scroll position meaningless and causing jumps. New entries
 *   overwrite stale ones; consumers that need fresh sizes gate on
 *   `isReady` (=== `viewportsForScale === scale`).
 * - The preload effect loads via `loadPages`; `ensureViewport` loads single
 *   pages on demand and de-duplicates concurrent calls via `inFlightRef`.
 * - `viewportsForScale` is updated to the current `scale` only when a preload
 *   batch commits — never by single-page `ensureViewport` loads — signaling
 *   readiness to the zoom restore effect in useZoomAnchor and the fit-center
 *   effect in PdfViewer. Entries whose size is unchanged keep their object
 *   identity (and a fully unchanged batch keeps the Map identity) so
 *   memoized consumers can skip re-rendering.
 */
export function useViewportManager(
  options: UseViewportManagerOptions
): UseViewportManagerResult {
  const { pdf, numPages, scale, pageNum } = options;

  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set());
  const [pageViewports, setPageViewports] = useState<
    Map<number, PageViewportInfo>
  >(new Map());
  // Scale for which `pageViewports` currently holds entries. The zoom restore
  // effect (useZoomAnchor) and the fit-center effect wait until this matches
  // the current `scale` before reading the newly-laid-out DOM, so they never
  // restore/center against stale (old-scale) sizes.
  const [viewportsForScale, setViewportsForScale] = useState(scale);

  const pageWrapperRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pageVisibilityRatios = useRef<Map<number, number>>(new Map());

  // De-duplicate concurrent ensureViewport calls for the SAME page + scale.
  // Keyed by `${page}:${scale}` so a scale change does NOT reuse an in-flight
  // promise from the previous scale. Used ONLY by ensureViewport; the preload
  // effect does its own loading with a cancelled guard and does not consult
  // this map (sharing it caused a regression where a page skipped by the new
  // batch because its old-batch load was "in flight" never got written, since
  // the old batch was cancelled and bailed out before setPageViewports).
  const inFlightRef = useRef<Map<string, Promise<PageViewportInfo | null>>>(
    new Map()
  );

  // Load viewports for the given pages at the given scale, updating state once
  // the batch settles. `cancelledRef` is checked after every await so a stale
  // batch (triggered by an older scale) never writes its old-scale sizes into
  // pageViewports or flips viewportsForScale back — both caused the rapid-zoom
  // "pages jump around + mixed widths" regression. Does NOT consult inFlightRef
  // (see comment above); pdfjs caches getPage results so redundant fetches are
  // cheap, and the cancelled guard prevents stale writes.
  const loadPages = useCallback(
    async (
      pages: Iterable<number>,
      batchScale: number,
      cancelledRef: React.MutableRefObject<boolean>
    ) => {
      if (!pdf) return;
      // Load in parallel: the sequential per-page await made small-document
      // preloads needlessly slow and, worse, stretched the window in which a
      // scroll-driven re-trigger would cancel the batch and discard every
      // already-fetched entry (docs/REFACTOR_REVIEW_2026-07-17.md P3).
      const settled = await Promise.all(
        Array.from(pages, async (i): Promise<[number, PageViewportInfo] | null> => {
          try {
            const page = await pdf.getPage(i);
            const vp = page.getViewport({ scale: batchScale });
            return [i, { width: vp.width, height: vp.height, scale: batchScale }];
          } catch (err) {
            logError(`Failed to get viewport for page ${i}: ${err}`);
            return null;
          }
        })
      );
      // CRITICAL: bail out if a newer scale change cancelled this batch.
      // Without this, a slow load for an old scale would still write stale
      // sizes into pageViewports and flip viewportsForScale back, causing
      // mixed-scale entries and restore thrash on rapid zoom.
      if (cancelledRef.current) return;
      const newEntries = settled.filter(
        (e): e is [number, PageViewportInfo] => e !== null
      );

      if (newEntries.length > 0) {
        setPageViewports((prev) => {
          const map = new Map(prev);
          let changed = false;
          newEntries.forEach(([i, info]) => {
            const old = map.get(i);
            // Keep the old entry object when the size is unchanged: reference
            // stability lets memoized PdfPage children skip re-renders, and
            // returning `prev` for a fully unchanged batch avoids a viewer-wide
            // render per IO-driven preload (docs/REFACTOR_REVIEW_2026-07-17.md P2).
            if (!old || old.width !== info.width || old.height !== info.height) {
              map.set(i, info);
              changed = true;
            }
          });
          return changed ? map : prev;
        });
      }
      // Signal readiness for the scale we just loaded at. Even if this batch
      // only covered a subset of pages, the entries it produced are valid for
      // `batchScale`, and consumers gate per-page on `pageViewports.get()`.
      setViewportsForScale(batchScale);
    },
    [pdf]
  );

  // Pre-compute viewport sizes so we can scroll to an exact page in continuous
  // mode. For small documents we preload every page; for large documents we
  // only compute the visible pages plus a small window, falling back to live
  // DOM geometry for the rest. This keeps opening and jumping responsive on
  // 100MB/200-page documents.
  useEffect(() => {
    if (!pdf || numPages === 0) return;
    const cancelledRef = { current: false };
    const target = new Set<number>();
    if (numPages <= VIEWPORT_PRELOAD_THRESHOLD) {
      for (let i = 1; i <= numPages; i++) target.add(i);
    } else {
      visiblePages.forEach((p) => {
        target.add(p);
        if (p > 1) target.add(p - 1);
        if (p < numPages) target.add(p + 1);
      });
      target.add(1);
      target.add(pageNum);
    }
    const batchScale = scale;
    loadPages(target, batchScale, cancelledRef);
    return () => {
      // A new scale/visibility change supersedes this batch: any in-flight
      // loads for this batch's scale must not commit their (now stale) sizes.
      cancelledRef.current = true;
    };
  }, [pdf, numPages, scale, visiblePages, pageNum, loadPages]);

  const ensureViewport = useCallback(
    async (page: number): Promise<PageViewportInfo | null> => {
      if (!pdf) return null;
      const key = `${page}:${scale}`;
      // Already loaded for the current scale? Return synchronously.
      const existing = pageViewports.get(page);
      if (existing && viewportsForScale === scale) return existing;
      // Already loading for this exact scale? Await the shared promise.
      const inFlight = inFlightRef.current.get(key);
      if (inFlight) return inFlight;
      const promise = (async () => {
        try {
          const p = await pdf.getPage(page);
          const vp = p.getViewport({ scale });
          const info: PageViewportInfo = {
            width: vp.width,
            height: vp.height,
            scale,
          };
          setPageViewports((prev) => {
            const old = prev.get(page);
            if (old && old.width === info.width && old.height === info.height) {
              return prev;
            }
            const map = new Map(prev);
            map.set(page, info);
            return map;
          });
          // Do NOT setViewportsForScale here: a single-page load must not flip
          // the global readiness flag while the rest of the map may still hold
          // old-scale entries (zoom-restore / fit-center gate on it).
          return info;
        } catch (err) {
          logError(`Failed to get viewport for page ${page}: ${err}`);
          return null;
        } finally {
          inFlightRef.current.delete(key);
        }
      })();
      inFlightRef.current.set(key, promise);
      return promise;
    },
    [pdf, scale, pageViewports, viewportsForScale]
  );

  // Batched write-back for per-page self-loaded viewports (PdfPage loads its
  // own viewport when the manager has no entry for it, which is the norm for
  // off-window pages of large documents). Merging them here lets consumers
  // (continuous jump math, tab restore) use exact sizes for every page once
  // the mount-time self-load storm settles.
  const selfLoadBufferRef = useRef<Map<number, PageViewportInfo>>(new Map());
  const selfLoadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live scale for the stale-report guard, read through a ref so the callback
  // identity stays stable (memoized PdfPage children receive it as a prop).
  const liveScaleRef = useRef(scale);
  useEffect(() => {
    liveScaleRef.current = scale;
  }, [scale]);

  const flushSelfLoadedViewports = useCallback(() => {
    const buffer = selfLoadBufferRef.current;
    if (buffer.size === 0) return;
    selfLoadBufferRef.current = new Map();
    setPageViewports((prev) => {
      const map = new Map(prev);
      let changed = false;
      buffer.forEach((info, page) => {
        const old = map.get(page);
        if (
          !old ||
          old.width !== info.width ||
          old.height !== info.height ||
          old.scale !== info.scale
        ) {
          map.set(page, info);
          changed = true;
        }
      });
      return changed ? map : prev;
    });
  }, []);

  const reportViewportLoaded = useCallback(
    (page: number, info: PageViewportInfo, forScale: number) => {
      // Drop results computed for a scale that is no longer live (a zoom
      // happened while the self-load was in flight): PdfPage re-loads at the
      // new scale and reports again.
      if (forScale !== liveScaleRef.current) return;
      selfLoadBufferRef.current.set(page, info);
      if (selfLoadTimerRef.current === null) {
        selfLoadTimerRef.current = setTimeout(() => {
          selfLoadTimerRef.current = null;
          flushSelfLoadedViewports();
        }, SELF_LOAD_FLUSH_MS);
      }
    },
    [flushSelfLoadedViewports]
  );

  useEffect(() => {
    return () => {
      if (selfLoadTimerRef.current !== null) {
        clearTimeout(selfLoadTimerRef.current);
      }
    };
  }, []);

  const setPageVisible = useCallback((page: number, ratio: number) => {
    pageVisibilityRatios.current.set(page, ratio);
    setVisiblePages((prev) => {
      const has = prev.has(page);
      // Bail out when membership does not change: IntersectionObserver fires
      // on every threshold crossing (0/0.25/0.5/0.75/1), and allocating a new
      // Set each time re-rendered the whole viewer and re-triggered the
      // preload effect for no semantic change (docs/REFACTOR_REVIEW_2026-07-17.md P1).
      if (ratio > 0 ? has : !has) return prev;
      const next = new Set(prev);
      if (ratio > 0) {
        next.add(page);
      } else {
        next.delete(page);
      }
      return next;
    });
  }, []);

  // Stable ref-callback factory for continuous-mode page wrappers. Each page
  // gets ONE stable callback (cached in pageWrapperRefCallbacks) so React does
  // not re-run the ref on every render, which would detach/reattach the DOM
  // node and break the IntersectionObserver in PdfPage.
  const pageWrapperRefCallbacks = useRef<
    Map<number, (el: HTMLDivElement | null) => void>
  >(new Map());
  const setPageWrapperRef = useCallback((page: number) => {
    if (!pageWrapperRefCallbacks.current.has(page)) {
      pageWrapperRefCallbacks.current.set(
        page,
        (el: HTMLDivElement | null) => {
          pageWrapperRefs.current[page - 1] = el;
        }
      );
    }
    return pageWrapperRefCallbacks.current.get(page)!;
  }, []);

  const isReady = viewportsForScale === scale;

  return useMemo(
    () => ({
      pageViewports,
      visiblePages,
      viewportsForScale,
      isReady,
      setPageVisible,
      pageWrapperRefs,
      setPageWrapperRef,
      ensureViewport,
      pageVisibilityRatios,
      reportViewportLoaded,
    }),
    [
      pageViewports,
      visiblePages,
      viewportsForScale,
      isReady,
      setPageVisible,
      setPageWrapperRef,
      ensureViewport,
      reportViewportLoaded,
    ]
  );
}
