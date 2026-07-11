import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const MAX_RECENT_FILES = 20;

export interface RecentFile {
  path: string;
  fileName: string;
  openedAt: number;
}

export interface UseRecentFilesReturn {
  recentFiles: RecentFile[];
  loaded: boolean;
  addRecentFile: (path: string, fileName: string) => void;
  clearRecentFiles: () => void;
}

export function useRecentFiles(): UseRecentFilesReturn {
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<RecentFile[]>("load_recent_files")
      .then((files) => {
        if (cancelled) return;
        setRecentFiles(files || []);
        setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load recent files:", err);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const addRecentFile = useCallback((path: string, fileName: string) => {
    setRecentFiles((prev) => {
      const filtered = prev.filter((f) => f.path !== path);
      const next = [
        { path, fileName, openedAt: Date.now() },
        ...filtered,
      ].slice(0, MAX_RECENT_FILES);
      invoke("save_recent_files", { files: next }).catch((err) =>
        console.error("Failed to save recent files:", err)
      );
      return next;
    });
  }, []);

  const clearRecentFiles = useCallback(() => {
    setRecentFiles([]);
    invoke("save_recent_files", { files: [] }).catch((err) =>
      console.error("Failed to save recent files:", err)
    );
  }, []);

  return { recentFiles, loaded, addRecentFile, clearRecentFiles };
}
