import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import PdfViewer, {
  PdfViewerHandle,
  PdfViewerState,
} from "./components/PdfViewer";
import { HibernatedPlaceholder } from "./components/HibernatedPlaceholder";
import SelectionToolbar from "./components/SelectionToolbar";
import AiChatPanel from "./components/AiChatPanel";
import CustomInterpretModal from "./components/CustomInterpretModal";
import SettingsModal from "./components/SettingsModal";
import ShortcutsModal from "./components/ShortcutsModal";
import SetupWizard from "./components/SetupWizard";
import Icon from "./components/Icon";
import { StashItem } from "./services/stash";
import { InterpretationSession, SessionSortMode } from "./services/sessions";
import { SelectionAction } from "./services/llm";
import { useTabs, type HibernationContext } from "./hooks/useTabs";
import { usePersistence } from "./hooks/usePersistence";
import {
  useRightPanelLayout,
  DIVIDER_WIDTH,
  type RightPanelLayout,
} from "./hooks/useRightPanelLayout";
import { useRecentFiles, type RecentFile } from "./hooks/useRecentFiles";
import { useSplitView } from "./hooks/useSplitView";
import { useFileDrop } from "./hooks/useFileDrop";
import TitleBar from "./components/TitleBar";
import TitleBarToggles from "./components/TitleBarToggles";
import {
  AppSettings,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  checkApiKey,
} from "./services/settings";
import {
  getContextWindow,
  PLATFORM_LIST,
  PLATFORM_PRESETS,
} from "./data/platformPresets";
import { copyToClipboard } from "./utils/clipboard";
import { getBasename } from "./utils/path";
import { showMessage } from "./services/dialog";
import { useDictionaryStatus } from "./hooks/useDictionaryStatus";
import { checkForUpdate } from "./services/updater";
import { error } from "./services/logs";
import { syncOpenPdfs } from "./services/pdfToolsRegistry";
import "./App.css";

const RIGHT_PANEL_SPLIT_FRACTION = 0.2;
const RIGHT_PANEL_SPLIT_MIN_WIDTH = 200;
/** 并排对照轻引导「已看过」标记的 localStorage 键。 */
const SPLIT_COACHMARK_KEY = "specreader-split-coachmark-seen";

