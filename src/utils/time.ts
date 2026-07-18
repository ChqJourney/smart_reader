/**
 * Relative time rendering for the recent-files panel. Returns a structured
 * result so the caller can map it to i18n keys; falls back to an absolute
 * locale date for anything older than a week.
 */
export type RelativeTime =
  | { kind: "justNow" }
  | { kind: "minutesAgo" | "hoursAgo" | "daysAgo"; count: number }
  | { kind: "date"; date: string };

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatRelativeTime(
  timestamp: number,
  now: number = Date.now()
): RelativeTime {
  const diff = Math.max(0, now - timestamp);
  if (diff < MINUTE) return { kind: "justNow" };
  if (diff < HOUR)
    return { kind: "minutesAgo", count: Math.floor(diff / MINUTE) };
  if (diff < DAY) return { kind: "hoursAgo", count: Math.floor(diff / HOUR) };
  if (diff < 7 * DAY) return { kind: "daysAgo", count: Math.floor(diff / DAY) };
  return { kind: "date", date: new Date(timestamp).toLocaleDateString() };
}
