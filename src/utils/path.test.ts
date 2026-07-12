import { describe, it, expect } from "vitest";
import { getBasename } from "./path";

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
