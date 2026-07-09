import { useCallback, useEffect, useRef, useState } from "react";
import PdfViewer, { PdfViewerHandle } from "./components/PdfViewer";
import SelectionToolbar from "./components/SelectionToolbar";
import AiChatPanel from "./components/AiChatPanel";
import Icon from "./components/Icon";
import { StashItem } from "./services/stash";
import { SelectionAction } from "./services/llm";
import { useTabs } from "./hooks/useTabs";
import { usePersistence, SelectionState } from "./hooks/usePersistence";
import { useRightPanelLayout } from "./hooks/useRightPanelLayout";
import "./App.css";

function App() {
  const tabs = useTabs();
  const layout = useRightPanelLayout();
  const persistence = usePersistence({
    activeTab: tabs.activeTab,
    activeTabId: tabs.activeTabId,
    openRightPanel: layout.openRightPanel,
  });

  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [highlightedAnnotationId, setHighlightedAnnotationId] = useState<string | null>(null);

  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pdfViewerRef = useRef<PdfViewerHandle>(null);

  // Cleanup highlight timeout on unmount
  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
    };
  }, []);

  const handleTabClick = useCallback((tabId: string) => {
    tabs.handleTabClick(tabId, () => {
      setSelection(null);
      setHighlightedAnnotationId(null);
    });
  }, [tabs]);

  const handleCloseTab = useCallback((e: React.MouseEvent, tabId: string) => {
    const isActive = tabs.activeTabId === tabId;
    tabs.handleCloseTab(e, tabId, () => {
      if (isActive) {
        persistence.setAnnotations([]);
        setSelection(null);
        setHighlightedAnnotationId(null);
      }
      persistence.setStashes((prev) => prev.filter((s) => s.source.tabId !== tabId));
    });
  }, [tabs, persistence]);

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
        <div className="app-brand">
          <Icon name="pdf" size={22} className="app-brand-icon" />
          <h1>StandardRead AI</h1>
        </div>
        <button
          className="icon-btn primary open-pdf-btn"
          onClick={tabs.handleOpenPdf}
          aria-label="Open PDF"
          title="打开 PDF"
        >
          <Icon name="open" size={16} />
          <span>Open PDF</span>
        </button>
      </header>

      {tabs.tabs.length > 0 && (
        <div className="tab-bar">
          {tabs.tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab-item ${tab.id === tabs.activeTabId ? "active" : ""}`}
              onClick={() => handleTabClick(tab.id)}
              title={tab.fileName}
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
        </div>
      )}

      <main className="app-main" ref={layout.mainRef}>
        {layout.leftVisible ? (
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
              onStateChange={tabs.handleViewerStateChange}
              annotations={persistence.annotations}
              highlightedAnnotationId={highlightedAnnotationId}
              onAnnotationUpdate={persistence.handleAnnotationUpdate}
              onAnnotationDelete={persistence.handleAnnotationDelete}
              onExplainClick={handleExplainClick}
            />
          </div>
        ) : (
          <button
            className="icon-btn panel-toggle collapsed left"
            onClick={layout.toggleLeft}
            aria-label="显示 PDF"
            title="显示 PDF"
          >
            <Icon name="panel-left" size={16} />
          </button>
        )}

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
              stashes={persistence.activeTabStashes}
              sessions={persistence.activeTabSessions}
              expandedSessionId={persistence.findSessionIdByAnnotationId(highlightedAnnotationId ?? "")}
              onRemoveStash={persistence.handleRemoveStash}
              onUpdateStash={persistence.handleUpdateStash}
              onClearStashes={persistence.handleClearStashes}
              onCustomInterpret={(prompt) =>
                persistence.handleCustomInterpret(prompt, persistence.activeTabStashes)
              }
              onGotoStash={handleGotoStash}
              onFollowUp={persistence.handleFollowUp}
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
      </main>
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
