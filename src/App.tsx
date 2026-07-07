import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import PdfViewer, { PdfViewerHandle, PdfViewerState } from "./components/PdfViewer";
import SelectionToolbar from "./components/SelectionToolbar";
import AiChatPanel from "./components/AiChatPanel";
import Icon from "./components/Icon";
import {
  Annotation,
  createAnnotation,
  deleteAnnotation,
  loadAnnotations,
  saveAnnotations,
  updateAnnotation,
} from "./services/annotations";
import { SelectionAction } from "./services/llm";
import "./App.css";

const MIN_PANEL_WIDTH = 240;
const DIVIDER_WIDTH = 6;
const MAX_TABS = 10;
const RIGHT_PANEL_MIN_WIDTH = 180;
const RIGHT_PANEL_DEFAULT_FRACTION = 3 / 8;
const RIGHT_PANEL_LAYOUT_KEY = "pdfAgent.rightPanelLayout";

function loadRightPanelLayout(): { visible: boolean; width: number } {
  try {
    const raw = localStorage.getItem(RIGHT_PANEL_LAYOUT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        visible: typeof parsed.visible === "boolean" ? parsed.visible : true,
        width: typeof parsed.width === "number" ? parsed.width : 0,
      };
    }
  } catch {
    // ignore
  }
  return { visible: true, width: 0 };
}

interface PdfTab {
  id: string;
  filePath: string;
  fileName: string;
  pageNum?: number;
  scale?: number;
  viewMode?: "single" | "continuous";
}

