import { describe, expect, it } from "vitest";
import { extractVersionSection } from "./changelog";

const SAMPLE = `# Changelog

## [Unreleased]

### Added

- 未发布的改动

## [1.4.0] - 2026-10-18

### Added

- 联网搜索工具

### Fixed

- 修复一个问题

## [1.3.0] - 2026-10-11

### Changed

- 大纲跳转升级

## [1.2.0] - 2026-10-11

### Removed

- 移除隐藏按钮
`;

describe("extractVersionSection", () => {
  it("提取中间版本的完整段落，保留子标题", () => {
    const section = extractVersionSection(SAMPLE, "1.4.0");
    expect(section).toBe(
      "### Added\n\n- 联网搜索工具\n\n### Fixed\n\n- 修复一个问题"
    );
  });

  it("提取末尾版本时以 EOF 收尾", () => {
    const section = extractVersionSection(SAMPLE, "1.2.0");
    expect(section).toBe("### Removed\n\n- 移除隐藏按钮");
  });

  it("版本不存在时返回 null", () => {
    expect(extractVersionSection(SAMPLE, "9.9.9")).toBeNull();
  });

  it("Unreleased 段落不会被版本号匹配", () => {
    expect(extractVersionSection(SAMPLE, "Unreleased")).toBeNull();
  });

  it("版本段落只有标题没有正文时返回 null", () => {
    const empty = `## [1.0.0] - 2026-01-01\n\n## [0.9.0] - 2025-12-01\n\n- 内容\n`;
    expect(extractVersionSection(empty, "1.0.0")).toBeNull();
  });

  it("不匹配子标题级别的版本号文本", () => {
    const nested = `## [1.1.0] - 2026-01-01\n\n- 某条提到 1.1.1 的说明\n`;
    expect(extractVersionSection(nested, "1.1.1")).toBeNull();
  });
});
