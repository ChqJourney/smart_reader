import { describe, it, expect } from "vitest";
import { getBasename, getDirname, middleEllipsize } from "./path";

describe("getBasename", () => {
  it("returns the last Unix path segment", () => {
    expect(getBasename("/docs/report.pdf")).toBe("report.pdf");
  });

  it("returns the last Windows path segment", () => {
    expect(getBasename("C:\\Users\\Alice\\report.pdf")).toBe("report.pdf");
  });

  it("handles mixed path separators", () => {
    expect(getBasename("C:/Users\\Alice/report.pdf")).toBe("report.pdf");
  });

  it("returns the original path when there is no separator", () => {
    expect(getBasename("report.pdf")).toBe("report.pdf");
  });

  it("falls back to the original path for a trailing separator", () => {
    expect(getBasename("/docs/")).toBe("/docs/");
  });

  it("handles empty strings", () => {
    expect(getBasename("")).toBe("");
  });
});

describe("getDirname", () => {
  it("returns the Unix directory part", () => {
    expect(getDirname("/docs/standards/report.pdf")).toBe("/docs/standards");
  });

  it("returns the Windows directory part", () => {
    expect(getDirname("C:\\Users\\Alice\\report.pdf")).toBe("C:/Users/Alice");
  });

  it("handles mixed separators", () => {
    expect(getDirname("C:/Users\\Alice/report.pdf")).toBe("C:/Users/Alice");
  });

  it("returns empty string when there is no directory", () => {
    expect(getDirname("report.pdf")).toBe("");
  });

  it("returns empty string for root-level files", () => {
    expect(getDirname("/report.pdf")).toBe("");
  });

  it("handles empty strings", () => {
    expect(getDirname("")).toBe("");
  });
});

describe("middleEllipsize", () => {
  it("returns the original text when within budget", () => {
    expect(middleEllipsize("IEC 60335-1.pdf")).toBe("IEC 60335-1.pdf");
  });

  it("keeps both ends of a long standard file name", () => {
    const name =
      "IEC 60335-2-40-2022 Household and similar electrical appliances.pdf";
    const result = middleEllipsize(name, 40);
    expect(result).toHaveLength(40);
    expect(result.startsWith("IEC 60335-2-40-2022 Hous")).toBe(true);
    expect(result.endsWith("pliances.pdf")).toBe(true);
    expect(result).toContain("…");
  });

  it("gives the head a larger share than the tail", () => {
    const name = "a".repeat(30) + "b".repeat(30);
    const result = middleEllipsize(name, 21);
    const [head, tail] = result.split("…");
    expect(head.length).toBeGreaterThan(tail.length);
  });

  it("degrades to head truncation for tiny budgets", () => {
    expect(middleEllipsize("abcdefghij", 5)).toBe("abcde");
  });
});
