import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import PdfViewer, {
  PdfViewerHandle,
  PdfViewerState,
} from "./components/PdfViewer";
import SelectionToolbar from "./components/SelectionToolbar";
import AiChatPanel from "./components/AiChatPanel";
import SettingsModal from "./components/SettingsModal";
import Icon from "./components/Icon";
import { StashItem } from "./services/stash";
import { SelectionAction } from "./services/llm";
import { useTabs } from "./hooks/useTabs";
import { usePersistence } from "./hooks/usePersistence";
import {
  useRightPanelLayout,
  DIVIDER_WIDTH,
} from "./hooks/useRightPanelLayout";
import { useRecentFiles } from "./hooks/useRecentFiles";
import { useSplitView } from "./hooks/useSplitView";
import RecentFilesBar from "./components/RecentFilesBar";
import {
  AppSettings,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
} from "./services/settings";
import { getContextWindow } from "./data/platformPresets";
import { useDictionaryStatus } from "./hooks/useDictionaryStatus";
import { checkForUpdate } from "./services/updater";
import { error } from "./services/logs";
import { getBasename } from "./utils/path";
import "./App.css";

const RIGHT_PANEL_SPLIT_FRACTION = 0.2;
const RIGHT_PANEL_SPLIT_MIN_WIDTH = 200;

