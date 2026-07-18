import { useCallback, useEffect, useState } from "react";
import {
  RecentFile,
  loadRecentFiles,
  saveRecentFiles,
} from "../services/recentFiles";

// 未固定条目按时间保留最近 20 条；固定条目单独保留 10 条，超出时最旧的
// 固定条目降级回未固定列表参与时间淘汰。
const MAX_RECENT_FILES = 20;
const MAX_PINNED_FILES = 10;

export type { RecentFile };

export interface UseRecentFilesReturn {
  recentFiles: RecentFile[];
  loaded: boolean;
  addRecentFile: (path: string, fileName: string) => void;
  removeRecentFile: (path: string) => void;
  togglePinRecentFile: (path: string) => void;
  updateLastPage: (path: string, page: number) => void;
  clearRecentFiles: () => void;
}

/**
 * Pinned entries first, then unpinned, each group ordered by recency. Enforces
 * the per-group caps: over-cap pinned entries are demoted to unpinned (oldest
 * first), over-cap unpinned entries are dropped.
 */
export function normalizeRecentFiles(files: RecentFile[]): RecentFile[] {
  const sorted = [...files].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return b.openedAt - a.openedAt;
  });
  const result: RecentFile[] = [];
  let pinnedCount = 0;
  let unpinnedCount = 0;
  for (const file of sorted) {
    if (file.pinned) {
      pinnedCount += 1;
      if (pinnedCount > MAX_PINNED_FILES) {
        // 降级为最旧的未固定条目，继续占用未固定配额
        unpinnedCount += 1;
        if (unpinnedCount <= MAX_RECENT_FILES) {
          result.push({ ...file, pinned: false });
        }
        continue;
      }
      result.push(file);
    } else {
      unpinnedCount += 1;
      if (unpinnedCount <= MAX_RECENT_FILES) result.push(file);
    }
  }
  return result;
}

export function useRecentFiles(): UseRecentFilesReturn {
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadRecentFiles()
      .then((files) => {
        if (cancelled) return;
        setRecentFiles(normalizeRecentFiles(files));
        setLoaded(true);
      })
      .catch(() => {
        // loadRecentFiles 内部已降级为空数组并记录日志，这里只兜底标记加载完成
        if (cancelled) return;
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((mutate: (prev: RecentFile[]) => RecentFile[]) => {
    setRecentFiles((prev) => {
      const mutated = mutate(prev);
      // 无实际变更（如更新不存在条目的 lastPage）时跳过持久化与重渲染
      if (mutated === prev) return prev;
      const next = normalizeRecentFiles(mutated);
      saveRecentFiles(next);
      return next;
    });
  }, []);

  const addRecentFile = useCallback(
    (path: string, fileName: string) => {
      update((prev) => {
        const existing = prev.find((f) => f.path === path);
        // 重新打开时保留固定状态与上次读到的页码
        const entry: RecentFile = {
          path,
          fileName,
          openedAt: Date.now(),
          ...(existing?.pinned ? { pinned: true } : {}),
          ...(existing?.lastPage !== undefined
            ? { lastPage: existing.lastPage }
            : {}),
        };
        return [entry, ...prev.filter((f) => f.path !== path)];
      });
    },
    [update]
  );

  const removeRecentFile = useCallback(
    (path: string) => {
      update((prev) => prev.filter((f) => f.path !== path));
    },
    [update]
  );

  const togglePinRecentFile = useCallback(
    (path: string) => {
      update((prev) =>
        prev.map((f) => (f.path === path ? { ...f, pinned: !f.pinned } : f))
      );
    },
    [update]
  );

  const updateLastPage = useCallback(
    (path: string, page: number) => {
      if (!Number.isFinite(page) || page < 1) return;
      update((prev) => {
        if (!prev.some((f) => f.path === path)) return prev;
        return prev.map((f) =>
          f.path === path ? { ...f, lastPage: Math.floor(page) } : f
        );
      });
    },
    [update]
  );

  const clearRecentFiles = useCallback(() => {
    setRecentFiles([]);
    saveRecentFiles([]);
  }, []);

  return {
    recentFiles,
    loaded,
    addRecentFile,
    removeRecentFile,
    togglePinRecentFile,
    updateLastPage,
    clearRecentFiles,
  };
}
