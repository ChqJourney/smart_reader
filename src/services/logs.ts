import { invoke } from "@tauri-apps/api/core";

export async function openLogsDir(): Promise<void> {
  await invoke("open_logs_dir");
}