function App() {
  const { t } = useTranslation();
  const tabs = useTabs();
  const layout = useRightPanelLayout();
  const recentFiles = useRecentFiles();
  const splitView = useSplitView();
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const dictionaryStatus = useDictionaryStatus();

  // PDF bytes cache keyed by filePath. Reused across tab switches so large
  // files do not have to be read from disk every time the user changes tabs.
  // Each PdfViewer keeps its own PDFDocumentProxy instance to avoid sharing
  // internal PDF.js transport state between component lifecycles.
  const pdfCacheRef = useRef<Map<string, Uint8Array>>(new Map());

  useEffect(() => {
    let cancelled = false;
    loadSettings().then((s) => {
      if (cancelled) return;
      setSettings(s);
      setSettingsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Check for application updates shortly after startup. Errors are ignored
  // so that a missing network or non-Tauri test environment does not break
  // the app launch flow.
  useEffect(() => {
    const timer = setTimeout(() => {
      checkForUpdate().catch((err) => {
        // 更新检查失败不应打断启动流程，但保留日志便于排查。
        error(`[App] 启动时更新检查失败: ${err}`);
      });
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  const secondaryTab = useMemo(
    () => tabs.tabs.find((t) => t.id === splitView.secondaryTabId) || null,
    [tabs.tabs, splitView.secondaryTabId]
  );

  const hoverTranslateActive =
    settings.hoverTranslate && dictionaryStatus.status?.exists === true;

  const [focusedViewer, setFocusedViewer] = useState<"primary" | "secondary">(
    "primary"
  );

  const focusedTabId = useMemo(() => {
    if (!splitView.isSplitView) return tabs.activeTabId;
    return focusedViewer === "primary"
      ? tabs.activeTabId
      : splitView.secondaryTabId;
  }, [
    splitView.isSplitView,
    focusedViewer,
    tabs.activeTabId,
    splitView.secondaryTabId,
  ]);

  const focusedTab = useMemo(
    () => tabs.tabs.find((t) => t.id === focusedTabId) || null,
    [tabs.tabs, focusedTabId]
  );

  const persistence = usePersistence({
    activeTab: tabs.activeTab,
    activeTabId: tabs.activeTabId,
    secondaryTab,
    isSplitView: splitView.isSplitView,
    focusedTab,
    openRightPanel: layout.openRightPanel,
    settings,
  });

  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const pdfViewerRef = useRef<PdfViewerHandle>(null);
  const secondaryPdfViewerRef = useRef<PdfViewerHandle>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);

  const [splitPct, setSplitPct] = useState(50);
  const primaryPanelRef = useRef<HTMLDivElement>(null);
  const secondaryPanelRef = useRef<HTMLDivElement>(null);
  const middleDividerRef = useRef<HTMLDivElement>(null);
  const isResizingSplitRef = useRef(false);
  const currentSplitPctRef = useRef(50);
  const prevRightWidthRef = useRef<number | null>(null);

  // Auto-shrink right panel when entering split view
  useEffect(() => {
    if (!layout.mainRef.current) return;
    if (splitView.isSplitView) {
      if (prevRightWidthRef.current === null) {
        prevRightWidthRef.current = layout.rightPanelWidth;
        const mainWidth = layout.mainRef.current.getBoundingClientRect().width;
        const availableWidth = Math.max(0, mainWidth - DIVIDER_WIDTH);
        const targetWidth = Math.max(
          availableWidth * RIGHT_PANEL_SPLIT_FRACTION,
          RIGHT_PANEL_SPLIT_MIN_WIDTH
        );
        layout.setRightPanelWidth(targetWidth);
      }
      if (!layout.rightVisible) {
        layout.openRightPanel();
      }
    } else {
      if (prevRightWidthRef.current !== null) {
        layout.setRightPanelWidth(prevRightWidthRef.current);
        prevRightWidthRef.current = null;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    splitView.isSplitView,
    layout.rightPanelWidth,
    layout.rightVisible,
    layout.setRightPanelWidth,
    layout.openRightPanel,
    layout.mainRef,
  ]);

  // Cleanup highlight timeout on unmount
  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current)
        clearTimeout(highlightTimeoutRef.current);
    };
  }, []);

  // Global mouse events for split-view middle divider resizing
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingSplitRef.current) return;
      const primary = primaryPanelRef.current;
      const secondary = secondaryPanelRef.current;
      if (!primary || !secondary) return;

      const primaryRect = primary.getBoundingClientRect();
      const secondaryRect = secondary.getBoundingClientRect();
      const totalWidth = primaryRect.width + secondaryRect.width;
      if (totalWidth <= 0) return;

      const newPrimaryWidth = Math.max(
        0,
        Math.min(totalWidth, e.clientX - primaryRect.left)
      );
      const pct = (newPrimaryWidth / totalWidth) * 100;
      const clampedPct = Math.max(10, Math.min(90, pct));
      currentSplitPctRef.current = clampedPct;

      primary.style.flex = `${clampedPct}`;
      secondary.style.flex = `${100 - clampedPct}`;
    };

    const handleMouseUp = () => {
      if (!isResizingSplitRef.current) return;
      isResizingSplitRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setSplitPct(currentSplitPctRef.current);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const startSplitResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizingSplitRef.current = true;
      currentSplitPctRef.current = splitPct;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [splitPct]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const draggedTabId = e.dataTransfer.getData("text/plain");
      if (!draggedTabId || draggedTabId === tabs.activeTabId) return;
      if (!tabs.tabs.some((t) => t.id === draggedTabId)) return;
      splitView.enterSplitView(draggedTabId);
    },
    [tabs, splitView]
  );

  // 把 tab 栏上的纵向滚轮转换为横向滚动，方便用鼠标滚轮浏览溢出的 tab。
  const handleTabBarWheel = useCallback((e: React.WheelEvent) => {
    const el = tabBarRef.current;
    if (!el) return;
    if (e.deltaY !== 0) {
      el.scrollLeft += e.deltaY;
    }
  }, []);

  // Keep stable refs to the dynamically changing tab/recent-file callbacks so
  // the system "open-pdf" listener is registered only once. This prevents
  // duplicate listeners (and duplicate tabs) when App re-renders.
  const openPdfByPathRef = useRef(tabs.openPdfByPath);
  openPdfByPathRef.current = tabs.openPdfByPath;
  const addRecentFileRef = useRef(recentFiles.addRecentFile);
  addRecentFileRef.current = recentFiles.addRecentFile;

  // Listen for system-driven PDF open requests (single-instance file association).
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    listen<string>("open-pdf", (event) => {
      const path = event.payload;
      const fileName = getBasename(path);
      openPdfByPathRef.current(path, fileName).then((tab) => {
        if (tab) addRecentFileRef.current(tab.filePath, tab.fileName);
      });
    })
      .then((unsub) => {
        unsubscribe = unsub;
      })
      .catch(() => {
        // ignore: in non-Tauri test environments the event bridge is not available
      });
    return () => unsubscribe?.();
  }, []);

  const handleSecondaryViewerStateChange = useCallback(
    (state: PdfViewerState) => {
      tabs.handleViewerStateChange(
        state,
        splitView.secondaryTabId ?? undefined
      );
    },
    [tabs.handleViewerStateChange, splitView.secondaryTabId]
  );

  const handleSaveSettings = useCallback(async (newSettings: AppSettings) => {
    await saveSettings(newSettings);
    setSettings(newSettings);
    setSettingsOpen(false);
  }, []);

  const handleOpenPdf = useCallback(async () => {
    const newTab = await tabs.handleOpenPdf();
    if (newTab) {
      recentFiles.addRecentFile(newTab.filePath, newTab.fileName);
    }
  }, [tabs, recentFiles]);

  const handleRecentFileClick = useCallback(
    async (file: import("./hooks/useRecentFiles").RecentFile) => {
      const tab = await tabs.openPdfByPath(file.path, file.fileName);
      if (tab) {
        recentFiles.addRecentFile(tab.filePath, tab.fileName);
      }
    },
    [tabs, recentFiles]
  );

  const handleTabClick = useCallback(
    (tabId: string) => {
      if (splitView.isSplitView) {
        if (tabId === tabs.activeTabId) return;
        if (tabId === splitView.secondaryTabId) {
          // Swap primary and secondary tabs
          splitView.setSecondaryTabId(tabs.activeTabId);
          tabs.handleTabClick(tabId);
          return;
        }
        // Clicked a third tab: exit split view and activate it
        splitView.exitSplitView();
      }
      tabs.handleTabClick(tabId);
    },
    [tabs, splitView]
  );

  const handleCloseTab = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      const isActive = tabs.activeTabId === tabId;
      const isSecondary = splitView.secondaryTabId === tabId;
      const closingTab = tabs.tabs.find((t) => t.id === tabId);
      const remainingTabIds = tabs.tabs
        .filter((t) => t.id !== tabId)
        .map((t) => t.id);

      tabs.handleCloseTab(e, tabId, () => {
        if (closingTab) {
          persistence.abortSessionsForTab(
            tabId,
            closingTab.fileHash,
            remainingTabIds
          );
        }
        // Remove the cached bytes when no other tab uses the same file path.
        const pathStillOpen = tabs.tabs.some(
          (t) => t.id !== tabId && t.filePath === closingTab?.filePath
        );
        if (!pathStillOpen && closingTab) {
          pdfCacheRef.current.delete(closingTab.filePath);
        }
        persistence.setStashes((prev) =>
          prev.filter((s) => s.source.tabId !== tabId)
        );
        if (isSecondary || (isActive && splitView.isSplitView)) {
          splitView.exitSplitView();
        }
      });
    },
    [tabs, persistence, splitView]
  );

  const handleSelection = useCallback(
    (
      tabId: string,
      text: string,
      page: number,
      position: {
        x: number;
        y: number;
        pdfX: number;
        pdfY: number;
        width?: number;
        height?: number;
      }
    ) => {
      tabs.setTabSelection(tabId, {
        text,
        x: position.x,
        y: position.y,
        pdfX: position.pdfX,
        pdfY: position.pdfY,
        page,
        width: position.width,
        height: position.height,
      });
    },
    [tabs]
  );

  const activeSelection = tabs.activeTab?.selection ?? null;

  const handleAddToStash = useCallback(
    (text: string) => {
      if (!activeSelection || !tabs.activeTab) return;
      persistence.handleAddToStash(activeSelection, text);
      tabs.clearTabSelection(tabs.activeTab.id);
    },
    [activeSelection, persistence, tabs]
  );

  const handleSelectionAction = useCallback(
    (action: SelectionAction, text: string) => {
      if (!activeSelection || !tabs.activeTab) return;
      persistence.handleSelectionAction(activeSelection, action, text);
      tabs.clearTabSelection(tabs.activeTab.id);
    },
    [activeSelection, persistence, tabs]
  );

  const handleGotoStash = useCallback(
    (stash: StashItem) => {
      tabs.gotoTabPage(stash.source.tabId, stash.source.page);
      if (splitView.isSplitView) {
        if (stash.source.tabId === tabs.activeTabId) {
          setFocusedViewer("primary");
        } else if (stash.source.tabId === splitView.secondaryTabId) {
          setFocusedViewer("secondary");
        }
      }
    },
    [tabs, splitView.isSplitView, splitView.secondaryTabId]
  );

  const handleExplainClick = useCallback(
    (tabId: string, id: string) => {
      layout.openRightPanel();
      tabs.setTabHighlightedAnnotationId(tabId, id);
      if (highlightTimeoutRef.current)
        clearTimeout(highlightTimeoutRef.current);
      highlightTimeoutRef.current = setTimeout(() => {
        tabs.setTabHighlightedAnnotationId(tabId, null);
      }, 2000);
    },
    [layout, tabs]
  );

  const handlePdfLoaded = useCallback((filePath: string, bytes: Uint8Array) => {
    if (!pdfCacheRef.current.has(filePath)) {
      pdfCacheRef.current.set(filePath, bytes);
    }
  }, []);

  const showBoth = layout.leftVisible && layout.rightVisible;
  const showOnlyLeft = layout.leftVisible && !layout.rightVisible;
  const showOnlyRight = !layout.leftVisible && layout.rightVisible;

  const activeTabInitialState = useMemo(() => {
    if (!tabs.activeTab) return undefined;
    return {
      pageNum: tabs.activeTab.pageNum,
      scale: tabs.activeTab.scale,
      viewMode: tabs.activeTab.viewMode,
      scrollTop: tabs.activeTab.scrollTop,
      pendingGotoPage: tabs.activeTab.pendingGotoPage,
    };
  }, [tabs.activeTab]);

  const secondaryTabInitialState = useMemo(() => {
    if (!secondaryTab) return undefined;
    return {
      pageNum: secondaryTab.pageNum,
      scale: secondaryTab.scale,
      viewMode: secondaryTab.viewMode,
      scrollTop: secondaryTab.scrollTop,
      pendingGotoPage: secondaryTab.pendingGotoPage,
    };
  }, [secondaryTab]);

  return (
    <div className="app">
      <header className="app-header">
        <RecentFilesBar
          files={recentFiles.recentFiles}
          activeFilePath={tabs.activeTab?.filePath}
          onFileClick={handleRecentFileClick}
          onClear={recentFiles.clearRecentFiles}
        />
        <div className="app-header-actions">
          <button
            className="icon-btn settings-btn"
            onClick={() => setSettingsOpen(true)}
            aria-label={t("app.openSettings")}
            title={t("app.openSettings")}
          >
            <Icon name="settings" size={18} />
          </button>
          <button
            data-testid="open-pdf-btn"
            className="icon-btn primary open-pdf-btn"
            onClick={handleOpenPdf}
            aria-label={t("app.openPdf")}
            title={t("app.openPdf")}
          >
            <Icon name="open" size={16} />
            <span>{t("app.openPdf")}</span>
          </button>
        </div>
      </header>

      {tabs.tabs.length > 0 && (
        <div className="tab-bar" ref={tabBarRef} onWheel={handleTabBarWheel}>
          {tabs.tabs.map((tab) => (
            <div
              key={tab.id}
              data-testid={`tab-${tab.id}`}
              className={`tab-item ${tab.id === tabs.activeTabId ? "active" : ""} ${
                splitView.isSplitView && tab.id === splitView.secondaryTabId
                  ? "secondary"
                  : ""
              }`}
              onClick={() => handleTabClick(tab.id)}
              title={tab.fileName}
              draggable={tab.id !== tabs.activeTabId}
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", tab.id);
                e.dataTransfer.effectAllowed = "move";
              }}
            >
              <span className="tab-name">{tab.fileName}</span>
              <button
                className="icon-btn tab-close"
                onClick={(e) => handleCloseTab(e, tab.id)}
                aria-label={t("tab.closeNamed", { fileName: tab.fileName })}
                title={t("tab.close")}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
          {splitView.isSplitView && (
            <button
              className="icon-btn split-view-exit"
              onClick={splitView.exitSplitView}
              aria-label={t("app.exitSplitView")}
              title={t("app.exitSplitView")}
            >
              <Icon name="panel-left" size={14} />
              <span>{t("app.exitSplit")}</span>
            </button>
          )}
        </div>
      )}

      <main
        className="app-main"
        ref={layout.mainRef}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {splitView.isSplitView ? (
          <>
            <div
              className="pdf-panel expanded"
              ref={primaryPanelRef}
              style={{ flex: splitPct }}
              onClick={() => setFocusedViewer("primary")}
            >
              <PdfViewer
                key={tabs.activeTab?.id ?? "no-tab"}
                ref={pdfViewerRef}
                tabId={tabs.activeTab?.id}
                filePath={tabs.activeTab?.filePath ?? ""}
                fileHash={tabs.activeTab?.fileHash}
                cachedBytes={
                  tabs.activeTab
                    ? pdfCacheRef.current.get(tabs.activeTab.filePath)
                    : undefined
                }
                onPdfLoaded={handlePdfLoaded}
                onSelection={handleSelection}
                initialState={activeTabInitialState}
                onStateChange={tabs.handleViewerStateChange}
                annotations={persistence.visibleTabAnnotations}
                highlightedAnnotationId={
                  tabs.activeTab?.highlightedAnnotationId
                }
                onAnnotationUpdate={persistence.handleAnnotationUpdate}
                onAnnotationDelete={persistence.handleAnnotationDelete}
                onExplainClick={handleExplainClick}
                onClearPendingGotoPage={tabs.clearTabPendingGotoPage}
                hoverTranslate={hoverTranslateActive}
                settings={settings}
              />
            </div>
            <div
              className="panel-divider"
              ref={middleDividerRef}
              onMouseDown={startSplitResize}
            >
              <div className="panel-divider-handle" />
            </div>
            <div
              className="pdf-panel expanded"
              ref={secondaryPanelRef}
              style={{ flex: 100 - splitPct }}
              onClick={() => setFocusedViewer("secondary")}
            >
              <PdfViewer
                key={splitView.secondaryTabId ?? "no-secondary"}
                ref={secondaryPdfViewerRef}
                tabId={splitView.secondaryTabId ?? undefined}
                filePath={secondaryTab?.filePath ?? ""}
                fileHash={secondaryTab?.fileHash}
                cachedBytes={
                  secondaryTab
                    ? pdfCacheRef.current.get(secondaryTab.filePath)
                    : undefined
                }
                onPdfLoaded={handlePdfLoaded}
                onSelection={handleSelection}
                initialState={secondaryTabInitialState}
                onStateChange={handleSecondaryViewerStateChange}
                annotations={persistence.visibleTabAnnotations}
                highlightedAnnotationId={secondaryTab?.highlightedAnnotationId}
                onAnnotationUpdate={persistence.handleAnnotationUpdate}
                onAnnotationDelete={persistence.handleAnnotationDelete}
                onExplainClick={handleExplainClick}
                onClearPendingGotoPage={tabs.clearTabPendingGotoPage}
                hoverTranslate={hoverTranslateActive}
                settings={settings}
              />
            </div>
            {layout.rightVisible ? (
              <>
                <div className="panel-divider" onMouseDown={layout.startResize}>
                  <div className="panel-divider-handle" />
                </div>
                <div
                  className="right-panel"
                  style={{ width: `${layout.rightPct}%` }}
                >
                  <AiChatPanel
                    stashes={persistence.focusedTabStashes}
                    sessions={persistence.focusedTabSessions}
                    expandedSessionId={persistence.findSessionIdByAnnotationId(
                      tabs.activeTab?.highlightedAnnotationId ?? ""
                    )}
                    onRemoveStash={persistence.handleRemoveStash}
                    onUpdateStash={persistence.handleUpdateStash}
                    onClearStashes={persistence.handleClearStashes}
                    onCustomInterpret={(prompt) =>
                      persistence.handleCustomInterpret(
                        prompt,
                        persistence.focusedTabStashes
                      )
                    }
                    onGotoStash={handleGotoStash}
                    onFollowUp={persistence.handleFollowUp}
                    onInterrupt={persistence.handleInterruptSession}
                    onToggleVisibility={layout.toggleRight}
                    contextWindow={getContextWindow(
                      settings.platformId,
                      settings.llm.model
                    )}
                  />
                </div>
              </>
            ) : (
              <button
                className="icon-btn panel-toggle collapsed right"
                onClick={layout.toggleRight}
                aria-label={t("app.showAiAssistant")}
                title={t("app.showAiAssistant")}
              >
                <Icon name="panel-expand-right" size={16} />
              </button>
            )}
          </>
        ) : layout.leftVisible ? (
          <>
            <div
              className={`pdf-panel ${showOnlyLeft ? "expanded" : ""}`}
              style={
                showBoth
                  ? { width: `${layout.leftPct}%` }
                  : showOnlyLeft
                    ? { flex: 1 }
                    : undefined
              }
            >
              <PdfViewer
                key={tabs.activeTab?.id ?? "no-tab"}
                ref={pdfViewerRef}
                tabId={tabs.activeTab?.id}
                filePath={tabs.activeTab?.filePath ?? ""}
                fileHash={tabs.activeTab?.fileHash}
                cachedBytes={
                  tabs.activeTab
                    ? pdfCacheRef.current.get(tabs.activeTab.filePath)
                    : undefined
                }
                onPdfLoaded={handlePdfLoaded}
                onSelection={handleSelection}
                onToggleVisibility={layout.toggleLeft}
                initialState={activeTabInitialState}
                onStateChange={tabs.handleViewerStateChange}
                annotations={persistence.visibleTabAnnotations}
                highlightedAnnotationId={
                  tabs.activeTab?.highlightedAnnotationId
                }
                onAnnotationUpdate={persistence.handleAnnotationUpdate}
                onAnnotationDelete={persistence.handleAnnotationDelete}
                onExplainClick={handleExplainClick}
                onClearPendingGotoPage={tabs.clearTabPendingGotoPage}
                hoverTranslate={hoverTranslateActive}
                settings={settings}
              />
            </div>
            {showBoth && (
              <div className="panel-divider" onMouseDown={layout.startResize}>
                <div className="panel-divider-handle" />
              </div>
            )}
            {layout.rightVisible ? (
              <div
                className={`right-panel ${showOnlyRight ? "expanded" : ""}`}
                style={
                  showBoth
                    ? { width: `${layout.rightPct}%` }
                    : showOnlyRight
                      ? { flex: 1 }
                      : undefined
                }
              >
                <AiChatPanel
                  stashes={persistence.focusedTabStashes}
                  sessions={persistence.focusedTabSessions}
                  expandedSessionId={persistence.findSessionIdByAnnotationId(
                    tabs.activeTab?.highlightedAnnotationId ?? ""
                  )}
                  onRemoveStash={persistence.handleRemoveStash}
                  onUpdateStash={persistence.handleUpdateStash}
                  onClearStashes={persistence.handleClearStashes}
                  onCustomInterpret={(prompt) =>
                    persistence.handleCustomInterpret(
                      prompt,
                      persistence.focusedTabStashes
                    )
                  }
                  onGotoStash={handleGotoStash}
                  onFollowUp={persistence.handleFollowUp}
                  onInterrupt={persistence.handleInterruptSession}
                  onToggleVisibility={layout.toggleRight}
                />
              </div>
            ) : (
              <button
                className="icon-btn panel-toggle collapsed right"
                onClick={layout.toggleRight}
                aria-label={t("app.showAiAssistant")}
                title={t("app.showAiAssistant")}
              >
                <Icon name="panel-expand-right" size={16} />
              </button>
            )}
          </>
        ) : (
          <>
            <button
              className="icon-btn panel-toggle collapsed left"
              onClick={layout.toggleLeft}
              aria-label={t("app.showPdf")}
              title={t("app.showPdf")}
            >
              <Icon name="panel-expand-left" size={16} />
            </button>
            {layout.rightVisible ? (
              <div className="right-panel expanded" style={{ flex: 1 }}>
                <AiChatPanel
                  stashes={persistence.focusedTabStashes}
                  sessions={persistence.focusedTabSessions}
                  expandedSessionId={persistence.findSessionIdByAnnotationId(
                    tabs.activeTab?.highlightedAnnotationId ?? ""
                  )}
                  onRemoveStash={persistence.handleRemoveStash}
                  onUpdateStash={persistence.handleUpdateStash}
                  onClearStashes={persistence.handleClearStashes}
                  onCustomInterpret={(prompt) =>
                    persistence.handleCustomInterpret(
                      prompt,
                      persistence.focusedTabStashes
                    )
                  }
                  onGotoStash={handleGotoStash}
                  onFollowUp={persistence.handleFollowUp}
                  onInterrupt={persistence.handleInterruptSession}
                  onToggleVisibility={layout.toggleRight}
                />
              </div>
            ) : (
              <button
                className="icon-btn panel-toggle collapsed right"
                onClick={layout.toggleRight}
                aria-label={t("app.showAiAssistant")}
                title={t("app.showAiAssistant")}
              >
                <Icon name="panel-expand-right" size={16} />
              </button>
            )}
          </>
        )}
      </main>
      {settingsLoaded && (
        <SettingsModal
          open={settingsOpen}
          initialSettings={settings}
          onClose={() => setSettingsOpen(false)}
          onSave={handleSaveSettings}
        />
      )}
      <SelectionToolbar
        selection={activeSelection}
        onAction={handleSelectionAction}
        onAddToStash={handleAddToStash}
        onDismiss={() => {
          if (tabs.activeTab) {
            tabs.clearTabSelection(tabs.activeTab.id);
          }
        }}
      />
    </div>
  );
}

export default App;
