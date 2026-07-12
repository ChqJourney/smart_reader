import {
  debug as pluginDebug,
  error as pluginError,
  info as pluginInfo,
  trace as pluginTrace,
  warn as pluginWarn,
  type LogOptions,
} from "@tauri-apps/plugin-log";
import { invoke } from "@tauri-apps/api/core";

export type { LogOptions };

/**
 * Redact potentially sensitive content from log messages before sending them
 * to the backend log file.
 *
 * This is a best-effort guard: it strips common API key patterns, Bearer
 * tokens, and replaces user home directory prefixes with "~". It does not
 * make logs fully safe on its own; callers should still avoid passing full
 * PDF text, prompt content, or file paths when possible.
 */
export function redactSensitiveInfo(message: string): string {
  return (
    message
      // OpenAI-style API keys: sk-... (at least 20 chars)
      .replace(/sk-[a-zA-Z0-9_-]{20,}/g, "[REDACTED]")
      // Generic Bearer tokens
      .replace(/Bearer\s+\S+/g, "Bearer [REDACTED]")
      // macOS / Linux home directories: /Users/name/... or /home/name/...
      .replace(/(?:\/Users\/[^/\s]+|\/home\/[^/\s]+)(?=\/)/g, "~")
      // Windows user profiles: C:\Users\name\... or C:\Documents and Settings\name\...
      .replace(/[A-Za-z]:\\Users\\[^\\\s]+(?=\\)/g, "~")
      .replace(/[A-Za-z]:\\Documents and Settings\\[^\\\s]+(?=\\)/g, "~")
  );
}

export async function debug(
  message: string,
  options?: LogOptions
): Promise<void> {
  return pluginDebug(redactSensitiveInfo(message), options);
}

export async function info(
  message: string,
  options?: LogOptions
): Promise<void> {
  return pluginInfo(redactSensitiveInfo(message), options);
}

export async function warn(
  message: string,
  options?: LogOptions
): Promise<void> {
  return pluginWarn(redactSensitiveInfo(message), options);
}

export async function error(
  message: string,
  options?: LogOptions
): Promise<void> {
  return pluginError(redactSensitiveInfo(message), options);
}

export async function trace(
  message: string,
  options?: LogOptions
): Promise<void> {
  return pluginTrace(redactSensitiveInfo(message), options);
}

export async function openLogsDir(): Promise<void> {
  await invoke("open_logs_dir");
}
