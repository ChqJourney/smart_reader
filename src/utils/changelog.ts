/**
 * CHANGELOG.md 版本段落解析。
 *
 * CHANGELOG 遵循 Keep a Changelog：每个版本一个 `## [x.y.z] - 日期` 二级标题，
 * 开发中的变更在 `## [Unreleased]` 段落。这里按标题切分，提取指定版本的正文
 * markdown（不含标题行本身），供「本次更新内容」弹窗与设置页展示。
 */

const VERSION_HEADING = /^## \[([^\]]+)\][^\n]*$/;

/**
 * 提取 changelog 中指定版本的段落正文。
 * 找不到该版本（如 hotfix 未记录）时返回 null；`[Unreleased]` 不是版本号，
 * 不会被任何版本匹配到。
 */
export function extractVersionSection(
  changelog: string,
  version: string
): string | null {
  const lines = changelog.split("\n");
  let inSection = false;
  const body: string[] = [];

  for (const line of lines) {
    const match = VERSION_HEADING.exec(line.trimEnd());
    if (match) {
      if (inSection) break; // 下一个版本段落开始，收尾
      // Unreleased 不是已发布版本，显式排除，避免字面传入时误匹配。
      inSection = match[1] === version && version !== "Unreleased";
      continue;
    }
    if (inSection) body.push(line);
  }

  if (!inSection) return null;
  const text = body.join("\n").trim();
  return text.length > 0 ? text : null;
}
