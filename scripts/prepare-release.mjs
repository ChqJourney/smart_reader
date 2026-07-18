import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// 发布准备：把 CHANGELOG.md 的 [Unreleased] 段落固化为指定版本段落，
// 并把段落内容提取到 release_notes.md 作为 GitHub Release notes。
// release.yml 在 commit / tag 之前调用；校验失败时非零退出且不写入任何文件。

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "..");

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: node scripts/prepare-release.mjs <version>");
  console.error("Example: node scripts/prepare-release.mjs 0.8.2");
  process.exit(1);
}

const changelogPath = path.join(root, "CHANGELOG.md");
if (!fs.existsSync(changelogPath)) {
  console.error("未找到 CHANGELOG.md");
  process.exit(1);
}

const md = fs.readFileSync(changelogPath, "utf8");

if (md.includes(`## [${version}]`)) {
  console.error(`CHANGELOG.md 已存在 ## [${version}] 段落，请确认版本号`);
  process.exit(1);
}

const lines = md.split("\n");
const unreleasedIdx = lines.findIndex((line) =>
  /^## \[Unreleased\][ \t]*$/.test(line),
);
if (unreleasedIdx === -1) {
  console.error("CHANGELOG.md 中找不到 '## [Unreleased]' 段落标题");
  process.exit(1);
}

// [Unreleased] 标题到下一个二级标题之间的内容即本次 Release notes
let nextIdx = lines.length;
for (let i = unreleasedIdx + 1; i < lines.length; i++) {
  if (lines[i].startsWith("## ")) {
    nextIdx = i;
    break;
  }
}
const notes = lines
  .slice(unreleasedIdx + 1, nextIdx)
  .join("\n")
  .trim();
if (!notes) {
  console.error(
    `CHANGELOG.md 的 [Unreleased] 段落为空，请先记录 v${version} 的变更内容再发布`,
  );
  process.exit(1);
}

// 固化：原 [Unreleased] 内容归入新版本段落，[Unreleased] 重新留空
const date = new Date().toISOString().slice(0, 10);
lines.splice(unreleasedIdx + 1, 0, "", `## [${version}] - ${date}`);
fs.writeFileSync(changelogPath, lines.join("\n"));

fs.writeFileSync(path.join(root, "release_notes.md"), notes + "\n");
console.log(`CHANGELOG.md 已固化 v${version} 段落，release_notes.md 已生成`);
