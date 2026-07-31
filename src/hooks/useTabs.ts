import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { error as logError, info } from "../services/logs";
import { PdfViewerState } from "../components/PdfViewer";
import { SelectionState } from "../services/selection";
import {
  authorizePdfPath,
  getPdfFileSize,
  getPdfHash,
} from "../services/annotations";
import { BudgetTab, selectHibernateCandidates } from "../services/memoryBudget";
import { getBasename } from "../utils/path";

/**
 * 极端兜底硬上限：防脚本/误触无限开 tab 把 tab 栏和状态数组打爆。
 * 正常打开数量由内存预算（memoryBudget）调度休眠，不再设固定个数上限
 * （docs/TAB_HIBERNATION_DESIGN.md §7.6）。
 */
const HARD_TAB_LIMIT = 100;

const EMPTY_STREAMING_SET: ReadonlySet<string> = new Set();

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
  /** 休眠标记：viewer 已卸载、字节缓存已释放，仅保留状态记录（唤醒走冷启动恢复）。 */
  hibernated?: boolean;
  /** 文件字节数（addTab 时经 get_pdf_file_size 取得），供内存预算记账。 */
  fileSize?: number;
  /** 最近一次激活时间戳，休眠调度的 LRU 依据。 */
  lastActivatedAt?: number;
}

/** 休眠决策所需的跨 hook 上下文（secondary 在 useSplitView、流式会话在 usePersistence）。 */
export interface HibernationContext {
  secondaryTabId: string | null;
  streamingTabIds: ReadonlySet<string>;
}

export interface UseTabsOptions {
  /** App 用 ref 回填，避免 useTabs → usePersistence 的循环依赖。 */
  getHibernationContext?: () => HibernationContext;
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
  /** 唤醒休眠 tab 但不激活（分屏进入时副屏为目标 tab 的场景）。 */
  wakeTab: (tabId: string) => void;
  handleViewerStateChange: (state: PdfViewerState, tabId?: string) => void;
  gotoTabPage: (
    tabId: string,
    page: number,
    options?: { activate?: boolean }
  ) => void;
  setTabSelection: (tabId: string, selection: SelectionState | null) => void;
  clearTabSelection: (tabId: string) => void;
  setTabHighlightedAnnotationId: (
    tabId: string,
    annotationId: string | null
  ) => void;
  clearTabPendingGotoPage: (tabId: string) => void;
}

interface WakePlan {
  /** 需要休眠的 tab（含 fileSize 供日志估算释放量）。 */
  toHibernate: PdfTab[];
}

/**
 * 计算「唤醒 tabId」的休眠计划：唤醒同样挤占预算，复用同一套 LRU 候选
 * 选择，把被唤醒 tab 按 protectAs 保护起来（docs/TAB_HIBERNATION_DESIGN.md §6.1）。
 */
function planWake(
  tabs: readonly PdfTab[],
  tabId: string,
  protectAs: "active" | "secondary",
  ctx: HibernationContext,
  now: number
): WakePlan {
  const target = tabs.find((t) => t.id === tabId);
  if (!target?.hibernated) return { toHibernate: [] };
  const woken: BudgetTab[] = tabs.map((t) =>
    t.id === tabId ? { ...t, hibernated: false } : t
  );
  const candidates = selectHibernateCandidates(woken, {
    activeTabId: protectAs === "active" ? tabId : null,
    secondaryTabId: protectAs === "secondary" ? tabId : ctx.secondaryTabId,
    streamingTabIds: ctx.streamingTabIds,
    now,
  });
  return {
    toHibernate: tabs.filter((t) => candidates.includes(t.id)),
  };
}

function logHibernations(toHibernate: readonly PdfTab[], reason: string) {
  for (const tab of toHibernate) {
    info(
      `tabHibernated: tabId=${tab.id} reason=${reason} freedBytes≈${
        (tab.fileSize ?? 0) * 2
      }`
    );
  }
}

