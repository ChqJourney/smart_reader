import { useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { PdfViewerState } from "../components/PdfViewer";
import { getPdfHash } from "../services/annotations";

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
  handleOpenPdf: () => Promise<void>;
  handleCloseTab: (e: React.MouseEvent, tabId: string, onClose?: () => void) => void;
  handleTabClick: (tabId: string, onSwitch?: () => void) => void;
  handleViewerStateChange: (state: PdfViewerState) => void;
  gotoTabPage: (tabId: string, page: number) => void;
}

export function useTabs(): UseTabsReturn {
  const [tabs, setTabs] = useState<PdfTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null;

  const handleOpenPdf = useCallback(async () => {
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

      if (!selected) return;

      if (tabs.length >= MAX_TABS) {
        alert(`最多只能同时打开 ${MAX_TABS} 个 PDF 文件。请先关闭部分标签。`);
        return;
      }

      const path = Array.isArray(selected) ? selected[0] : selected;
      const fileHash = await getPdfHash(path);
      const newTab: PdfTab = {
        id: crypto.randomUUID(),
        filePath: path,
        fileName: path.split("/").pop() || path,
        fileHash,
      };

      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
    } catch (error) {
      console.error("Failed to open PDF:", error);
    }
  }, [tabs.length]);

  const handleCloseTab = useCallback((e: React.MouseEvent, tabId: string, onClose?: () => void) => {
    e.stopPropagation();

    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return;

    const nextTabs = tabs.filter((tab) => tab.id !== tabId);

    if (activeTabId === tabId) {
      const nextActive = nextTabs[Math.min(index, nextTabs.length - 1)] || null;
      setActiveTabId(nextActive?.id ?? null);
    }

    setTabs(nextTabs);
    onClose?.();
  }, [tabs, activeTabId]);

  const handleTabClick = useCallback((tabId: string, onSwitch?: () => void) => {
    setActiveTabId(tabId);
    onSwitch?.();
  }, []);

  const handleViewerStateChange = useCallback((state: PdfViewerState) => {
    if (!activeTabId) return;
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === activeTabId
          ? { ...tab, pageNum: state.pageNum, scale: state.scale, viewMode: state.viewMode }
          : tab
      )
    );
  }, [activeTabId]);

  const gotoTabPage = useCallback((tabId: string, page: number) => {
    setActiveTabId(tabId);
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, pageNum: page } : tab
      )
    );
  }, []);

  return {
    tabs,
    activeTabId,
    activeTab,
    handleOpenPdf,
    handleCloseTab,
    handleTabClick,
    handleViewerStateChange,
    gotoTabPage,
  };
}
