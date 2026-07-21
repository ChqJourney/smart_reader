/**
 * Copy text to the system clipboard.
 *
 * Prefers the async Clipboard API (`navigator.clipboard.writeText`), which works
 * inside the Tauri webview when the page is in a secure context. Falls back to a
 * hidden-textarea + `execCommand('copy')` for environments where the async API
 * is unavailable or blocked (e.g. older webviews, non-secure contexts).
 */
export async function copyToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through to the legacy path below.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    const ok = document.execCommand("copy");
    if (!ok) {
      throw new Error("execCommand('copy') returned false");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}
