# Changelog

本项目所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

开发时把变更记录在 `## [Unreleased]` 段落下；发布时 Release workflow 会自动将其固化为 `## [x.y.z] - 日期` 版本段落，并把内容提取为 GitHub Release notes。

## [Unreleased]

### Added
- 解读 / 自定义解读 / 追问时启用 **Agent Tools**：LLM 可通过 `list_open_pdfs`、`read_pdf_page`、`search_in_pdf` 三个 Function Calling 工具查阅当前打开的 PDF 原文，辅助验证条款引用与跨页内容。
- 新增工具调用状态指示器 `ToolCallsIndicator`：流式解读运行时显示“正在搜索/读取”提示，完成后可折叠查看调用记录。
- 设置「功能设置」分页新增「智能查阅文档」总开关，默认开启；「模型设置」中的最大工具轮次 `maxToolRounds` 现在真正限制 agent loop 的工具调用轮次。
- 新增 `services/pdfTools.ts` 工具执行层（瞬态 `ToolSession`）与 `services/pdfToolsRegistry.ts` 授权注册表：工具只服务当前已打开 Tab 的白名单 PDF，loop 结束即销毁文档实例。
- 补齐 Agent Tools 相关单元测试与 i18n 文案。

### Changed
- 优化 AI 对话等待动画：从 emoji/方块改为 CSS 动效。
- 隐藏 `role=tool` 的工具中间消息，避免历史记录冗长。

### Fixed
- 修复 `StreamEvent::ToolCall` 中 `call_id` 序列化/反序列化不匹配的问题。
- 修复 tool call 完成后 spinner 与 streaming cursor 不消失的问题。
- 修复分屏（双排）模式下 AI 栏无法关闭的问题：自动展开逻辑改为仅在进入分屏的瞬间触发，分屏期间允许手动关闭。

## [0.8.3] - 2026-07-18

### Added
- 最近文件改为下拉面板：顶栏「最近文件」按钮开合（快捷键 Ctrl/Cmd+Shift+O），支持置顶常用标准（上限 10 条，超额自动降级）、按文件名/路径搜索（超过 8 条时出现搜索框）、显示所在目录/相对时间/上次读到的页码、已移动或删除文件置灰、单条移除、两段式「清空全部」、从列表直接在右侧分屏打开对照。
- 关闭标签页时回写阅读页码（`RecentFile.lastPage`），从最近文件打开时自动恢复到上次读到的页；`RecentFile` 新增 `pinned` 字段，旧数据自动兼容。
- 新增 Tauri 命令 `check_files_exist` 用于批量检测文件存在性。

### Changed
- 最近文件从顶栏横向胶囊列表改为入口按钮 + 下拉面板，文件名改用中间省略以保留标准号与年份两端信息；「清空全部」移入面板底部并需二次确认。

## [0.8.2] - 2026-07-18

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
