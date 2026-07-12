import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ask } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { error as logError } from "./logs";

/**
 * Check for Tauri application updates and prompt the user to install.
 *
 * The updater endpoint is configured in `tauri.conf.json` and points to the
 * GitHub Release `latest.json` manifest. The downloaded archive is verified
 * against the embedded public key before extraction.
 */
export async function checkForUpdate(): Promise<void> {
  try {
    const update = await check();
    if (!update?.available) {
      return;
    }

    const yes = await ask(
      `发现新版本 ${update.version}，是否立即下载并重启安装？`,
      { title: "SpecReader AI 更新", kind: "info" }
    );

    if (yes) {
      await update.downloadAndInstall();
      await relaunch();
    }
  } catch (error) {
    logError(`[updater] 检查更新失败: ${error}`);
    throw error;
  }
}

/**
 * Raw update info returned by the Tauri updater.
 */
export type UpdateInfo = Update;

export interface UpdateCheckResult {
  available: boolean;
  version?: string;
  currentVersion?: string;
  update?: Update;
}

/**
 * Check for updates and return structured info for custom UI.
 *
 * In non-Tauri environments (e.g. browser tests) the underlying `check()`
 * will throw; callers should catch and surface a friendly message.
 */
export async function checkUpdateInfo(): Promise<UpdateCheckResult> {
  const update = await check();
  const currentVersion = await getVersion();
  if (!update?.available) {
    return { available: false, currentVersion };
  }
  return {
    available: true,
    version: update.version,
    currentVersion,
    update,
  };
}

/**
 * Download, install the given update and relaunch the application.
 */
export async function installUpdate(update: Update): Promise<void> {
  await update.downloadAndInstall();
  await relaunch();
}
