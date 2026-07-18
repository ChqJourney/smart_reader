import i18n from "i18next";
import { useCallback, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { error as logError, info } from "../services/logs";
import { PdfViewerState } from "../components/PdfViewer";
import { SelectionState } from "../services/selection";
import { authorizePdfPath, getPdfHash } from "../services/annotations";
import { showMessage } from "../services/dialog";
import { getBasename } from "../utils/path";

const MAX_TABS = 10;

export interface PdfTab {
  id: string;
  filePath: string;
  fileName: string;
  fileHash: string;
  pageNum?: number;
  scale?: number;
  viewMode?: "single" | "continuous";
  scrollTop?: number;
  selection?: SelectionState | null;
  highlightedAnnotationId?: string | null;
  pendingGotoPage?: number;
}

export interface UseTabsReturn {
  tabs: PdfTab[];
  activeTabId: string | null;
  activeTab: PdfTab | null;
  handleOpenPdf: () => Promise<PdfTab | null>;
  openPdfByPath: (path: string, initialPage?: number) => Promise<PdfTab | null>;
  handleCloseTab: (
    e: React.MouseEvent,
    tabId: string,
    onClose?: () => void
  ) => void;
  handleTabClick: (tabId: string, onSwitch?: () => void) => void;
  handleViewerStateChange: (state: PdfViewerState, tabId?: string) => void;
  gotoTabPage: (tabId: string, page: number) => void;
  setTabSelection: (tabId: string, selection: SelectionState | null) => void;
  clearTabSelection: (tabId: string) => void;
  setTabHighlightedAnnotationId: (
    tabId: string,
    annotationId: string | null
  ) => void;
  clearTabPendingGotoPage: (tabId: string) => void;
}

export function useTabs(): UseTabsReturn {
  const [tabs, setTabs] = useState<PdfTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // In-flight open requests by path. Prevents duplicate tabs when the same PDF
  // is opened concurrently (e.g. rapid double-clicks or multiple listeners).
  const pendingOpens = useRef<Map<string, Promise<PdfTab | null>>>(new Map());

  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null;

  const activateTab = useCallback((tabId: string | null) => {
    setActiveTabId(tabId);
    if (tabId) {
      // Always set pendingGotoPage when activating a tab so the viewer knows it
      // should restore position. If no page has been saved yet, default to 1.
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId ? { ...tab, pendingGotoPage: tab.pageNum ?? 1 } : tab
        )
      );
    }
  }, []);

  const addTab = useCallback(
    async (path: string, initialPage?: number): Promise<PdfTab | null> => {
      const inFlight = pendingOpens.current.get(path);
      if (inFlight) {
        return inFlight;
      }

      const promise = (async (): Promise<PdfTab | null> => {
        try {
          if (tabs.length >= MAX_TABS) {
            await showMessage(
              i18n.t("common.notice"),
              i18n.t("tabs.maxTabsHint", { maxTabs: MAX_TABS })
            );
            return null;
          }

          // Authorize the path before reading it. The backend maintains a whitelist
          // of paths selected by the user to prevent arbitrary file access.
          await authorizePdfPath(path);

          const fileHash = await getPdfHash(path);
          const existing = tabs.find(
            (tab) => tab.fileHash === fileHash || tab.filePath === path
          );
          if (existing) {
            activateTab(existing.id);
            return existing;
          }

          const newTab: PdfTab = {
            id: crypto.randomUUID(),
            filePath: path,
            fileName: getBasename(path),
            fileHash,
            // 从最近文件入口打开时带上上次读到的页码，activateTab 会把它
            // 转成 pendingGotoPage，viewer 挂载后自动恢复到该页。
            ...(initialPage && initialPage > 0
              ? { pageNum: Math.floor(initialPage) }
              : {}),
          };

          setTabs((prev) => [...prev, newTab]);
          activateTab(newTab.id);
          info(`pdfOpened: tabId=${newTab.id} fileHash=${newTab.fileHash}`);
          return newTab;
        } catch (error) {
          logError(`Failed to open PDF: ${error}`);
          return null;
        }
      })();

      pendingOpens.current.set(path, promise);
      try {
        return await promise;
      } finally {
        pendingOpens.current.delete(path);
      }
    },
    [tabs, activateTab]
  );

  const handleOpenPdf = useCallback(async (): Promise<PdfTab | null> => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [
          {
            name: "PDF Files",
            extensions: ["pdf"],
          },
        ],
      });

      if (!selected) return null;

      const path = Array.isArray(selected) ? selected[0] : selected;
      return await addTab(path);
    } catch (error) {
      logError(`Failed to open PDF: ${error}`);
      return null;
    }
  }, [addTab]);

  const openPdfByPath = useCallback(
    async (path: string, initialPage?: number): Promise<PdfTab | null> => {
      return addTab(path, initialPage);
    },
    [addTab]
  );

  const handleCloseTab = useCallback(
    (e: React.MouseEvent, tabId: string, onClose?: () => void) => {
      e.stopPropagation();

      const index = tabs.findIndex((tab) => tab.id === tabId);
      if (index === -1) return;

      const nextTabs = tabs.filter((tab) => tab.id !== tabId);

      if (activeTabId === tabId) {
        const nextActive =
          nextTabs[Math.min(index, nextTabs.length - 1)] || null;
        // Set pendingGotoPage atomically with the tab removal so the next
        // active tab restores its previous page when its viewer mounts.
        setTabs(
          nextTabs.map((tab) =>
            tab.id === nextActive?.id
              ? { ...tab, pendingGotoPage: tab.pageNum }
              : tab
          )
        );
        setActiveTabId(nextActive?.id ?? null);
      } else {
        setTabs(nextTabs);
      }

      info(`pdfClosed: tabId=${tabId} remainingTabs=${nextTabs.length}`);
      onClose?.();
    },
    [tabs, activeTabId]
  );

  const handleTabClick = useCallback(
    (tabId: string, onSwitch?: () => void) => {
      activateTab(tabId);
      onSwitch?.();
    },
    [activateTab]
  );

  const handleViewerStateChange = useCallback(
    (state: PdfViewerState, tabId?: string) => {
      const targetId = tabId ?? activeTabId;
      if (!targetId) return;
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === targetId
            ? {
                ...tab,
                ...(state.pageNum !== undefined && { pageNum: state.pageNum }),
                ...(state.scale !== undefined && { scale: state.scale }),
                ...(state.viewMode !== undefined && {
                  viewMode: state.viewMode,
                }),
                ...(state.scrollTop !== undefined && {
                  scrollTop: state.scrollTop,
                }),
              }
            : tab
        )
      );
    },
    [activeTabId]
  );

  const gotoTabPage = useCallback((tabId: string, page: number) => {
    setActiveTabId(tabId);
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId
          ? // Clear scrollTop: this is intentional navigation to a page, and a
            // stale saved offset would otherwise be re-applied after the jump
            // by the mount-restore path, snapping the viewer back to the tab's
            // previous reading spot (docs/REFACTOR_REVIEW_2026-07-17.md #4b).
            {
              ...tab,
              pageNum: page,
              pendingGotoPage: page,
              scrollTop: undefined,
            }
          : tab
      )
    );
  }, []);

  const setTabSelection = useCallback(
    (tabId: string, selection: SelectionState | null) => {
      setTabs((prev) =>
        prev.map((tab) => (tab.id === tabId ? { ...tab, selection } : tab))
      );
    },
    []
  );

  const clearTabSelection = useCallback((tabId: string) => {
    setTabs((prev) =>
      prev.map((tab) => (tab.id === tabId ? { ...tab, selection: null } : tab))
    );
  }, []);

  const setTabHighlightedAnnotationId = useCallback(
    (tabId: string, annotationId: string | null) => {
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? { ...tab, highlightedAnnotationId: annotationId }
            : tab
        )
      );
    },
    []
  );

  const clearTabPendingGotoPage = useCallback((tabId: string) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, pendingGotoPage: undefined } : tab
      )
    );
  }, []);

  return {
    tabs,
    activeTabId,
    activeTab,
    handleOpenPdf,
    openPdfByPath,
    handleCloseTab,
    handleTabClick,
    handleViewerStateChange,
    gotoTabPage,
    setTabSelection,
    clearTabSelection,
    setTabHighlightedAnnotationId,
    clearTabPendingGotoPage,
  };
}
