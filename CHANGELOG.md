# Changelog

本项目所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

开发时把变更记录在 `## [Unreleased]` 段落下；发布时 Release workflow 会自动将其固化为 `## [x.y.z] - 日期` 版本段落，并把内容提取为 GitHub Release notes。

## [Unreleased]

## [0.9.5] - 2026-07-23

### Added
- 新增首次启动配置向导 `SetupWizard`：三步引导（选平台 → 填密钥 → 测试连接），降低检测/研发工程师等非编程用户的上手门槛。平台卡片做诚实标注（推荐 / 免费但限速 / 需海外信用卡），高级项（深度思考 / 自动核对原文条款 / 目标语言）默认折叠收起，测试失败按错误类型给出「下一步建议」而非技术栈报错。首次启动若所有内置平台在系统钥匙串中均无密钥则自动弹出。
- 设置 → 模型页新增「运行配置向导」入口，已配置过密钥的用户也可随时重新进入。已配置平台在向导中显示绿色「已配置」徽标；重新运行向导时第 2 步允许留空密钥并沿用系统钥匙串中已保存的密钥（复用 `save_settings_with_storage` 空 apiKey 保留现有 keyring 的逻辑），无需重新粘贴即可换平台或改模型。

## [0.9.4] - 2026-07-22

### Fixed
- 强化 API Key 安全边界：后端加载设置时不再向 webview 返回明文密钥；以仅返回配置状态的校验接口替代取钥接口，并支持从设置界面清除已保存密钥。设置弹窗不再预填或缓存明文密钥，保存空值时保留系统钥匙串中的现有密钥。
- 修复全文搜索在 PDF.js 文本项边界处遗漏短语的问题：按页建立连续文本索引并映射回原始坐标，现可命中跨样式、跨行或逐词拆分的短语，同时保持对应区域高亮。

## [0.9.3] - 2026-07-21

### Added
- 选区工具条新增「复制」按钮：一键将选中文本写入系统剪贴板（优先 `navigator.clipboard`，Tauri webview 下自动降级到 `execCommand`）。
- 选区工具条新增「批注」按钮：在选区处生成紫色 comment 标记与类翻译框的可编辑批注；输入内容按 PDF 文件 SHA-256 hash 持久化，重开 PDF 自动恢复，支持拖拽移动、隐藏与删除。

## [0.9.1] - 2026-07-21

### Added
- 自定义标题栏：移除原生 titlebar，整合品牌 logo / 最近文件 / 设置 / 打开 PDF 入口与窗口控制（最小化 / 最大化 / 还原 / 关闭），窗口支持拖拽移动。
- 工具调用达到上限时优雅处理：注入最终指令让模型停止请求工具并基于已查阅结果作答，并在界面提示可调高「最大工具调用次数」后重新发起解读。

### Changed
- 默认最大工具调用轮次 `maxToolRounds` 由 5 提高到 20。
- 标题栏视觉协调化与按钮重设计：高度 38→44px，Open PDF 改为 tinted 风格（淡蓝底 + 蓝描边 + 蓝字），设置按钮与窗口控制统一为 30px 高、7px 圆角并加分隔线分组。

### Fixed
- 提升 `.app-header` 的 z-index 至 101，避免被 PDF 选区覆盖层（z-index 10）盖住最近文件下拉面板，导致菜单无法点击、光标变为 crosshair。

## [0.9.0] - 2026-07-19

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
