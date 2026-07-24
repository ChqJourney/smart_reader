import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import PdfViewer, {
  PdfViewerHandle,
  PdfViewerState,
} from "./components/PdfViewer";
import SelectionToolbar from "./components/SelectionToolbar";
import AiChatPanel from "./components/AiChatPanel";
import SettingsModal from "./components/SettingsModal";
import SetupWizard from "./components/SetupWizard";
import Icon from "./components/Icon";
import { StashItem } from "./services/stash";
import { InterpretationSession } from "./services/sessions";
import { SelectionAction } from "./services/llm";
import { useTabs } from "./hooks/useTabs";
import { usePersistence } from "./hooks/usePersistence";
import {
  useRightPanelLayout,
  DIVIDER_WIDTH,
} from "./hooks/useRightPanelLayout";
import { useRecentFiles, type RecentFile } from "./hooks/useRecentFiles";
import { useSplitView } from "./hooks/useSplitView";
import TitleBar from "./components/TitleBar";
import {
  AppSettings,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  checkApiKey,
} from "./services/settings";
import { getContextWindow, PLATFORM_LIST } from "./data/platformPresets";
import { copyToClipboard } from "./utils/clipboard";
import { showMessage } from "./services/dialog";
import { useDictionaryStatus } from "./hooks/useDictionaryStatus";
import { checkForUpdate } from "./services/updater";
import { error } from "./services/logs";
import { syncOpenPdfs } from "./services/pdfToolsRegistry";
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
  const [wizardOpen, setWizardOpen] = useState(false);
  const dictionaryStatus = useDictionaryStatus();

  // PDF bytes cache keyed by filePath. Reused across tab switches so large
  // files do not have to be read from disk every time the user changes tabs.
  // Each PdfViewer keeps its own PDFDocumentProxy instance to avoid sharing
  // internal PDF.js transport state between component lifecycles.
  const pdfCacheRef = useRef<Map<string, Uint8Array>>(new Map());

  // Keep the agent tool layer in sync with currently open tabs.
  useEffect(() => {
    syncOpenPdfs(
      tabs.tabs.map((t) => ({
        fileHash: t.fileHash,
        fileName: t.fileName,
        filePath: t.filePath,
      })),
      (filePath) => pdfCacheRef.current.get(filePath)
    );
  }, [tabs.tabs]);

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

  // 首次启动检测：若没有任何平台配置过 API Key，自动弹出配置向导。
  // 让非编程用户不必自己摸索「设置 → 模型 → 找 Key」，直接跟随三步向导完成。
  useEffect(() => {
    if (!settingsLoaded) return;
    let cancelled = false;
    const platformIds = PLATFORM_LIST.filter((p) => p.id !== "custom").map(
      (p) => p.id
    );
    Promise.all(platformIds.map((id) => checkApiKey(id)))
      .then((results) => {
        if (cancelled) return;
        const anyKeyConfigured = results.some(Boolean);
        if (!anyKeyConfigured) setWizardOpen(true);
      })
      .catch((err) => {
        error(`[App] 首次启动向导检测失败: ${err}`);
      });
    return () => {
      cancelled = true;
    };
  }, [settingsLoaded]);

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

  const contextWindow = useMemo(
    () => getContextWindow(settings.platformId, settings.llm.model),
    [settings.platformId, settings.llm.model]
  );

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

  // persistence 根对象随 sessions 状态变化（流式输出期间每个 flush 都变），
  // 把回调需要调用的方法解构为稳定别名，保证依赖它们的 App 回调身份稳定。
  // （deps 里直接写 persistence.xxx 成员会触发 react-hooks v7 的
  // exhaustive-deps 告警：方法调用按读取根对象处理。）
  const {
    handleAddToStash: persistenceHandleAddToStash,
    handleSelectionAction: persistenceHandleSelectionAction,
    handleAddComment: persistenceHandleAddComment,
    abortSessionsForTab: persistenceAbortSessionsForTab,
    setStashes: persistenceSetStashes,
  } = persistence;
  // tabs 根对象随阅读状态（页码/滚动）高频变化；onStateChange 每次渲染都传
  // 给 PdfViewer，用稳定别名避免该 prop 随 tab 状态抖动。
  const { handleViewerStateChange } = tabs;

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
  const wasSplitRef = useRef(false);

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
      // 仅在进入分屏的瞬间补开 AI 栏；分屏期间允许用户手动关闭，
      // 否则依赖 rightVisible 会让关闭动作被立即撤销。
      if (!wasSplitRef.current && !layout.rightVisible) {
        layout.openRightPanel();
      }
    } else {
      if (prevRightWidthRef.current !== null) {
        layout.setRightPanelWidth(prevRightWidthRef.current);
        prevRightWidthRef.current = null;
      }
    }
    wasSplitRef.current = splitView.isSplitView;
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

  // 拖拽 tab 经过主区域时显示 drop-zone 遮罩。用计数器抵消子元素间移动
  // 造成的 dragenter/dragleave 抖动；drop / dragend 时兜底复位。
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepthRef = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  }, []);

  const resetDragOver = useCallback(() => {
    dragDepthRef.current = 0;
    setIsDragOver(false);
  }, []);

  useEffect(() => {
    if (!isDragOver) return;
    window.addEventListener("dragend", resetDragOver);
    window.addEventListener("drop", resetDragOver);
    return () => {
      window.removeEventListener("dragend", resetDragOver);
      window.removeEventListener("drop", resetDragOver);
    };
  }, [isDragOver, resetDragOver]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      resetDragOver();
      const draggedTabId = e.dataTransfer.getData("text/plain");
      if (!draggedTabId || draggedTabId === tabs.activeTabId) return;
      if (!tabs.tabs.some((t) => t.id === draggedTabId)) return;
      splitView.enterSplitView(draggedTabId);
    },
    [tabs, splitView, resetDragOver]
  );

  // tab 栏「并排对照」入口：取下一个非激活 tab 作为副屏。
  const handleEnterSplit = useCallback(() => {
    const activeIndex = tabs.tabs.findIndex((t) => t.id === tabs.activeTabId);
    const nextTab = tabs.tabs[(activeIndex + 1) % tabs.tabs.length];
    if (!nextTab || nextTab.id === tabs.activeTabId) return;
    splitView.enterSplitView(nextTab.id);
  }, [tabs, splitView]);

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
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    listen<string>("open-pdf", (event) => {
      const path = event.payload;
      openPdfByPathRef.current(path).then((tab) => {
        if (tab) addRecentFileRef.current(tab.filePath, tab.fileName);
      });
    })
      .then((unsub) => {
        if (cancelled) {
          unsub();
          return;
        }
        unsubscribe = unsub;
        // 冷启动时后端的 open-pdf emit 可能先于本 listener 注册而丢失，
        // 对应路径会被后端缓存；listener 就绪后取回（并清空）这批路径。
        invoke<string[]>("take_pending_open_pdfs")
          .then((paths) => {
            if (cancelled || !Array.isArray(paths)) return;
            for (const path of paths) {
              openPdfByPathRef.current(path).then((tab) => {
                if (tab) addRecentFileRef.current(tab.filePath, tab.fileName);
              });
            }
          })
          .catch(() => {
            // ignore: in non-Tauri test environments the command is unavailable
          });
      })
      .catch(() => {
        // ignore: in non-Tauri test environments the event bridge is not available
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  // 退出前 flush：批注/会话保存走 500ms 防抖，直接关窗会丢失最后一个窗口期
  // 内的修改；同时把当前打开 tab 的页码回写到最近文件（平时仅在显式关 tab
  // 时回写）。用 ref 持有最新闭包，保证 listener 只注册一次。
  const flushOnExitRef = useRef(async () => {
    for (const tab of tabs.tabs) {
      if (tab.pageNum) {
        recentFiles.updateLastPage(tab.filePath, tab.pageNum);
      }
    }
    await persistence.flushPendingSaves();
  });
  flushOnExitRef.current = async () => {
    for (const tab of tabs.tabs) {
      if (tab.pageNum) {
        recentFiles.updateLastPage(tab.filePath, tab.pageNum);
      }
    }
    await persistence.flushPendingSaves();
  };

  // 优先用 Tauri onCloseRequested（比 beforeunload 可靠：WebView2 关窗时
  // 不一定触发 beforeunload）。preventDefault 阻止立即销毁，落盘完成后手动
  // destroy；非 Tauri 环境（浏览器 dev / 测试）静默跳过。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let flushing = false;
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        const win = getCurrentWindow();
        return win.onCloseRequested((event) => {
          event.preventDefault();
          if (flushing) return; // 重复触发不再重入，等待首次 flush 完成
          flushing = true;
          void (async () => {
            try {
              // 后端卡住时不能阻塞关窗，超时兜底
              await Promise.race([
                flushOnExitRef.current(),
                new Promise((resolve) => setTimeout(resolve, 3000)),
              ]);
            } finally {
              await win.destroy();
            }
          })();
        });
      })
      .then((unsub) => {
        unlisten = unsub;
      })
      .catch(() => {
        // ignore: 非 Tauri 环境无窗口 API
      });
    return () => unlisten?.();
  }, []);

  const handleSecondaryViewerStateChange = useCallback(
    (state: PdfViewerState) => {
      handleViewerStateChange(state, splitView.secondaryTabId ?? undefined);
    },
    [handleViewerStateChange, splitView.secondaryTabId]
  );

  const handleSaveSettings = useCallback(async (newSettings: AppSettings) => {
    try {
      await saveSettings(newSettings);
      setSettings(newSettings);
      setSettingsOpen(false);
    } catch (err) {
      error(`[App] 保存设置失败: ${err}`);
    }
  }, []);

  // 配置向导完成：保存并应用最终设置，关闭向导。
  const handleWizardComplete = useCallback((finalSettings: AppSettings) => {
    setSettings(finalSettings);
    setWizardOpen(false);
  }, []);

  // 配置向导跳过：未配置也能浏览 PDF，关闭向导即可。
  const handleWizardSkip = useCallback(() => {
    setWizardOpen(false);
  }, []);

  // 从「设置」中重新运行配置向导。
  const handleRunWizard = useCallback(() => {
    setSettingsOpen(false);
    setWizardOpen(true);
  }, []);

  const handleOpenPdf = useCallback(async () => {
    const newTab = await tabs.handleOpenPdf();
    if (newTab) {
      recentFiles.addRecentFile(newTab.filePath, newTab.fileName);
    }
  }, [tabs, recentFiles]);

  const handleRecentFileClick = useCallback(
    async (file: RecentFile) => {
      // 带上 lastPage，viewer 挂载后自动恢复到上次读到的页码
      const tab = await tabs.openPdfByPath(file.path, file.lastPage);
      if (tab) {
        recentFiles.addRecentFile(tab.filePath, tab.fileName);
      }
    },
    [tabs, recentFiles]
  );

  const handleOpenRecentInSplit = useCallback(
    async (file: RecentFile) => {
      const primaryId = tabs.activeTabId;
      const tab = await tabs.openPdfByPath(file.path, file.lastPage);
      if (!tab) return;
      recentFiles.addRecentFile(tab.filePath, tab.fileName);
      // 没有主视图，或目标就是主视图本身时无法对照，明确提示而非静默降级
      if (!primaryId || tab.id === primaryId) {
        await showMessage(
          t("common.notice"),
          t("recentFiles.splitUnavailable")
        );
        return;
      }
      // openPdfByPath 会激活目标 tab；先把主视图切回原 tab，再将其设为副屏
      tabs.handleTabClick(primaryId);
      splitView.enterSplitView(tab.id);
      setFocusedViewer("secondary");
    },
    [tabs, recentFiles, splitView, t]
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
          persistenceAbortSessionsForTab(
            tabId,
            closingTab.fileHash,
            remainingTabIds
          );
          // 回写阅读页码，最近文件列表展示「读到第 N 页」并支持恢复
          if (closingTab.pageNum) {
            recentFiles.updateLastPage(closingTab.filePath, closingTab.pageNum);
          }
        }
        // Remove the cached bytes when no other tab uses the same file path.
        const pathStillOpen = tabs.tabs.some(
          (t) => t.id !== tabId && t.filePath === closingTab?.filePath
        );
        if (!pathStillOpen && closingTab) {
          pdfCacheRef.current.delete(closingTab.filePath);
        }
        persistenceSetStashes((prev) =>
          prev.filter((s) => s.source.tabId !== tabId)
        );
        if (isSecondary || (isActive && splitView.isSplitView)) {
          splitView.exitSplitView();
        }
      });
    },
    [
      tabs,
      splitView,
      recentFiles,
      persistenceAbortSessionsForTab,
      persistenceSetStashes,
    ]
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
      // 在哪屏产生选区，焦点跟到哪屏：否则在副屏选中后浮动工具条
      // 仍消费主屏选区，暂存/解读会落到错误的 tab。
      if (splitView.isSplitView) {
        if (tabId === splitView.secondaryTabId) {
          setFocusedViewer("secondary");
        } else if (tabId === tabs.activeTabId) {
          setFocusedViewer("primary");
        }
      }
    },
    [tabs, splitView.isSplitView, splitView.secondaryTabId]
  );

  // 选区消费跟随焦点屏（非分屏时 focusedTab 即 activeTab）。
  const focusedSelection = focusedTab?.selection ?? null;

  const handleAddToStash = useCallback(
    (text: string) => {
      if (!focusedSelection || !focusedTab) return;
      persistenceHandleAddToStash(focusedSelection, text);
      tabs.clearTabSelection(focusedTab.id);
    },
    [focusedSelection, focusedTab, persistenceHandleAddToStash, tabs]
  );

  const handleSelectionAction = useCallback(
    (action: SelectionAction, text: string) => {
      if (!focusedSelection || !focusedTab) return;
      persistenceHandleSelectionAction(focusedSelection, action, text);
      tabs.clearTabSelection(focusedTab.id);
    },
    [focusedSelection, focusedTab, persistenceHandleSelectionAction, tabs]
  );

  const handleCopy = useCallback(
    (text: string) => {
      if (!focusedTab) return;
      // `void` + `.catch`: copyToClipboard falls back to execCommand('copy')
      // which throws when it fails — surface the failure to the log instead of
      // letting it become an unhandled promise rejection.
      void copyToClipboard(text).catch((err) => {
        error(`Failed to copy selection: ${err}`);
      });
      tabs.clearTabSelection(focusedTab.id);
    },
    [focusedTab, tabs]
  );

  const handleAddComment = useCallback(
    (text: string) => {
      if (!focusedSelection || !focusedTab) return;
      persistenceHandleAddComment(focusedSelection, text);
      tabs.clearTabSelection(focusedTab.id);
    },
    [focusedSelection, focusedTab, persistenceHandleAddComment, tabs]
  );

  const handleGotoStash = useCallback(
    (stash: StashItem) => {
      // 分屏下跳转到副屏 tab 用不激活版本，避免副屏被提升为 active
      // 导致两个面板渲染同一 PDF（塌缩）。
      if (
        splitView.isSplitView &&
        stash.source.tabId === splitView.secondaryTabId
      ) {
        tabs.gotoTabPage(stash.source.tabId, stash.source.page, {
          activate: false,
        });
        setFocusedViewer("secondary");
        return;
      }
      tabs.gotoTabPage(stash.source.tabId, stash.source.page);
      if (splitView.isSplitView && stash.source.tabId === tabs.activeTabId) {
        setFocusedViewer("primary");
      }
    },
    [tabs, splitView.isSplitView, splitView.secondaryTabId]
  );

  const handleGotoSession = useCallback(
    (session: InterpretationSession) => {
      // source.tabId 可能是持久化前的旧 id（tab 重开/重启后失效），
      // 按 fileHash 匹配当前打开的 tab 来确定跳转目标。
      const source = session.sources
        .map((s) => s.source)
        .find((src) => tabs.tabs.some((t) => t.fileHash === src.fileHash));
      if (!source) return;
      const targetTab = tabs.tabs.find((t) => t.fileHash === source.fileHash);
      if (!targetTab) return;
      if (splitView.isSplitView && targetTab.id === splitView.secondaryTabId) {
        tabs.gotoTabPage(targetTab.id, source.page, { activate: false });
        setFocusedViewer("secondary");
        return;
      }
      tabs.gotoTabPage(targetTab.id, source.page);
      if (splitView.isSplitView && targetTab.id === tabs.activeTabId) {
        setFocusedViewer("primary");
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

  const openFilePaths = useMemo(
    () => tabs.tabs.map((tab) => tab.filePath),
    [tabs.tabs]
  );

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
      <TitleBar
        recentFiles={{
          files: recentFiles.recentFiles,
          openFilePaths: openFilePaths,
          onFileClick: handleRecentFileClick,
          onOpenInSplit: handleOpenRecentInSplit,
          onTogglePin: recentFiles.togglePinRecentFile,
          onRemove: recentFiles.removeRecentFile,
          onClear: recentFiles.clearRecentFiles,
        }}
        onOpenPdf={handleOpenPdf}
        onOpenSettings={() => setSettingsOpen(true)}
      />

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
              title={
                tab.id !== tabs.activeTabId
                  ? `${tab.fileName}\n${t("tab.dragToSplit")}`
                  : tab.fileName
              }
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
          {!splitView.isSplitView && tabs.tabs.length >= 2 && (
            <button
              className="icon-btn split-view-enter"
              onClick={handleEnterSplit}
              aria-label={t("app.enterSplitView")}
              title={t("app.enterSplitView")}
            >
              <Icon name="panel-right" size={14} />
              <span>{t("app.enterSplitView")}</span>
            </button>
          )}
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
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragOver && (
          <div className="split-drop-overlay">
            <span>{t("app.dropToSplit")}</span>
          </div>
        )}
        {splitView.isSplitView ? (
          <>
            <div
              className="pdf-panel expanded"
              ref={primaryPanelRef}
              style={{ flex: splitPct }}
              onMouseDown={() => setFocusedViewer("primary")}
            >
              <PdfViewer
                key={tabs.activeTab?.id ?? "no-tab"}
                ref={pdfViewerRef}
                tabId={tabs.activeTab?.id}
                filePath={tabs.activeTab?.filePath ?? ""}
                fileHash={tabs.activeTab?.fileHash}
                isFocused={focusedViewer === "primary"}
                autoFitToWidth
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
              onMouseDown={() => setFocusedViewer("secondary")}
            >
              <PdfViewer
                key={splitView.secondaryTabId ?? "no-secondary"}
                ref={secondaryPdfViewerRef}
                tabId={splitView.secondaryTabId ?? undefined}
                filePath={secondaryTab?.filePath ?? ""}
                fileHash={secondaryTab?.fileHash}
                isFocused={focusedViewer === "secondary"}
                autoFitToWidth
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
                    stashes={persistence.visibleTabStashes}
                    sessions={persistence.visibleTabSessions}
                    expandedSessionId={persistence.findSessionIdByAnnotationId(
                      tabs.activeTab?.highlightedAnnotationId ?? ""
                    )}
                    onRemoveStash={persistence.handleRemoveStash}
                    onUpdateStash={persistence.handleUpdateStash}
                    onClearStashes={persistence.handleClearStashes}
                    onCustomInterpret={(prompt, selectedStashes) =>
                      persistence.handleCustomInterpret(prompt, selectedStashes)
                    }
                    onGotoStash={handleGotoStash}
                    onGotoSession={handleGotoSession}
                    onFollowUp={persistence.handleFollowUp}
                    onInterrupt={persistence.handleInterruptSession}
                    onToggleVisibility={layout.toggleRight}
                    contextWindow={contextWindow}
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
                  stashes={persistence.visibleTabStashes}
                  sessions={persistence.visibleTabSessions}
                  expandedSessionId={persistence.findSessionIdByAnnotationId(
                    tabs.activeTab?.highlightedAnnotationId ?? ""
                  )}
                  onRemoveStash={persistence.handleRemoveStash}
                  onUpdateStash={persistence.handleUpdateStash}
                  onClearStashes={persistence.handleClearStashes}
                  onCustomInterpret={(prompt, selectedStashes) =>
                    persistence.handleCustomInterpret(prompt, selectedStashes)
                  }
                  onGotoStash={handleGotoStash}
                  onGotoSession={handleGotoSession}
                  onFollowUp={persistence.handleFollowUp}
                  onInterrupt={persistence.handleInterruptSession}
                  onToggleVisibility={layout.toggleRight}
                  contextWindow={contextWindow}
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
                  stashes={persistence.visibleTabStashes}
                  sessions={persistence.visibleTabSessions}
                  expandedSessionId={persistence.findSessionIdByAnnotationId(
                    tabs.activeTab?.highlightedAnnotationId ?? ""
                  )}
                  onRemoveStash={persistence.handleRemoveStash}
                  onUpdateStash={persistence.handleUpdateStash}
                  onClearStashes={persistence.handleClearStashes}
                  onCustomInterpret={(prompt, selectedStashes) =>
                    persistence.handleCustomInterpret(prompt, selectedStashes)
                  }
                  onGotoStash={handleGotoStash}
                  onGotoSession={handleGotoSession}
                  onFollowUp={persistence.handleFollowUp}
                  onInterrupt={persistence.handleInterruptSession}
                  onToggleVisibility={layout.toggleRight}
                  contextWindow={contextWindow}
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
          onRunWizard={handleRunWizard}
        />
      )}
      {wizardOpen && (
        <SetupWizard
          open={wizardOpen}
          initialSettings={settings}
          onComplete={handleWizardComplete}
          onSkip={handleWizardSkip}
        />
      )}
      <SelectionToolbar
        selection={focusedSelection}
        onAction={handleSelectionAction}
        onAddToStash={handleAddToStash}
        onCopy={handleCopy}
        onAddComment={handleAddComment}
        onDismiss={() => {
          if (focusedTab) {
            tabs.clearTabSelection(focusedTab.id);
          }
        }}
      />
    </div>
  );
}

export default App;
