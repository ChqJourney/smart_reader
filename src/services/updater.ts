import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

/**
 * Tauri updater 封装。
 *
 * The updater endpoint is configured in `tauri.conf.json` and points to the
 * GitHub Release `latest.json` manifest (Gitee mirror first). The downloaded
 * archive is verified against the embedded public key before extraction.
 *
 * `latest.json` 的 `notes` 字段即当次版本的 changelog 段落（release.yml 从
 * CHANGELOG.md 提取并写入），经 `Update.body` 暴露给前端展示更新内容。
 */

/**
 * Raw update info returned by the Tauri updater.
 */
export type UpdateInfo = Update;

interface UpdateCheckResult {
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
