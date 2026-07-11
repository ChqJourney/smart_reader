import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import PdfViewer, { PdfViewerHandle } from "./components/PdfViewer";
import SelectionToolbar from "./components/SelectionToolbar";
import AiChatPanel from "./components/AiChatPanel";
import SettingsModal from "./components/SettingsModal";
import Icon from "./components/Icon";
import { StashItem } from "./services/stash";
import { SelectionAction } from "./services/llm";
import { useTabs } from "./hooks/useTabs";
import { usePersistence, SelectionState } from "./hooks/usePersistence";
import { useRightPanelLayout, DIVIDER_WIDTH } from "./hooks/useRightPanelLayout";
import { useRecentFiles } from "./hooks/useRecentFiles";
import { useSplitView } from "./hooks/useSplitView";
import RecentFilesBar from "./components/RecentFilesBar";
import {
  AppSettings,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
} from "./services/settings";
import { useDictionaryStatus } from "./hooks/useDictionaryStatus";
import "./App.css";

const RIGHT_PANEL_SPLIT_FRACTION = 0.2;
const RIGHT_PANEL_SPLIT_MIN_WIDTH = 200;

function App() {
  const tabs = useTabs();
  const layout = useRightPanelLayout();
  const recentFiles = useRecentFiles();
  const splitView = useSplitView();
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const dictionaryStatus = useDictionaryStatus();

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

  const secondaryTab =
    tabs.tabs.find((t) => t.id === splitView.secondaryTabId) || null;

  const hoverTranslateActive =
    settings.hoverTranslate && dictionaryStatus.status?.exists === true;

  const persistence = usePersistence({
    activeTab: tabs.activeTab,
    activeTabId: tabs.activeTabId,
    secondaryTab,
    isSplitView: splitView.isSplitView,
    openRightPanel: layout.openRightPanel,
    settings,
  });

  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [highlightedAnnotationId, setHighlightedAnnotationId] = useState<string | null>(null);

  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pdfViewerRef = useRef<PdfViewerHandle>(null);
  const secondaryPdfViewerRef = useRef<PdfViewerHandle>(null);

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
        const targetWidth = Math.max(availableWidth * RIGHT_PANEL_SPLIT_FRACTION, RIGHT_PANEL_SPLIT_MIN_WIDTH);
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
  }, [splitView.isSplitView, layout.rightPanelWidth, layout.rightVisible, layout.setRightPanelWidth, layout.openRightPanel, layout.mainRef]);

  // Cleanup highlight timeout on unmount
  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
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

  const startSplitResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingSplitRef.current = true;
    currentSplitPctRef.current = splitPct;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [splitPct]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const draggedTabId = e.dataTransfer.getData("text/plain");
    if (!draggedTabId || draggedTabId === tabs.activeTabId) return;
    if (!tabs.tabs.some((t) => t.id === draggedTabId)) return;
    splitView.enterSplitView(draggedTabId);
  }, [tabs, splitView]);

  // Listen for system-driven PDF open requests (single-instance file association).
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    listen<string>("open-pdf", (event) => {
      const path = event.payload;
      const fileName = path.split("/").pop() || path;
      tabs.openPdfByPath(path, fileName).then((tab) => {
        if (tab) recentFiles.addRecentFile(tab.filePath, tab.fileName);
      });
    })
      .then((unsub) => {
        unsubscribe = unsub;
      })
      .catch(() => {
        // ignore: in non-Tauri test environments the event bridge is not available
      });
    return () => unsubscribe?.();
  }, [tabs, recentFiles]);

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

  const handleRecentFileClick = useCallback(async (file: import("./hooks/useRecentFiles").RecentFile) => {
    const tab = await tabs.openPdfByPath(file.path, file.fileName);
    if (tab) {
      recentFiles.addRecentFile(tab.filePath, tab.fileName);
    }
  }, [tabs, recentFiles]);

  const handleTabClick = useCallback((tabId: string) => {
    if (splitView.isSplitView) {
      if (tabId === tabs.activeTabId) return;
      if (tabId === splitView.secondaryTabId) {
        // Swap primary and secondary tabs
        splitView.setSecondaryTabId(tabs.activeTabId);
        tabs.handleTabClick(tabId, () => {
          setSelection(null);
          setHighlightedAnnotationId(null);
        });
        return;
      }
      // Clicked a third tab: exit split view and activate it
      splitView.exitSplitView();
    }
    tabs.handleTabClick(tabId, () => {
      setSelection(null);
      setHighlightedAnnotationId(null);
    });
  }, [tabs, splitView]);

  const handleCloseTab = useCallback((e: React.MouseEvent, tabId: string) => {
    const isActive = tabs.activeTabId === tabId;
    const isSecondary = splitView.secondaryTabId === tabId;

    tabs.handleCloseTab(e, tabId, () => {
      if (isActive) {
        persistence.setAnnotations([]);
        setSelection(null);
        setHighlightedAnnotationId(null);
      }
      persistence.setStashes((prev) => prev.filter((s) => s.source.tabId !== tabId));
      if (isSecondary || (isActive && splitView.isSplitView)) {
        splitView.exitSplitView();
      }
    });
  }, [tabs, persistence, splitView]);

  const handleSelection = useCallback((
    text: string,
    page: number,
    position: { x: number; y: number; pdfX: number; pdfY: number; width?: number; height?: number }
  ) => {
    setSelection({
      text,
      x: position.x,
      y: position.y,
      pdfX: position.pdfX,
      pdfY: position.pdfY,
      page,
      width: position.width,
      height: position.height,
    });
  }, []);

  const handleAddToStash = useCallback((text: string) => {
    if (!selection) return;
    persistence.handleAddToStash(selection, text);
    setSelection(null);
  }, [selection, persistence]);

  const handleSelectionAction = useCallback((action: SelectionAction, text: string) => {
    if (!selection) return;
    persistence.handleSelectionAction(selection, action, text);
    setSelection(null);
  }, [selection, persistence]);

  const handleGotoStash = useCallback((stash: StashItem) => {
    tabs.gotoTabPage(stash.source.tabId, stash.source.page);
    pdfViewerRef.current?.goToPage(stash.source.page);
  }, [tabs]);

  const handleExplainClick = useCallback((id: string) => {
    layout.openRightPanel();
    setHighlightedAnnotationId(id);
    if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
    highlightTimeoutRef.current = setTimeout(() => setHighlightedAnnotationId(null), 2000);
  }, [layout]);

  const showBoth = layout.leftVisible && layout.rightVisible;
  const showOnlyLeft = layout.leftVisible && !layout.rightVisible;
  const showOnlyRight = !layout.leftVisible && layout.rightVisible;

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
            aria-label="打开设置"
            title="打开设置"
          >
            <Icon name="settings" size={18} />
          </button>
          <button
            className="icon-btn primary open-pdf-btn"
            onClick={handleOpenPdf}
            aria-label="Open PDF"
            title="打开 PDF"
          >
            <Icon name="open" size={16} />
            <span>Open PDF</span>
          </button>
        </div>
      </header>

      {tabs.tabs.length > 0 && (
        <div className="tab-bar">
          {tabs.tabs.map((tab) => (
            <div
              key={tab.id}
              data-testid={`tab-${tab.id}`}
              className={`tab-item ${tab.id === tabs.activeTabId ? "active" : ""} ${
                splitView.isSplitView && tab.id === splitView.secondaryTabId ? "secondary" : ""
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
                aria-label={`关闭 ${tab.fileName}`}
                title="关闭标签页"
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
          {splitView.isSplitView && (
            <button
              className="icon-btn split-view-exit"
              onClick={splitView.exitSplitView}
              aria-label="退出并排视图"
              title="退出并排视图"
            >
              <Icon name="panel-left" size={14} />
              <span>退出并排</span>
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
            <div className="pdf-panel expanded" ref={primaryPanelRef} style={{ flex: splitPct }}>
              <PdfViewer
                ref={pdfViewerRef}
                filePath={tabs.activeTab?.filePath ?? ""}
                onSelection={handleSelection}
                initialState={
                  tabs.activeTab
                    ? {
                        pageNum: tabs.activeTab.pageNum,
                        scale: tabs.activeTab.scale,
                        viewMode: tabs.activeTab.viewMode,
                      }
                    : undefined
                }
                onStateChange={(state) => tabs.handleViewerStateChange(state, tabs.activeTabId ?? undefined)}
                annotations={persistence.annotations}
                highlightedAnnotationId={highlightedAnnotationId}
                onAnnotationUpdate={persistence.handleAnnotationUpdate}
                onAnnotationDelete={persistence.handleAnnotationDelete}
                onExplainClick={handleExplainClick}
                hoverTranslate={hoverTranslateActive}
              />
            </div>
            <div
              className="panel-divider"
              ref={middleDividerRef}
              onMouseDown={startSplitResize}
            >
              <div className="panel-divider-handle" />
            </div>
            <div className="pdf-panel expanded" ref={secondaryPanelRef} style={{ flex: 100 - splitPct }}>
              <PdfViewer
                ref={secondaryPdfViewerRef}
                filePath={tabs.tabs.find((t) => t.id === splitView.secondaryTabId)?.filePath ?? ""}
                onSelection={handleSelection}
                initialState={
                  (() => {
                    const tab = tabs.tabs.find((t) => t.id === splitView.secondaryTabId);
                    return tab
                      ? {
                          pageNum: tab.pageNum,
                          scale: tab.scale,
                          viewMode: tab.viewMode,
                        }
                      : undefined;
                  })()
                }
                onStateChange={(state) =>
                  tabs.handleViewerStateChange(state, splitView.secondaryTabId ?? undefined)
                }
                annotations={persistence.annotations}
                highlightedAnnotationId={highlightedAnnotationId}
                onAnnotationUpdate={persistence.handleAnnotationUpdate}
                onAnnotationDelete={persistence.handleAnnotationDelete}
                onExplainClick={handleExplainClick}
                hoverTranslate={hoverTranslateActive}
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
                    stashes={persistence.visibleTabStashes}
                    sessions={persistence.visibleTabSessions}
                    expandedSessionId={persistence.findSessionIdByAnnotationId(highlightedAnnotationId ?? "")}
                    onRemoveStash={persistence.handleRemoveStash}
                    onUpdateStash={persistence.handleUpdateStash}
                    onClearStashes={persistence.handleClearStashes}
                    onCustomInterpret={(prompt) =>
                      persistence.handleCustomInterpret(prompt, persistence.visibleTabStashes)
                    }
                    onGotoStash={handleGotoStash}
                    onFollowUp={persistence.handleFollowUp}
                    onInterrupt={persistence.handleInterruptSession}
                    onToggleVisibility={layout.toggleRight}
                  />
                </div>
              </>
            ) : (
              <button
                className="icon-btn panel-toggle collapsed right"
                onClick={layout.toggleRight}
                aria-label="显示 AI 助手"
                title="显示 AI 助手"
              >
                <Icon name="panel-right" size={16} />
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
                ref={pdfViewerRef}
                filePath={tabs.activeTab?.filePath ?? ""}
                onSelection={handleSelection}
                onToggleVisibility={layout.toggleLeft}
                initialState={
                  tabs.activeTab
                    ? {
                        pageNum: tabs.activeTab.pageNum,
                        scale: tabs.activeTab.scale,
                        viewMode: tabs.activeTab.viewMode,
                      }
                    : undefined
                }
                onStateChange={(state) => tabs.handleViewerStateChange(state, tabs.activeTabId ?? undefined)}
                annotations={persistence.annotations}
                highlightedAnnotationId={highlightedAnnotationId}
                onAnnotationUpdate={persistence.handleAnnotationUpdate}
                onAnnotationDelete={persistence.handleAnnotationDelete}
                onExplainClick={handleExplainClick}
                hoverTranslate={hoverTranslateActive}
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
                  stashes={persistence.visibleTabStashes}
                  sessions={persistence.visibleTabSessions}
                  expandedSessionId={persistence.findSessionIdByAnnotationId(highlightedAnnotationId ?? "")}
                  onRemoveStash={persistence.handleRemoveStash}
                  onUpdateStash={persistence.handleUpdateStash}
                  onClearStashes={persistence.handleClearStashes}
                  onCustomInterpret={(prompt) =>
                    persistence.handleCustomInterpret(prompt, persistence.visibleTabStashes)
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
                aria-label="显示 AI 助手"
                title="显示 AI 助手"
              >
                <Icon name="panel-right" size={16} />
              </button>
            )}
          </>
        ) : (
          <>
            <button
              className="icon-btn panel-toggle collapsed left"
              onClick={layout.toggleLeft}
              aria-label="显示 PDF"
              title="显示 PDF"
            >
              <Icon name="panel-left" size={16} />
            </button>
            {layout.rightVisible ? (
              <div className="right-panel expanded" style={{ flex: 1 }}>
                <AiChatPanel
                  stashes={persistence.visibleTabStashes}
                  sessions={persistence.visibleTabSessions}
                  expandedSessionId={persistence.findSessionIdByAnnotationId(highlightedAnnotationId ?? "")}
                  onRemoveStash={persistence.handleRemoveStash}
                  onUpdateStash={persistence.handleUpdateStash}
                  onClearStashes={persistence.handleClearStashes}
                  onCustomInterpret={(prompt) =>
                    persistence.handleCustomInterpret(prompt, persistence.visibleTabStashes)
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
                aria-label="显示 AI 助手"
                title="显示 AI 助手"
              >
                <Icon name="panel-right" size={16} />
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
        selection={selection}
        onAction={handleSelectionAction}
        onAddToStash={handleAddToStash}
        onDismiss={() => setSelection(null)}
      />
    </div>
  );
}

export default App;
