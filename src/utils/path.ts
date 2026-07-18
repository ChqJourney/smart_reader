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

/**
 * Extract the directory part of a file path (everything before the last
 * separator), handling both Unix and Windows separators. Returns an empty
 * string when the path has no directory component.
 */
export function getDirname(path: string): string {
  if (!path) return "";
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "";
  return normalized.slice(0, index);
}

/**
 * Truncate a long file name in the middle, keeping both ends visible. For
 * standard documents the standard number sits at the front and the edition
 * year near the end, so a tail ellipsis would hide exactly the information
 * engineers use to tell editions apart. The head gets a larger share of the
 * budget because the leading identifier matters most.
 */
export function middleEllipsize(text: string, maxLength = 40): string {
  if (text.length <= maxLength) return text;
  if (maxLength < 8) return text.slice(0, maxLength);
  const budget = maxLength - 1; // one char for the ellipsis
  const headLength = Math.ceil(budget * 0.6);
  const tailLength = budget - headLength;
  return `${text.slice(0, headLength)}…${text.slice(text.length - tailLength)}`;
}
