import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import i18n from "i18next";
import { error as logError, info } from "../services/logs";
import { showMessage } from "../services/dialog";
import { PdfViewerState } from "../components/PdfViewer";
import { SelectionState } from "../services/selection";
import {
  authorizePdfPath,
  getPdfFileSize,
  getPdfHash,
  readPdfBytes,
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
  scrollTop?: number;
  selection?: SelectionState | null;
  highlightedAnnotationId?: string | null;
  pendingGotoPage?: number;
  pendingGotoPdfY?: number;
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
  /**
   * 把打开链路读到的字节写入 App 级缓存（pdfCacheRef），viewer 挂载后
   * 直接用缓存渲染，不再二次读盘。
   */
  cachePdfBytes?: (filePath: string, bytes: Uint8Array) => void;
}

export interface UseTabsReturn {
  tabs: PdfTab[];
  activeTabId: string | null;
  activeTab: PdfTab | null;
  /** 正在打开中的文件路径（addTab 在飞期间），供全局「正在打开」反馈。 */
  openingPaths: string[];
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
    options?: { activate?: boolean; pdfY?: number }
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
 * currentActiveTabId 是当前真实激活的 tab：protectAs 为 "secondary" 时目标
 * tab 占副屏槽位，真实 active tab 仍必须受保护（不能仅靠 5 分钟活动窗口
 * 兜底，否则主屏正在显示的 tab 可能被选中休眠）。
 */
function planWake(
  tabs: readonly PdfTab[],
  tabId: string,
  protectAs: "active" | "secondary",
  ctx: HibernationContext,
  currentActiveTabId: string | null,
  now: number
): WakePlan {
  const target = tabs.find((t) => t.id === tabId);
  if (!target?.hibernated) return { toHibernate: [] };
  const woken: BudgetTab[] = tabs.map((t) =>
    t.id === tabId ? { ...t, hibernated: false } : t
  );
  const candidates = selectHibernateCandidates(woken, {
    activeTabId: protectAs === "active" ? tabId : currentActiveTabId,
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
  const [tabs, setTabsState] = useState<PdfTab[]>([]);
  const [activeTabId, setActiveTabIdState] = useState<string | null>(null);
  // In-flight open requests by path. Prevents duplicate tabs when the same PDF
  // is opened concurrently (e.g. rapid double-clicks or multiple listeners).
  const pendingOpens = useRef<Map<string, Promise<PdfTab | null>>>(new Map());
  const openCommitQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [openingPaths, setOpeningPaths] = useState<string[]>([]);

  // 所有 Tab 写入都经 helper 同步镜像，hash 后的同步 commit 才能在同 tick
  // 读到激活、关闭、状态上报等其他操作刚刚写入的最新集合。
  const tabsRef = useRef(tabs);
  const updateTabs = useCallback((value: React.SetStateAction<PdfTab[]>) => {
    const next = typeof value === "function" ? value(tabsRef.current) : value;
    if (next === tabsRef.current) return;
    tabsRef.current = next;
    setTabsState(next);
  }, []);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const activeTabIdRef = useRef(activeTabId);
  const updateActiveTabId = useCallback((tabId: string | null) => {
    activeTabIdRef.current = tabId;
    setActiveTabIdState(tabId);
  }, []);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  const getHibernationContextRef = useRef(options?.getHibernationContext);
  useEffect(() => {
    getHibernationContextRef.current = options?.getHibernationContext;
  }, [options?.getHibernationContext]);

  const cachePdfBytesRef = useRef(options?.cachePdfBytes);
  useEffect(() => {
    cachePdfBytesRef.current = options?.cachePdfBytes;
  }, [options?.cachePdfBytes]);

  const getHibernationCtx = (): HibernationContext =>
    getHibernationContextRef.current?.() ?? {
      secondaryTabId: null,
      streamingTabIds: EMPTY_STREAMING_SET,
    };

  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null;

  const activateTab = useCallback(
    (tabId: string | null) => {
      const prevActiveId = activeTabIdRef.current;
      updateActiveTabId(tabId);
      if (tabId) {
        const now = Date.now();
        // 唤醒休眠 tab：hibernated 复位与 pendingGotoPage 必须在同一次
        // setTabs 里完成，保证挂载时 initialState 已就绪。
        const { toHibernate } = planWake(
          tabsRef.current,
          tabId,
          "active",
          getHibernationCtx(),
          prevActiveId,
          now
        );
        logHibernations(toHibernate, "budget");
        const hibernateIds = new Set(toHibernate.map((t) => t.id));
        // 目标已是当前 active 且未休眠时跳过 pendingGotoPage 重写：重写会用
        // 旧 pageNum 覆盖在飞的 gotoTabPage 跳转（useTabRestore 收到同页
        // pending 会再次跳回），仅刷新 lastActivatedAt。
        // Always set pendingGotoPage when switching to a tab so the viewer knows
        // it should restore position. If no page has been saved yet, default to 1.
        updateTabs((prev) =>
          prev.map((tab) => {
            if (tab.id === tabId) {
              if (tabId === prevActiveId && !tab.hibernated) {
                return { ...tab, lastActivatedAt: now };
              }
              return {
                ...tab,
                pendingGotoPage: tab.pageNum ?? 1,
                pendingGotoPdfY: undefined,
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
    },
    [updateActiveTabId, updateTabs]
  );

  const wakeTab = useCallback(
    (tabId: string) => {
      const now = Date.now();
      const { toHibernate } = planWake(
        tabsRef.current,
        tabId,
        "secondary",
        getHibernationCtx(),
        activeTabIdRef.current,
        now
      );
      if (toHibernate.length === 0) {
        // 目标未休眠则无需任何状态变更；已休眠但无候选时只需复位自身。
        const target = tabsRef.current.find((t) => t.id === tabId);
        if (!target?.hibernated) return;
      }
      logHibernations(toHibernate, "budget");
      const hibernateIds = new Set(toHibernate.map((t) => t.id));
      updateTabs((prev) =>
        prev.map((tab) => {
          if (tab.id === tabId) {
            return {
              ...tab,
              pendingGotoPage: tab.pageNum ?? 1,
              pendingGotoPdfY: undefined,
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
    },
    [updateTabs]
  );

  const addTab = useCallback(
    async (path: string, initialPage?: number): Promise<PdfTab | null> => {
      const inFlight = pendingOpens.current.get(path);
      if (inFlight) {
        return inFlight;
      }

      const promise = (async (): Promise<PdfTab | null> => {
        try {
          // 先按路径去重（无 I/O）：已打开的文件直接激活，避免重复全量读取。
          const byPath = tabsRef.current.find((tab) => tab.filePath === path);
          if (byPath) {
            activateTab(byPath.id);
            return byPath;
          }
          if (tabsRef.current.length >= HARD_TAB_LIMIT) {
            logError(
              `Tab hard limit (${HARD_TAB_LIMIT}) reached, refusing to open: ${path}`
            );
            return null;
          }

          await authorizePdfPath(path);
          const bytes = await readPdfBytes(path);
          cachePdfBytesRef.current?.(path, bytes);
          const [fileHash, fileSize] = await Promise.all([
            getPdfHash(path),
            getPdfFileSize(path),
          ]);

          // I/O 可并行，hash 后的检查与插入必须串行；临界区内不再 await。
          const previousCommit = openCommitQueueRef.current;
          let releaseCommit!: () => void;
          openCommitQueueRef.current = new Promise<void>((resolve) => {
            releaseCommit = resolve;
          });
          await previousCommit;
          let committed: PdfTab | null = null;
          try {
            const latest = tabsRef.current;
            const existing = latest.find(
              (tab) => tab.filePath === path || tab.fileHash === fileHash
            );
            if (existing) {
              activateTab(existing.id);
              committed = existing;
            } else if (latest.length >= HARD_TAB_LIMIT) {
              logError(
                `Tab hard limit (${HARD_TAB_LIMIT}) reached, refusing to open: ${path}`
              );
            } else {
              const now = Date.now();
              const ctx = getHibernationCtx();
              const candidates = selectHibernateCandidates(
                latest,
                {
                  activeTabId: activeTabIdRef.current,
                  secondaryTabId: ctx.secondaryTabId,
                  streamingTabIds: ctx.streamingTabIds,
                  now,
                },
                { filePath: path, fileSize }
              );
              const toHibernate = latest.filter((t) =>
                candidates.includes(t.id)
              );
              logHibernations(toHibernate, "budget");
              const hibernateIds = new Set(candidates);
              const newTab: PdfTab = {
                id: crypto.randomUUID(),
                filePath: path,
                fileName: getBasename(path),
                fileHash,
                fileSize,
                lastActivatedAt: now,
                ...(initialPage && initialPage > 0
                  ? { pageNum: Math.floor(initialPage) }
                  : {}),
              };
              updateTabs((prev) => [
                ...prev.map((tab) =>
                  hibernateIds.has(tab.id)
                    ? { ...tab, hibernated: true, selection: null }
                    : tab
                ),
                newTab,
              ]);
              activateTab(newTab.id);
              info(`pdfOpened: tabId=${newTab.id} fileHash=${newTab.fileHash}`);
              committed = newTab;
            }
          } finally {
            releaseCommit();
          }
          return committed;
        } catch (error) {
          logError(`Failed to open PDF: ${error}`);
          void showMessage(
            i18n.t("common.notice"),
            i18n.t("tab.openFailed", { name: getBasename(path) })
          ).catch(() => undefined);
          return null;
        }
      })();

      setOpeningPaths((prev) => [...prev, path]);
      pendingOpens.current.set(path, promise);
      try {
        return await promise;
      } finally {
        pendingOpens.current.delete(path);
        setOpeningPaths((prev) => prev.filter((p) => p !== path));
      }
    },
    [activateTab, updateTabs]
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
            activeTabIdRef.current,
            now
          );
          logHibernations(toHibernate, "budget");
          hibernateIds = new Set(toHibernate.map((t) => t.id));
        }
        // Set pendingGotoPage atomically with the tab removal so the next
        // active tab restores its previous page when its viewer mounts.
        updateTabs(
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
        updateActiveTabId(nextActive?.id ?? null);
      } else {
        updateTabs(nextTabs);
      }

      info(`pdfClosed: tabId=${tabId} remainingTabs=${nextTabs.length}`);
      onClose?.();
    },
    [tabs, activeTabId, updateActiveTabId, updateTabs]
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
      const targetId = tabId ?? activeTabIdRef.current;
      if (!targetId) return;
      updateTabs((prev) =>
        prev.map((tab) =>
          tab.id === targetId
            ? {
                ...tab,
                ...(state.pageNum !== undefined && { pageNum: state.pageNum }),
                ...(state.scale !== undefined && { scale: state.scale }),
                ...(state.scrollTop !== undefined && {
                  scrollTop: state.scrollTop,
                }),
              }
            : tab
        )
      );
    },
    [updateTabs]
  );

  const gotoTabPage = useCallback(
    (
      tabId: string,
      page: number,
      options?: { activate?: boolean; pdfY?: number }
    ) => {
      const activate = options?.activate !== false;
      // 防御：调用方可能传入持久化数据里的旧 tabId（如已落盘会话的
      // sources），目标 tab 不存在时绝不能动 activeTabId——否则 keep-alive
      // 树里所有 viewer 都因 isActive=false 被隐藏，阅读区整体消失。
      if (!tabsRef.current.some((t) => t.id === tabId)) return;
      // activate=false 用于分屏下跳转到副屏 tab：只跳页不激活，
      // 否则副屏会被提升为 active，导致两个面板渲染同一 PDF（塌缩）。
      if (activate) {
        updateActiveTabId(tabId);
      }
      const now = Date.now();
      // 目标可能处于休眠（如从解读记录跳转）：唤醒后才能看到内容。
      const { toHibernate } = planWake(
        tabsRef.current,
        tabId,
        activate ? "active" : "secondary",
        getHibernationCtx(),
        activeTabIdRef.current,
        now
      );
      logHibernations(toHibernate, "budget");
      const hibernateIds = new Set(toHibernate.map((t) => t.id));
      updateTabs((prev) =>
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
              pendingGotoPdfY: options?.pdfY,
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
    [updateActiveTabId, updateTabs]
  );

  const setTabSelection = useCallback(
    (tabId: string, selection: SelectionState | null) => {
      updateTabs((prev) =>
        prev.map((tab) => (tab.id === tabId ? { ...tab, selection } : tab))
      );
    },
    [updateTabs]
  );

  const clearTabSelection = useCallback(
    (tabId: string) => {
      updateTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId ? { ...tab, selection: null } : tab
        )
      );
    },
    [updateTabs]
  );

  const setTabHighlightedAnnotationId = useCallback(
    (tabId: string, annotationId: string | null) => {
      updateTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? { ...tab, highlightedAnnotationId: annotationId }
            : tab
        )
      );
    },
    [updateTabs]
  );

  const clearTabPendingGotoPage = useCallback(
    (tabId: string) => {
      updateTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? { ...tab, pendingGotoPage: undefined, pendingGotoPdfY: undefined }
            : tab
        )
      );
    },
    [updateTabs]
  );

  // 返回对象用 useMemo 固定引用：否则 App 每次渲染都拿到新对象，
  // 依赖它的 useCallback 会跟着重建，一路击穿 PdfPage 的 React.memo。
  return useMemo(
    () => ({
      tabs,
      activeTabId,
      activeTab,
      openingPaths,
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
      openingPaths,
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
