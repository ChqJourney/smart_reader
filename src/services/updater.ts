import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ask } from "@tauri-apps/plugin-dialog";

/**
 * Check for Tauri application updates and prompt the user to install.
 *
 * The updater endpoint is configured in `tauri.conf.json` and points to the
 * GitHub Release `latest.json` manifest. The downloaded archive is verified
 * against the embedded public key before extraction.
 */
export async function checkForUpdate(): Promise<void> {
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
}

/**
 * Expose the raw update info for callers that want custom UI.
 */
export type UpdateInfo = Update;