export function useTabs(options?: UseTabsOptions): UseTabsReturn {
  const [tabs, setTabs] = useState<PdfTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // In-flight open requests by path. Prevents duplicate tabs when the same PDF
  // is opened concurrently (e.g. rapid double-clicks or multiple listeners).
  const pendingOpens = useRef<Map<string, Promise<PdfTab | null>>>(new Map());

  // tabs 的最新镜像：activateTab / gotoTabPage 等长驻回调（deps 不含 tabs）
  // 做休眠决策时从这里读取，避免闭包捕获过期状态。事件处理器总在 effect
  // 刷新之后执行，镜像足够新；同批次刚新增的 tab 受 5 分钟窗口保护，不影响决策。
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const getHibernationContextRef = useRef(options?.getHibernationContext);
  useEffect(() => {
    getHibernationContextRef.current = options?.getHibernationContext;
  }, [options?.getHibernationContext]);

  const getHibernationCtx = (): HibernationContext =>
    getHibernationContextRef.current?.() ?? {
      secondaryTabId: null,
      streamingTabIds: EMPTY_STREAMING_SET,
    };

  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null;

  const activateTab = useCallback((tabId: string | null) => {
    setActiveTabId(tabId);
    if (tabId) {
      const now = Date.now();
      // 唤醒休眠 tab：hibernated 复位与 pendingGotoPage 必须在同一次
      // setTabs 里完成，保证挂载时 initialState 已就绪。
      const { toHibernate } = planWake(
        tabsRef.current,
        tabId,
        "active",
        getHibernationCtx(),
        now
      );
      logHibernations(toHibernate, "budget");
      const hibernateIds = new Set(toHibernate.map((t) => t.id));
      // Always set pendingGotoPage when activating a tab so the viewer knows it
      // should restore position. If no page has been saved yet, default to 1.
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.id === tabId) {
            return {
              ...tab,
              pendingGotoPage: tab.pageNum ?? 1,
              hibernated: false,
              lastActivatedAt: now,
            };
          }
          if (hibernateIds.has(tab.id)) {
            // 休眠时清空残留选区（§7.5）
            return { ...tab, hibernated: true, selection: null };
          }
          return tab;
        })
      );
    }
  }, []);

  const wakeTab = useCallback((tabId: string) => {
    const now = Date.now();
    const { toHibernate } = planWake(
      tabsRef.current,
      tabId,
      "secondary",
      getHibernationCtx(),
      now
    );
    if (toHibernate.length === 0) {
      // 目标未休眠则无需任何状态变更；已休眠但无候选时只需复位自身。
      const target = tabsRef.current.find((t) => t.id === tabId);
      if (!target?.hibernated) return;
    }
    logHibernations(toHibernate, "budget");
    const hibernateIds = new Set(toHibernate.map((t) => t.id));
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id === tabId) {
          return {
            ...tab,
            pendingGotoPage: tab.pageNum ?? 1,
            hibernated: false,
            lastActivatedAt: now,
          };
        }
        if (hibernateIds.has(tab.id)) {
          return { ...tab, hibernated: true, selection: null };
        }
        return tab;
      })
    );
  }, []);

  const addTab = useCallback(
    async (path: string, initialPage?: number): Promise<PdfTab | null> => {
      const inFlight = pendingOpens.current.get(path);
      if (inFlight) {
        return inFlight;
      }

      const promise = (async (): Promise<PdfTab | null> => {
        try {
          if (tabs.length >= HARD_TAB_LIMIT) {
            // 纯防御性硬上限，正常使用中预算调度会先触发休眠，到不了这里。
            logError(
              `Tab hard limit (${HARD_TAB_LIMIT}) reached, refusing to open: ${path}`
            );
            return null;
          }

          // Authorize the path before reading it. The backend maintains a whitelist
          // of paths selected by the user to prevent arbitrary file access.
          await authorizePdfPath(path);

          // 文件大小在加载字节前经 fs metadata 取得，供预算确定性记账。
          const [fileHash, fileSize] = await Promise.all([
            getPdfHash(path),
            getPdfFileSize(path),
          ]);
          const existing = tabs.find(
            (tab) => tab.fileHash === fileHash || tab.filePath === path
          );
          if (existing) {
            activateTab(existing.id);
            return existing;
          }

          const now = Date.now();
          // 唯一的休眠触发点：打开前预测，超限则休眠最久未用的隐藏 tab。
          const ctx = getHibernationCtx();
          const candidates = selectHibernateCandidates(
            tabs,
            {
              activeTabId,
              secondaryTabId: ctx.secondaryTabId,
              streamingTabIds: ctx.streamingTabIds,
              now,
            },
            { filePath: path, fileSize }
          );
          const toHibernate = tabs.filter((t) => candidates.includes(t.id));
          logHibernations(toHibernate, "budget");
          const hibernateIds = new Set(candidates);

          const newTab: PdfTab = {
            id: crypto.randomUUID(),
            filePath: path,
            fileName: getBasename(path),
            fileHash,
            fileSize,
            lastActivatedAt: now,
            // 从最近文件入口打开时带上上次读到的页码，activateTab 会把它
            // 转成 pendingGotoPage，viewer 挂载后自动恢复到该页。
            ...(initialPage && initialPage > 0
              ? { pageNum: Math.floor(initialPage) }
              : {}),
          };

          setTabs((prev) => [
            ...prev.map((tab) =>
              hibernateIds.has(tab.id)
                ? { ...tab, hibernated: true, selection: null }
                : tab
            ),
            newTab,
          ]);
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
    [tabs, activeTabId, activateTab]
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
        // 顶替激活的 tab 可能是休眠状态：唤醒（必要时按预算休眠他人）。
        const now = Date.now();
        let hibernateIds = new Set<string>();
        if (nextActive?.hibernated) {
          const { toHibernate } = planWake(
            nextTabs,
            nextActive.id,
            "active",
            getHibernationCtx(),
            now
          );
          logHibernations(toHibernate, "budget");
          hibernateIds = new Set(toHibernate.map((t) => t.id));
        }
        // Set pendingGotoPage atomically with the tab removal so the next
        // active tab restores its previous page when its viewer mounts.
        setTabs(
          nextTabs.map((tab) => {
            if (tab.id === nextActive?.id) {
              return {
                ...tab,
                pendingGotoPage: tab.pageNum,
                hibernated: false,
                lastActivatedAt: now,
              };
            }
            if (hibernateIds.has(tab.id)) {
              return { ...tab, hibernated: true, selection: null };
            }
            return tab;
          })
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

  const gotoTabPage = useCallback(
    (tabId: string, page: number, options?: { activate?: boolean }) => {
      const activate = options?.activate !== false;
      // 防御：调用方可能传入持久化数据里的旧 tabId（如已落盘会话的
      // sources），目标 tab 不存在时绝不能动 activeTabId——否则 keep-alive
      // 树里所有 viewer 都因 isActive=false 被隐藏，阅读区整体消失。
      if (!tabsRef.current.some((t) => t.id === tabId)) return;
      // activate=false 用于分屏下跳转到副屏 tab：只跳页不激活，
      // 否则副屏会被提升为 active，导致两个面板渲染同一 PDF（塌缩）。
      if (activate) {
        setActiveTabId(tabId);
      }
      const now = Date.now();
      // 目标可能处于休眠（如从解读记录跳转）：唤醒后才能看到内容。
      const { toHibernate } = planWake(
        tabsRef.current,
        tabId,
        activate ? "active" : "secondary",
        getHibernationCtx(),
        now
      );
      logHibernations(toHibernate, "budget");
      const hibernateIds = new Set(toHibernate.map((t) => t.id));
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.id === tabId) {
            // Clear scrollTop: this is intentional navigation to a page, and a
            // stale saved offset would otherwise be re-applied after the jump
            // by the mount-restore path, snapping the viewer back to the tab's
            // previous reading spot (docs/REFACTOR_REVIEW_2026-07-17.md #4b).
            return {
              ...tab,
              pageNum: page,
              pendingGotoPage: page,
              scrollTop: undefined,
              hibernated: false,
              ...(activate ? { lastActivatedAt: now } : {}),
            };
          }
          if (hibernateIds.has(tab.id)) {
            return { ...tab, hibernated: true, selection: null };
          }
          return tab;
        })
      );
    },
    []
  );

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

  // 返回对象用 useMemo 固定引用：否则 App 每次渲染都拿到新对象，
  // 依赖它的 useCallback 会跟着重建，一路击穿 PdfPage 的 React.memo。
  return useMemo(
    () => ({
      tabs,
      activeTabId,
      activeTab,
      handleOpenPdf,
      openPdfByPath,
      handleCloseTab,
      handleTabClick,
      wakeTab,
      handleViewerStateChange,
      gotoTabPage,
      setTabSelection,
      clearTabSelection,
      setTabHighlightedAnnotationId,
      clearTabPendingGotoPage,
    }),
    [
      tabs,
      activeTabId,
      activeTab,
      handleOpenPdf,
      openPdfByPath,
      handleCloseTab,
      handleTabClick,
      wakeTab,
      handleViewerStateChange,
      gotoTabPage,
      setTabSelection,
      clearTabSelection,
      setTabHighlightedAnnotationId,
      clearTabPendingGotoPage,
    ]
  );
}