function App() {
  const { t } = useTranslation();
  // 休眠决策所需的跨 hook 上下文（secondary 在 useSplitView、流式会话在
  // usePersistence，均晚于 useTabs 实例化）：ref 回填 + 稳定 getter 打破循环依赖。
  const hibernationCtxRef = useRef<HibernationContext>({
    secondaryTabId: null,
    streamingTabIds: new Set(),
  });
  const getHibernationContext = useCallback(
    () => hibernationCtxRef.current,
    []
  );
  // PDF bytes cache keyed by filePath. Reused across tab switches so large
  // files do not have to be read from disk every time the user changes tabs.
  // Each PdfViewer keeps its own PDFDocumentProxy instance to avoid sharing
  // internal PDF.js transport state between component lifecycles.
  // 声明在 useTabs 之前：addTab 打开链路单遍读取的字节直接写入这里，
  // viewer 挂载后不再二次读盘。
  const pdfCacheRef = useRef<Map<string, Uint8Array>>(new Map());
  const cachePdfBytes = useCallback((filePath: string, bytes: Uint8Array) => {
    // 与 handlePdfLoaded 一致：已存在则不覆盖（viewer 可能正在使用）。
    if (!pdfCacheRef.current.has(filePath)) {
      pdfCacheRef.current.set(filePath, bytes);
    }
  }, []);
  const tabs = useTabs({ getHibernationContext, cachePdfBytes });
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  const handleLayoutChange = useCallback(
    (layout: RightPanelLayout) => {
      if (!settingsLoaded) return;
      setSettings((prev) => {
        if (
          prev.rightPanelVisible === layout.visible &&
          prev.rightPanelWidth === layout.width
        ) {
          return prev;
        }
        const next: AppSettings = {
          ...prev,
          rightPanelVisible: layout.visible,
          rightPanelWidth: layout.width,
        };
        saveSettings(next).catch((err) =>
          error(`[App] 保存右侧面板布局失败: ${err}`)
        );
        return next;
      });
    },
    [settingsLoaded]
  );

  const layout = useRightPanelLayout(
    {
      visible: settings.rightPanelVisible,
      width: settings.rightPanelWidth,
    },
    handleLayoutChange
  );
  const recentFiles = useRecentFiles();
  const splitView = useSplitView();
  // 系统文件拖放：把 PDF 拖进窗口即打开（hook 内部用 ref 稳定回调，listener 只注册一次）。
  const { isFileDragOver } = useFileDrop({
    openPdfByPath: tabs.openPdfByPath,
    addRecentFile: recentFiles.addRecentFile,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const dictionaryStatus = useDictionaryStatus();

  // Ctrl/Cmd+/ 开合快捷键速查浮层（Esc 关闭由 ShortcutsModal 的 useModal 处理）。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "/") {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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

  // 休眠释放字节缓存：某 filePath 没有任何存活（非休眠）tab 引用时，
  // 从 pdfCacheRef 删除（同一路径多 tab 共享一份，仍有存活引用则保留）。
  // 唤醒时由 usePdfDocument 回退 read_pdf_bytes 读盘后重新填入。
  useEffect(() => {
    const alivePaths = new Set(
      tabs.tabs.filter((t) => !t.hibernated).map((t) => t.filePath)
    );
    for (const path of Array.from(pdfCacheRef.current.keys())) {
      if (!alivePaths.has(path)) {
        pdfCacheRef.current.delete(path);
      }
    }
  }, [tabs.tabs]);

  // 休眠时顺手回写阅读页码到最近文件（与关闭 tab 时一致），
  // 休眠 tab 即使意外丢失也能从最近文件恢复页码。
  const prevTabsForHibernateRef = useRef(tabs.tabs);
  useEffect(() => {
    const prev = prevTabsForHibernateRef.current;
    for (const tab of tabs.tabs) {
      const wasAlive = prev.some((t) => t.id === tab.id && !t.hibernated);
      if (tab.hibernated && wasAlive && tab.pageNum) {
        recentFiles.updateLastPage(tab.filePath, tab.pageNum);
      }
    }
    prevTabsForHibernateRef.current = tabs.tabs;
  }, [tabs.tabs, recentFiles]);

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

  // 主题：把 settings.theme 应用到 <html data-theme>；为 "system" 时跟随
  // 操作系统亮暗并监听切换。dark token 组见 App.css :root[data-theme="dark"]。
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark =
        settings.theme === "dark" ||
        (settings.theme === "system" && media.matches);
      root.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    if (settings.theme === "system") {
      media.addEventListener("change", apply);
      return () => media.removeEventListener("change", apply);
    }
  }, [settings.theme]);

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

  // 当前平台的 API Key 是否已配置（钥匙串），决定标题栏
  // 智能查阅开关与平台/模型显示的可见性。
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);

  const refreshApiKeyConfigured = useCallback((platformId: string) => {
    checkApiKey(platformId)
      .then(setApiKeyConfigured)
      .catch(() => setApiKeyConfigured(false));
  }, []);

  useEffect(() => {
    if (!settingsLoaded) return;
    refreshApiKeyConfigured(settings.platformId);
  }, [settingsLoaded, settings.platformId, refreshApiKeyConfigured]);

  // 标题栏「平台 · 模型」纯展示文本：平台名去掉括号补充说明保持紧凑，
  // 模型用 id（label 含说明文字，过长）。仅已配置 Key 时显示。
  const modelDisplay = useMemo(() => {
    if (!settingsLoaded || !apiKeyConfigured) return null;
    const preset = PLATFORM_PRESETS[settings.platformId];
    const platformLabel = (preset?.label ?? settings.platformId).split("（")[0];
    const model = settings.llm.model;
    return model ? `${platformLabel} · ${model}` : platformLabel;
  }, [
    settingsLoaded,
    apiKeyConfigured,
    settings.platformId,
    settings.llm.model,
  ]);

  // 标题栏快捷开关：切换后立即持久化，失败仅记日志（与右侧面板布局同一策略）。
  const handleToggleHoverTranslate = useCallback(() => {
    setSettings((prev) => {
      const next = { ...prev, hoverTranslate: !prev.hoverTranslate };
      saveSettings(next).catch((err) =>
        error(`[App] 保存悬停查词开关失败: ${err}`)
      );
      return next;
    });
  }, []);

  const handleToggleAgentTools = useCallback(() => {
    setSettings((prev) => {
      const next = { ...prev, agentToolsEnabled: !prev.agentToolsEnabled };
      saveSettings(next).catch((err) =>
        error(`[App] 保存智能查阅开关失败: ${err}`)
      );
      return next;
    });
  }, []);

  // 解读记录排序方式：切换后立即持久化（与快捷开关同一策略）
  const handleSessionSortModeChange = useCallback((mode: SessionSortMode) => {
    setSettings((prev) => {
      const next = { ...prev, sessionSortMode: mode };
      saveSettings(next).catch((err) =>
        error(`[App] 保存解读记录排序方式失败: ${err}`)
      );
      return next;
    });
  }, []);

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
    handleCustomInterpret: persistenceHandleCustomInterpret,
    handleAddComment: persistenceHandleAddComment,
    abortSessionsForTab: persistenceAbortSessionsForTab,
    setStashes: persistenceSetStashes,
  } = persistence;

  // 回填休眠决策上下文：有进行中流式会话的 tab 不做休眠候选（§7.3），
  // 分屏 secondary 可见即存活（§7.1）。
  useEffect(() => {
    const streamingTabIds = new Set<string>();
    for (const session of persistence.sessions) {
      if (!session.isStreaming) continue;
      for (const stash of session.sources) {
        streamingTabIds.add(stash.source.tabId);
      }
    }
    hibernationCtxRef.current = {
      secondaryTabId: splitView.secondaryTabId,
      streamingTabIds,
    };
  }, [persistence.sessions, splitView.secondaryTabId]);
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

  // tab → 分屏的鼠标拖拽实现。系统文件拖放（dragDropEnabled）开启后，
  // WebView2 会接管页面内所有 HTML5 拖放事件，原 HTML5 DnD（draggable +
  // dataTransfer）失效，故改为 mousedown + 阈值 + 全局 mousemove/mouseup
  // 监听的模式（与 useDrag.ts 同一思路；useDrag 只回传增量位移，这里需要
  // 绝对坐标做命中检测，所以在本组件内做局部实现）。
  const [isDragOver, setIsDragOver] = useState(false);
  const tabDragRef = useRef<{
    tabId: string;
    startX: number;
    startY: number;
    started: boolean;
  } | null>(null);

  const isPointInMainArea = useCallback(
    (x: number, y: number) => {
      const el = layout.mainRef.current;
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return (
        x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      );
    },
    [layout.mainRef]
  );

  const handleTabDragMouseMove = useCallback(
    (e: MouseEvent) => {
      const drag = tabDragRef.current;
      if (!drag) return;
      if (!drag.started) {
        // 阈值内视为单击准备阶段，不进入拖拽态（保住 onClick 激活 tab）
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) {
          return;
        }
        drag.started = true;
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
      }
      setIsDragOver(isPointInMainArea(e.clientX, e.clientY));
    },
    [isPointInMainArea]
  );

  const handleTabDragMouseUp = useCallback(
    (e: MouseEvent) => {
      window.removeEventListener("mousemove", handleTabDragMouseMove);
      window.removeEventListener("mouseup", handleTabDragMouseUp);
      const drag = tabDragRef.current;
      if (!drag) return;
      tabDragRef.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setIsDragOver(false);
      // 未过阈值 = 单击，交由 tab 的 onClick 处理；释放在阅读区外 = 取消拖拽
      if (!drag.started) return;
      const droppedTabId = drag.tabId;
      if (!isPointInMainArea(e.clientX, e.clientY)) return;
      if (droppedTabId === tabs.activeTabId) return;
      if (!tabs.tabs.some((t) => t.id === droppedTabId)) return;
      // 目标 tab 可能处于休眠：先唤醒（不激活），viewer 重新挂载走冷启动恢复
      tabs.wakeTab(droppedTabId);
      splitView.enterSplitView(droppedTabId);
    },
    [handleTabDragMouseMove, isPointInMainArea, tabs, splitView]
  );

  const handleTabDragMouseDown = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      // 仅左键启动拖拽（不影响中键等其它按键语义）；激活 tab 不可拖拽，
      // 与原 HTML5 实现（仅非激活 tab 带 draggable）保持一致。
      if (e.button !== 0) return;
      if (tabId === tabs.activeTabId) return;
      // 关闭按钮自身处理点击，不从它启动拖拽
      if ((e.target as HTMLElement).closest(".tab-close")) return;
      tabDragRef.current = {
        tabId,
        startX: e.clientX,
        startY: e.clientY,
        started: false,
      };
      window.addEventListener("mousemove", handleTabDragMouseMove);
      window.addEventListener("mouseup", handleTabDragMouseUp);
    },
    [tabs.activeTabId, handleTabDragMouseMove, handleTabDragMouseUp]
  );

  // 组件卸载时兜底清理全局监听（拖拽中途 unmount 的防御）
  useEffect(() => {
    return () => {
      window.removeEventListener("mousemove", handleTabDragMouseMove);
      window.removeEventListener("mouseup", handleTabDragMouseUp);
    };
  }, [handleTabDragMouseMove, handleTabDragMouseUp]);

  // tab 栏「并排对照」入口：取下一个非激活 tab 作为副屏。
  const handleEnterSplit = useCallback(() => {
    const activeIndex = tabs.tabs.findIndex((t) => t.id === tabs.activeTabId);
    const nextTab = tabs.tabs[(activeIndex + 1) % tabs.tabs.length];
    if (!nextTab || nextTab.id === tabs.activeTabId) return;
    tabs.wakeTab(nextTab.id);
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

  // tab 栏溢出时，激活（打开/切换）的 tab 可能滚出可视区；激活变化后把它滚回可见。
  // scrollIntoView 默认只影响最近的可滚动祖先，inline:"nearest" 保证已在视口内时不动。
  useEffect(() => {
    const el = tabBarRef.current;
    if (!el || !tabs.activeTabId) return;
    const active = el.querySelector(".tab-item.active");
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tabs.activeTabId]);

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

  const handleSaveSettings = useCallback(
    async (newSettings: AppSettings) => {
      try {
        await saveSettings(newSettings);
        setSettings(newSettings);
        setSettingsOpen(false);
        // 设置页可能刚写入或删除了 Key，刷新标题栏可见性
        refreshApiKeyConfigured(newSettings.platformId);
      } catch (err) {
        error(`[App] 保存设置失败: ${err}`);
        throw err;
      }
    },
    [refreshApiKeyConfigured]
  );

  // 配置向导完成：保存并应用最终设置，关闭向导。
  const handleWizardComplete = useCallback(
    (finalSettings: AppSettings) => {
      setSettings(finalSettings);
      setWizardOpen(false);
      refreshApiKeyConfigured(finalSettings.platformId);
    },
    [refreshApiKeyConfigured]
  );

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

  // Ctrl/Cmd+O 打开 PDF（与浏览器习惯一致）；带 Shift 时是最近文件面板的
  // Ctrl/Cmd+Shift+O（RecentFilesBar 自行处理），这里要排除。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === "o"
      ) {
        e.preventDefault();
        void handleOpenPdf();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleOpenPdf]);

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
      tabs.wakeTab(tab.id);
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

  // PDF 侧动作驱动 AI 面板 tab 激活：加入暂存 → 暂存 tab，发起解读 → 解读 tab。
  // nonce 自增触发 AiChatPanel 内的切换 effect。
  const [panelTabRequest, setPanelTabRequest] = useState<{
    tab: "stash" | "sessions";
    nonce: number;
  }>({ tab: "stash", nonce: 0 });
  const requestPanelTab = useCallback((tab: "stash" | "sessions") => {
    setPanelTabRequest((prev) => ({ tab, nonce: prev.nonce + 1 }));
  }, []);

  const handleAddToStash = useCallback(
    (text: string) => {
      if (!focusedSelection || !focusedTab) return;
      persistenceHandleAddToStash(focusedSelection, text);
      tabs.clearTabSelection(focusedTab.id);
      requestPanelTab("stash");
    },
    [
      focusedSelection,
      focusedTab,
      persistenceHandleAddToStash,
      tabs,
      requestPanelTab,
    ]
  );

  // 自定义解读弹窗由 App 层统一渲染（选区工具条直达与面板按钮两个入口共用），
  // 候选片段为当前可见 tab 的暂存；preselected 记录面板选择模式的勾选。
  const [customInterpretOpen, setCustomInterpretOpen] = useState(false);
  const [customInterpretPreselected, setCustomInterpretPreselected] =
    useState<Set<string> | null>(null);

  const handleOpenCustomInterpret = useCallback(
    (preselectedIds: Set<string> | null) => {
      setCustomInterpretPreselected(preselectedIds);
      setCustomInterpretOpen(true);
    },
    []
  );

  // 选区工具条「自定义解读」直达：暂存当前选区并立即打开解读要求弹窗，
  // 弹窗清单含全部暂存片段（含刚加入的这条），默认全选。
  const handleCustomInterpretFromSelection = useCallback(
    (text: string) => {
      if (!focusedSelection || !focusedTab) return;
      persistenceHandleAddToStash(focusedSelection, text);
      tabs.clearTabSelection(focusedTab.id);
      setCustomInterpretPreselected(null);
      setCustomInterpretOpen(true);
    },
    [focusedSelection, focusedTab, persistenceHandleAddToStash, tabs]
  );

  const handleSelectionAction = useCallback(
    (action: SelectionAction, text: string) => {
      if (!focusedSelection || !focusedTab) return;
      persistenceHandleSelectionAction(focusedSelection, action, text);
      tabs.clearTabSelection(focusedTab.id);
      if (action === "explain") requestPanelTab("sessions");
    },
    [
      focusedSelection,
      focusedTab,
      persistenceHandleSelectionAction,
      tabs,
      requestPanelTab,
    ]
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
      // source.tabId 可能是持久化会话里的旧 id（tab 重开/应用重启后失效），
      // 与 handleGotoSession 对齐：先按 id 匹配、再按 fileHash 兜底解析到
      // 当前打开的 tab；文件未打开时不做任何跳转。
      const targetTab =
        tabs.tabs.find((t) => t.id === stash.source.tabId) ??
        tabs.tabs.find(
          (t) => t.fileHash && t.fileHash === stash.source.fileHash
        );
      if (!targetTab) return;

      // 分屏下跳转到副屏 tab 用不激活版本，避免副屏被提升为 active
      // 导致两个面板渲染同一 PDF（塌缩）。
      if (splitView.isSplitView && targetTab.id === splitView.secondaryTabId) {
        tabs.gotoTabPage(targetTab.id, stash.source.page, {
          activate: false,
        });
        setFocusedViewer("secondary");
        return;
      }
      tabs.gotoTabPage(targetTab.id, stash.source.page);
      if (splitView.isSplitView && targetTab.id === tabs.activeTabId) {
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

      // 当前页码已经是目标页码时，不再重复滚动，避免轻微的位置偏差也触发跳转。
      // 分屏下仍把焦点切到对应屏，方便后续操作跟随来源文档。
      if (targetTab.pageNum === source.page) {
        if (
          splitView.isSplitView &&
          targetTab.id === splitView.secondaryTabId
        ) {
          setFocusedViewer("secondary");
        } else if (splitView.isSplitView && targetTab.id === tabs.activeTabId) {
          setFocusedViewer("primary");
        }
        return;
      }

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

  // 并排对照首次轻引导：第一次同时打开 ≥2 个 PDF 时显示一次，
  // 点「知道了」或超时后写入 localStorage，之后不再打扰。
  const [splitCoachmarkVisible, setSplitCoachmarkVisible] = useState(false);

  const dismissSplitCoachmark = useCallback(() => {
    setSplitCoachmarkVisible(false);
    try {
      localStorage.setItem(SPLIT_COACHMARK_KEY, "1");
    } catch {
      // ignore：无法持久化时下次会再提示一次，可接受。
    }
  }, []);

  useEffect(() => {
    if (splitCoachmarkVisible) return;
    if (tabs.tabs.length < 2 || splitView.isSplitView) return;
    try {
      if (localStorage.getItem(SPLIT_COACHMARK_KEY)) return;
    } catch {
      return;
    }
    setSplitCoachmarkVisible(true);
  }, [tabs.tabs.length, splitView.isSplitView, splitCoachmarkVisible]);

  useEffect(() => {
    if (!splitCoachmarkVisible) return;
    const timer = setTimeout(dismissSplitCoachmark, 12000);
    return () => clearTimeout(timer);
  }, [splitCoachmarkVisible, dismissSplitCoachmark]);

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
        onOpenShortcuts={() => setShortcutsOpen(true)}
        quickToggles={
          <TitleBarToggles
            showHoverTranslate={dictionaryStatus.status?.exists === true}
            hoverTranslateEnabled={settings.hoverTranslate}
            onToggleHoverTranslate={handleToggleHoverTranslate}
            showAgentTools={settingsLoaded && apiKeyConfigured}
            agentToolsEnabled={settings.agentToolsEnabled}
            onToggleAgentTools={handleToggleAgentTools}
            modelDisplay={modelDisplay}
          />
        }
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
              onMouseDown={(e) => handleTabDragMouseDown(e, tab.id)}
              title={
                tab.id !== tabs.activeTabId
                  ? `${tab.fileName}\n${t("tab.dragToSplit")}`
                  : tab.fileName
              }
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

      {splitCoachmarkVisible &&
        !splitView.isSplitView &&
        tabs.tabs.length >= 2 && (
          <div className="split-coachmark" role="status">
            <span>{t("app.splitCoachmark")}</span>
            <button
              type="button"
              className="split-coachmark-close"
              onClick={dismissSplitCoachmark}
            >
              {t("common.gotIt")}
            </button>
          </div>
        )}

      <main className="app-main" ref={layout.mainRef}>
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
                sessions={persistence.sessions}
                highlightedAnnotationId={
                  tabs.activeTab?.highlightedAnnotationId
                }
                onAnnotationUpdate={persistence.handleAnnotationUpdate}
                onAnnotationDelete={persistence.handleAnnotationDelete}
                onExplainClick={handleExplainClick}
                onReinterpret={persistence.handleReinterpretSession}
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
                sessions={persistence.sessions}
                highlightedAnnotationId={secondaryTab?.highlightedAnnotationId}
                onAnnotationUpdate={persistence.handleAnnotationUpdate}
                onAnnotationDelete={persistence.handleAnnotationDelete}
                onExplainClick={handleExplainClick}
                onReinterpret={persistence.handleReinterpretSession}
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
                    allSessions={persistence.sessions}
                    expandedSessionId={persistence.findSessionIdByAnnotationId(
                      tabs.activeTab?.highlightedAnnotationId ?? ""
                    )}
                    onRemoveStash={persistence.handleRemoveStash}
                    onUpdateStash={persistence.handleUpdateStash}
                    onClearStashes={persistence.handleClearStashes}
                    onOpenCustomInterpret={handleOpenCustomInterpret}
                    onGotoStash={handleGotoStash}
                    onGotoSession={handleGotoSession}
                    onFollowUp={persistence.handleFollowUp}
                    onInterrupt={persistence.handleInterruptSession}
                    onDeleteSession={persistence.handleDeleteSession}
                    onToggleVisibility={layout.toggleRight}
                    contextWindow={contextWindow}
                    sessionSortMode={settings.sessionSortMode}
                    onSessionSortModeChange={handleSessionSortModeChange}
                    tabRequest={panelTabRequest}
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
            {tabs.tabs.length === 0 ? (
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
                  filePath=""
                  onPdfLoaded={handlePdfLoaded}
                  onSelection={handleSelection}
                  onToggleVisibility={layout.toggleLeft}
                  onStateChange={tabs.handleViewerStateChange}
                  onAnnotationUpdate={persistence.handleAnnotationUpdate}
                  onAnnotationDelete={persistence.handleAnnotationDelete}
                  onExplainClick={handleExplainClick}
                  onClearPendingGotoPage={tabs.clearTabPendingGotoPage}
                  hoverTranslate={hoverTranslateActive}
                  settings={settings}
                />
              </div>
            ) : (
              // keep-alive 保活：所有已打开 tab 的 viewer 常驻挂载，非激活的
              // 仅 display:none 隐藏。切 tab 不再重挂载 → canvas 位图、滚动
              // 位置、页码与工具栏状态全部保留，切换瞬时完成（此前每次切换
              // 都要重新 getDocument + 全量重渲染，界面闪"加载中"占位）。
              tabs.tabs.map((tab) => {
                const isActiveTab = tab.id === tabs.activeTabId;
                return (
                  <div
                    key={tab.id}
                    className={`pdf-panel ${showOnlyLeft ? "expanded" : ""} ${
                      isActiveTab ? "" : "viewer-hidden"
                    }`}
                    style={
                      showBoth
                        ? { width: `${layout.leftPct}%` }
                        : showOnlyLeft
                          ? { flex: 1 }
                          : undefined
                    }
                  >
                    {tab.hibernated ? (
                      // 休眠 tab：viewer 已卸载（pdfjs document / canvas 位图 /
                      // 全页 DOM 随 unmount 释放），占位仅保持 key 稳定。
                      // 唤醒 = activateTab 复位 hibernated → PdfViewer 重新挂载，
                      // 走现有冷启动恢复路径（useTabRestore）。
                      <HibernatedPlaceholder fileName={tab.fileName} />
                    ) : (
                      <PdfViewer
                        ref={isActiveTab ? pdfViewerRef : undefined}
                        tabId={tab.id}
                        filePath={tab.filePath}
                        fileHash={tab.fileHash}
                        isActive={isActiveTab}
                        cachedBytes={pdfCacheRef.current.get(tab.filePath)}
                        onPdfLoaded={handlePdfLoaded}
                        onSelection={handleSelection}
                        onToggleVisibility={
                          isActiveTab ? layout.toggleLeft : undefined
                        }
                        initialState={{
                          pageNum: tab.pageNum,
                          scale: tab.scale,
                          viewMode: tab.viewMode,
                          scrollTop: tab.scrollTop,
                          pendingGotoPage: tab.pendingGotoPage,
                        }}
                        onStateChange={tabs.handleViewerStateChange}
                        annotations={
                          persistence.annotationsByHash[tab.fileHash || ""]
                        }
                        highlightedAnnotationId={tab.highlightedAnnotationId}
                        sessions={persistence.sessions}
                        onAnnotationUpdate={persistence.handleAnnotationUpdate}
                        onAnnotationDelete={persistence.handleAnnotationDelete}
                        onExplainClick={handleExplainClick}
                        onReinterpret={persistence.handleReinterpretSession}
                        onClearPendingGotoPage={tabs.clearTabPendingGotoPage}
                        hoverTranslate={hoverTranslateActive}
                        settings={settings}
                      />
                    )}
                  </div>
                );
              })
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
                  stashes={persistence.visibleTabStashes}
                  sessions={persistence.visibleTabSessions}
                  allSessions={persistence.sessions}
                  expandedSessionId={persistence.findSessionIdByAnnotationId(
                    tabs.activeTab?.highlightedAnnotationId ?? ""
                  )}
                  onRemoveStash={persistence.handleRemoveStash}
                  onUpdateStash={persistence.handleUpdateStash}
                  onClearStashes={persistence.handleClearStashes}
                  onOpenCustomInterpret={handleOpenCustomInterpret}
                  onGotoStash={handleGotoStash}
                  onGotoSession={handleGotoSession}
                  onFollowUp={persistence.handleFollowUp}
                  onInterrupt={persistence.handleInterruptSession}
                  onDeleteSession={persistence.handleDeleteSession}
                  onToggleVisibility={layout.toggleRight}
                  contextWindow={contextWindow}
                  sessionSortMode={settings.sessionSortMode}
                  onSessionSortModeChange={handleSessionSortModeChange}
                  tabRequest={panelTabRequest}
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
                  allSessions={persistence.sessions}
                  expandedSessionId={persistence.findSessionIdByAnnotationId(
                    tabs.activeTab?.highlightedAnnotationId ?? ""
                  )}
                  onRemoveStash={persistence.handleRemoveStash}
                  onUpdateStash={persistence.handleUpdateStash}
                  onClearStashes={persistence.handleClearStashes}
                  onOpenCustomInterpret={handleOpenCustomInterpret}
                  onGotoStash={handleGotoStash}
                  onGotoSession={handleGotoSession}
                  onFollowUp={persistence.handleFollowUp}
                  onInterrupt={persistence.handleInterruptSession}
                  onDeleteSession={persistence.handleDeleteSession}
                  onToggleVisibility={layout.toggleRight}
                  contextWindow={contextWindow}
                  sessionSortMode={settings.sessionSortMode}
                  onSessionSortModeChange={handleSessionSortModeChange}
                  tabRequest={panelTabRequest}
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
        onCustomInterpret={handleCustomInterpretFromSelection}
        onCopy={handleCopy}
        onAddComment={handleAddComment}
        onDismiss={() => {
          if (focusedTab) {
            tabs.clearTabSelection(focusedTab.id);
          }
        }}
      />
      {customInterpretOpen && (
        <CustomInterpretModal
          stashes={persistence.visibleTabStashes}
          initialSelectedIds={customInterpretPreselected}
          onSubmit={(prompt, selected) => {
            persistenceHandleCustomInterpret(prompt, selected);
            setCustomInterpretOpen(false);
            setCustomInterpretPreselected(null);
            requestPanelTab("sessions");
          }}
          onClose={() => {
            setCustomInterpretOpen(false);
            setCustomInterpretPreselected(null);
          }}
        />
      )}
      {isFileDragOver && (
        <div className="file-drop-overlay">
          <span>{t("fileDrop.overlayHint")}</span>
        </div>
      )}
      {tabs.openingPaths.length > 0 && (
        <div className="pdf-opening-toast">
          {t("tab.openingPdf", {
            name: getBasename(tabs.openingPaths[tabs.openingPaths.length - 1]),
          })}
        </div>
      )}
      {shortcutsOpen && (
        <ShortcutsModal onClose={() => setShortcutsOpen(false)} />
      )}
    </div>
  );
}

export default App;