function App() {
  const rightPanelLayout = useMemo(() => loadRightPanelLayout(), []);
  const [tabs, setTabs] = useState<PdfTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [selection, setSelection] = useState<{
    text: string;
    x: number;
    y: number;
    pdfX: number;
    pdfY: number;
    page: number;
  } | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [highlightedAnnotationId, setHighlightedAnnotationId] = useState<string | null>(null);

  const [leftVisible, setLeftVisible] = useState(true);
  const [rightVisible, setRightVisible] = useState(rightPanelLayout.visible);
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(rightPanelLayout.width);

  const mainRef = useRef<HTMLElement>(null);
  const isDraggingRef = useRef(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pdfViewerRef = useRef<PdfViewerHandle>(null);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null;

  // Load annotations when active file changes
  useEffect(() => {
    if (!activeTab?.filePath) {
      setAnnotations([]);
      return;
    }
    let cancelled = false;
    loadAnnotations(activeTab.filePath).then((loaded) => {
      if (cancelled) return;
      setAnnotations(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [activeTab?.filePath]);

  // Persist annotations with debounce
  useEffect(() => {
    if (!activeTab?.filePath) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      saveAnnotations(activeTab.filePath, annotations);
    }, 500);
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [annotations, activeTab?.filePath]);

  // Cleanup highlight timeout on unmount
  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
    };
  }, []);

  // Restore default right panel width if no persisted value exists
  useEffect(() => {
    if (rightPanelWidth > 0) return;
    const availableWidth = Math.max(
      0,
      (mainRef.current?.getBoundingClientRect().width ?? window.innerWidth) - DIVIDER_WIDTH
    );
    setRightPanelWidth(Math.max(availableWidth * RIGHT_PANEL_DEFAULT_FRACTION, RIGHT_PANEL_MIN_WIDTH));
  }, [rightPanelWidth]);

  // Persist right panel width and visibility
  useEffect(() => {
    if (rightPanelWidth <= 0) return;
    try {
      localStorage.setItem(
        RIGHT_PANEL_LAYOUT_KEY,
        JSON.stringify({ visible: rightVisible, width: rightPanelWidth })
      );
    } catch {
      // ignore
    }
  }, [rightVisible, rightPanelWidth]);

  async function handleOpenPdf() {
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
      const newTab: PdfTab = {
        id: crypto.randomUUID(),
        filePath: path,
        fileName: path.split("/").pop() || path,
      };

      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
    } catch (error) {
      console.error("Failed to open PDF:", error);
    }
  }

  const handleCloseTab = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();

    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return;

    const nextTabs = tabs.filter((tab) => tab.id !== tabId);

    if (activeTabId === tabId) {
      const nextActive = nextTabs[Math.min(index, nextTabs.length - 1)] || null;
      setActiveTabId(nextActive?.id ?? null);
    }

    setTabs(nextTabs);
  };

  const handleTabClick = (tabId: string) => {
    setActiveTabId(tabId);
    setSelection(null);
    setHighlightedAnnotationId(null);
  };

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

  const handleSelection = useCallback((
    text: string,
    page: number,
    position: { x: number; y: number; pdfX: number; pdfY: number }
  ) => {
    setSelection({ text, x: position.x, y: position.y, pdfX: position.pdfX, pdfY: position.pdfY, page });
  }, []);

  const handleSelectionAction = useCallback((action: SelectionAction, text: string) => {
    if (!selection) return;

    const newAnnotation = createAnnotation(action, text, selection.page, selection.pdfX, selection.pdfY);
    setAnnotations((prev) => [...prev, newAnnotation]);
    setSelection(null);

    if (action === "explain") {
      setRightVisible(true);
    }
  }, [selection]);

  const handleAnnotationUpdate = useCallback((id: string, patch: Partial<Omit<Annotation, "id">>) => {
    setAnnotations((prev) => updateAnnotation(prev, id, patch));
  }, []);

  const handleAnnotationDelete = useCallback((id: string) => {
    setAnnotations((prev) => deleteAnnotation(prev, id));
  }, []);

  const handleGotoAnnotation = useCallback((annotation: Annotation) => {
    setHighlightedAnnotationId(annotation.id);
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === activeTabId
          ? { ...tab, pageNum: annotation.position.page }
          : tab
      )
    );
    pdfViewerRef.current?.goToPage(annotation.position.page);
    if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
    highlightTimeoutRef.current = setTimeout(() => setHighlightedAnnotationId(null), 2000);
  }, [activeTabId]);

  const startResize = () => {
    if (!mainRef.current) return;
    isDraggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !mainRef.current) return;

      const rect = mainRef.current.getBoundingClientRect();
      const availableWidth = rect.width - DIVIDER_WIDTH;
      const x = e.clientX - rect.left;
      const newLeftPx = Math.max(
        MIN_PANEL_WIDTH,
        Math.min(availableWidth - RIGHT_PANEL_MIN_WIDTH, x)
      );
      const newRightPx = Math.max(RIGHT_PANEL_MIN_WIDTH, availableWidth - newLeftPx);
      setRightPanelWidth(newRightPx);
    };

    const handleMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const toggleLeft = () => setLeftVisible((v) => !v);
  const toggleRight = () => setRightVisible((v) => !v);

  const availableWidth = Math.max(
    0,
    (mainRef.current?.getBoundingClientRect().width ?? window.innerWidth) - DIVIDER_WIDTH
  );
  const effectiveRightWidth =
    rightPanelWidth > 0
      ? Math.max(
          RIGHT_PANEL_MIN_WIDTH,
          Math.min(
            Math.max(RIGHT_PANEL_MIN_WIDTH, availableWidth - MIN_PANEL_WIDTH),
            rightPanelWidth
          )
        )
      : Math.max(availableWidth * RIGHT_PANEL_DEFAULT_FRACTION, RIGHT_PANEL_MIN_WIDTH);
  const leftPct = availableWidth > 0 ? ((availableWidth - effectiveRightWidth) / availableWidth) * 100 : 100 - RIGHT_PANEL_DEFAULT_FRACTION * 100;
  const rightPct = availableWidth > 0 ? (effectiveRightWidth / availableWidth) * 100 : RIGHT_PANEL_DEFAULT_FRACTION * 100;

  const showBoth = leftVisible && rightVisible;
  const showOnlyLeft = leftVisible && !rightVisible;
  const showOnlyRight = !leftVisible && rightVisible;

  const explainAnnotations = annotations.filter((a) => a.type === "explain");

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-brand">
          <Icon name="pdf" size={22} className="app-brand-icon" />
          <h1>StandardRead AI</h1>
        </div>
        <button
          className="icon-btn primary open-pdf-btn"
          onClick={handleOpenPdf}
          aria-label="Open PDF"
          title="打开 PDF"
        >
          <Icon name="open" size={16} />
          <span>Open PDF</span>
        </button>
      </header>

      {tabs.length > 0 && (
        <div className="tab-bar">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab-item ${tab.id === activeTabId ? "active" : ""}`}
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

      <main className="app-main" ref={mainRef}>
        {leftVisible ? (
          <div
            className={`pdf-panel ${showOnlyLeft ? "expanded" : ""}`}
            style={
              showBoth
                ? { width: `${leftPct}%` }
                : showOnlyLeft
                ? { flex: 1 }
                : undefined
            }
          >
            <PdfViewer
              ref={pdfViewerRef}
              filePath={activeTab?.filePath ?? ""}
              onSelection={handleSelection}
              onToggleVisibility={toggleLeft}
              initialState={
                activeTab
                  ? {
                      pageNum: activeTab.pageNum,
                      scale: activeTab.scale,
                      viewMode: activeTab.viewMode,
                    }
                  : undefined
              }
              onStateChange={handleViewerStateChange}
              annotations={annotations}
              highlightedAnnotationId={highlightedAnnotationId}
              onAnnotationUpdate={handleAnnotationUpdate}
              onAnnotationDelete={handleAnnotationDelete}
              onExplainClick={(id) => {
                setRightVisible(true);
                setHighlightedAnnotationId(id);
                if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
                highlightTimeoutRef.current = setTimeout(() => setHighlightedAnnotationId(null), 2000);
              }}
            />
          </div>
        ) : (
          <button
            className="icon-btn panel-toggle collapsed left"
            onClick={toggleLeft}
            aria-label="显示 PDF"
            title="显示 PDF"
          >
            <Icon name="panel-left" size={16} />
          </button>
        )}

        {showBoth && (
          <div className="panel-divider" onMouseDown={startResize}>
            <div className="panel-divider-handle" />
          </div>
        )}

        {rightVisible ? (
          <div
            className={`right-panel ${showOnlyRight ? "expanded" : ""}`}
            style={
              showBoth
                ? { width: `${rightPct}%` }
                : showOnlyRight
                ? { flex: 1 }
                : undefined
            }
          >
            <AiChatPanel
              explainAnnotations={explainAnnotations}
              onGotoAnnotation={handleGotoAnnotation}
              onAnnotationUpdate={handleAnnotationUpdate}
              onToggleVisibility={toggleRight}
            />
          </div>
        ) : (
          <button
            className="icon-btn panel-toggle collapsed right"
            onClick={toggleRight}
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
        onDismiss={() => setSelection(null)}
      />
    </div>
  );
}

export default App;
