# Changelog

本项目所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

开发时把变更记录在 `## [Unreleased]` 段落下；发布时 Release workflow 会自动将其固化为 `## [x.y.z] - 日期` 版本段落，并把内容提取为 GitHub Release notes。

## [Unreleased]

### Added
- 新增 `CHANGELOG.md`：开发时把变更记录在 `[Unreleased]` 段落下，发布时自动提取为 GitHub Release notes。
- 新增 `scripts/prepare-release.mjs`：发布时自动固化 CHANGELOG 版本段落并提取 Release notes，段落为空则终止发布。

### Changed
- CI 分层触发：非 master 分支 push 只跑 lint / type-check / 单元测试（`ci-quick.yml`）；完整检查（前端构建、Rust 测试 / clippy、双浏览器 E2E、npm / cargo audit）集中到 master push / PR（`ci-full.yml`），三个 job 并行且 Rust 依赖有缓存。
- 发布改为一键触发（`release.yml`）：Actions 页面输入版本号即可自动 bump 版本、打 tag、构建并创建 Draft Release，人工冒烟测试后手动 Publish，避免发布即全量推送。
- Release 构建改用 `tauri-action`，updater 的 `latest.json` 自动生成，替代手写 PowerShell。
- cargo-audit 改用预编译二进制安装，不再每次源码编译。

### Removed
- 删除旧的 `ci.yml`（每次 push 全量串行、无缓存）与 `cd.yml`（tag 触发、手写 `latest.json`、发布即生效无冒烟窗口）。
