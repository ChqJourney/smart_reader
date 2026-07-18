import { describe, it, expect } from "vitest";
import { formatRelativeTime } from "./time";

const NOW = new Date("2026-07-18T12:00:00Z").getTime();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatRelativeTime", () => {
  it("returns justNow for less than a minute", () => {
    expect(formatRelativeTime(NOW - 30 * 1000, NOW)).toEqual({
      kind: "justNow",
    });
  });

  it("returns minutesAgo with count", () => {
    expect(formatRelativeTime(NOW - 5 * MINUTE, NOW)).toEqual({
      kind: "minutesAgo",
      count: 5,
    });
  });

  it("returns hoursAgo with count", () => {
    expect(formatRelativeTime(NOW - 3 * HOUR, NOW)).toEqual({
      kind: "hoursAgo",
      count: 3,
    });
  });

  it("returns daysAgo with count", () => {
    expect(formatRelativeTime(NOW - 2 * DAY, NOW)).toEqual({
      kind: "daysAgo",
      count: 2,
    });
  });

  it("falls back to an absolute date after a week", () => {
    const result = formatRelativeTime(NOW - 10 * DAY, NOW);
    expect(result.kind).toBe("date");
    if (result.kind === "date") {
      expect(result.date.length).toBeGreaterThan(0);
    }
  });

  it("treats future timestamps as justNow", () => {
    expect(formatRelativeTime(NOW + MINUTE, NOW)).toEqual({
      kind: "justNow",
    });
  });
});
