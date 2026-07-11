import i18n from "i18next";
import { useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { PdfViewerState } from "../components/PdfViewer";
import { authorizePdfPath, getPdfHash } from "../services/annotations";
import { showMessage } from "../services/dialog";

const MAX_TABS = 10;

export interface PdfTab {
  id: string;
  filePath: string;
  fileName: string;
  fileHash: string;
  pageNum?: number;
  scale?: number;
  viewMode?: "single" | "continuous";
}

export interface UseTabsReturn {
  tabs: PdfTab[];
  activeTabId: string | null;
  activeTab: PdfTab | null;
  handleOpenPdf: () => Promise<PdfTab | null>;
  openPdfByPath: (path: string, fileName: string) => Promise<PdfTab | null>;
  handleCloseTab: (
    e: React.MouseEvent,
    tabId: string,
    onClose?: () => void
  ) => void;
  handleTabClick: (tabId: string, onSwitch?: () => void) => void;
  handleViewerStateChange: (state: PdfViewerState, tabId?: string) => void;
  gotoTabPage: (tabId: string, page: number) => void;
}

export function useTabs(): UseTabsReturn {
  const [tabs, setTabs] = useState<PdfTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null;

  const addTab = useCallback(
    async (path: string): Promise<PdfTab | null> => {
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
          setActiveTabId(existing.id);
          return existing;
        }

        const newTab: PdfTab = {
          id: crypto.randomUUID(),
          filePath: path,
          fileName: path.split("/").pop() || path,
          fileHash,
        };

        setTabs((prev) => [...prev, newTab]);
        setActiveTabId(newTab.id);
        return newTab;
      } catch (error) {
        console.error("Failed to open PDF:", error);
        return null;
      }
    },
    [tabs]
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
      console.error("Failed to open PDF:", error);
      return null;
    }
  }, [addTab]);

  const openPdfByPath = useCallback(
    async (path: string): Promise<PdfTab | null> => {
      return addTab(path);
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
        setActiveTabId(nextActive?.id ?? null);
      }

      setTabs(nextTabs);
      onClose?.();
    },
    [tabs, activeTabId]
  );

  const handleTabClick = useCallback((tabId: string, onSwitch?: () => void) => {
    setActiveTabId(tabId);
    onSwitch?.();
  }, []);

  const handleViewerStateChange = useCallback(
    (state: PdfViewerState, tabId?: string) => {
      const targetId = tabId ?? activeTabId;
      if (!targetId) return;
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === targetId
            ? {
                ...tab,
                pageNum: state.pageNum,
                scale: state.scale,
                viewMode: state.viewMode,
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
      prev.map((tab) => (tab.id === tabId ? { ...tab, pageNum: page } : tab))
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
  };
}
