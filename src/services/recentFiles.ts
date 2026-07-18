import { invoke } from "@tauri-apps/api/core";
import { error } from "./logs";

/**
 * A recently opened PDF entry. `pinned` entries stay at the top of the
 * recent-files panel and are not rotated out by recency; `lastPage` records
 * the reading position when the tab was last closed so the panel can offer
 * to resume where the user left off.
 */
export interface RecentFile {
  path: string;
  fileName: string;
  openedAt: number;
  pinned?: boolean;
  lastPage?: number;
}

export async function loadRecentFiles(): Promise<RecentFile[]> {
  try {
    const result = await invoke<RecentFile[]>("load_recent_files");
    return result || [];
  } catch (err) {
    error(`Failed to load recent files: ${err}`);
    return [];
  }
}

export async function saveRecentFiles(files: RecentFile[]): Promise<void> {
  try {
    await invoke("save_recent_files", { files });
  } catch (err) {
    error(`Failed to save recent files: ${err}`);
  }
}

/**
 * Check which of the given paths still exist on disk. On failure (e.g. in a
 * non-Tauri test environment) every path is treated as existing so the panel
 * does not wrongly grey out entries.
 */
export async function checkFilesExist(paths: string[]): Promise<boolean[]> {
  if (paths.length === 0) return [];
  try {
    return await invoke<boolean[]>("check_files_exist", { paths });
  } catch (err) {
    error(`Failed to check file existence: ${err}`);
    return paths.map(() => true);
  }
}
