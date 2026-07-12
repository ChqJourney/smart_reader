/**
 * Extract the file name (basename) from a file path, handling both Unix
 * (`/`) and Windows (`\\`) separators.
 */
export function getBasename(path: string): string {
  if (!path) return path;
  const normalized = path.replace(/\\/g, "/");
  const base = normalized.split("/").pop();
  return base || path;
}
