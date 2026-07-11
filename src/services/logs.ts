import { invoke } from "@tauri-apps/api/core";

export async function openLogsDir(): Promise<void> {
  await invoke("open_logs_dir");
}

export async function logError(
  message: string,
  error?: unknown
): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error);
  try {
    await invoke("log_error", { message: `${message}: ${detail}` });
  } catch {
    // Fallback to browser console if the backend logger is unavailable.
    console.error(message, error);
  }
}
