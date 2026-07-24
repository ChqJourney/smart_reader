# SpecReader AI 项目指南

> 本文件供 AI coding agent 阅读，用于快速理解项目结构、技术栈、构建流程与开发约定。

## 1. 项目概述

**SpecReader AI**（内部代号 `pdf-standard-agent`）是一款面向检测认证工程师的桌面端 AI 助手，用于降低阅读、理解和执行 IEC / ISO / EN / GB / UL / ASTM / IEEE 等标准 PDF 文件时的认知与智力开销。

当前处于**「超轻量版」**，核心闭环为：

```
打开本地 PDF → 本地渲染 → 选中文本 → AI 翻译 / 解读
```

已实现能力：

- 自定义标题栏（无边框窗口 `decorations: false`）：品牌区拖动 + 最近文件 / 打开 PDF / 设置 + 窗口控制按钮。
- 首次启动配置向导（SetupWizard）：选平台 → 填 Key → 测试连接，全部平台未配置 Key 时才自动弹出，设置里可重跑。
- 多 PDF Tab 同时打开（最多 10 个），支持左右并排对照两份 PDF。进入并排的入口：拖拽非激活 tab 到阅读区（带 drop-zone 遮罩）、tab 栏「并排对照」按钮、最近文件面板的并排按钮、面板内 Alt+Enter。进入并排时两个屏自动 fit-to-width 一次（`autoFitToWidth`，在挂载恢复完成后执行，页码不变）。并排时两个 PDF 的暂存片段与解读记录合并显示在右侧面板，双屏均可选中文本暂存 / 解读（选区消费跟随产生选区的屏），可跨 PDF 勾选片段一起自定义解读。
- PDF 本地渲染、文本选区、缩放、页码跳转、单页 / 连续滚动阅读模式。
- 全文搜索（Ctrl / Cmd + F，支持跨 text item 短语匹配，结果逐页高亮、Enter / Shift+Enter 前后跳转）。
- 大纲 / 目录导航面板（PDF 自带 outline 时可用，点击跳转章节）。
- 选中文本后浮动工具条：加入暂存、解读、翻译、复制、批注（comment 浮层，可拖动编辑）。
- 翻译生成可拖动 / 隐藏 / 删除的浮层批注。
- 解读生成蓝色标记，并在右侧面板展示可点击跳转的解读记录，支持多轮追问。
- 自定义解读：把多个暂存片段一次性发给 LLM。暂存区支持选择模式勾选部分片段（未进入选择模式时默认全选）；解读要求弹窗仅能通过「取消」/「发送」关闭。
- 批注和解读记录按 PDF 文件 SHA-256 hash 持久化到本地 AppData。
- 最近文件下拉面板：置顶常用标准、按文件名/路径搜索、显示目录/相对时间/上次读到的页码、失效文件置灰、单条移除与两段式清空、从列表直接在分屏打开对照（快捷键 Ctrl/Cmd+Shift+O 开合面板）。
- 鼠标悬停英文单词显示本地 ECDICT 词典翻译（设置中可开关，首次启用需下载离线词典）。
- 解读 / 自定义解读 / 追问时启用 **Agent Tools**：LLM 可通过 Function Calling 查阅当前打开的 PDF 原文（`list_open_pdfs`、`read_pdf_page`、`search_in_pdf`），辅助验证条款引用与跨页内容。
- LLM 配置（Base URL、Model、目标语言等）保存于后端 AppData；API Key 按平台分条目存放于系统钥匙串（macOS Keychain / Windows Credential Manager / Linux Secret Service），不再落入 `settings.json`。
- LLM 请求整体后端代理化（`llm_proxy.rs`）：前端不再直接发起 HTTP 请求，API Key 不进入 webview。
- 软件自动更新：启动 3 秒后自动检查，设置「关于」页可手动检查；失败仅记日志。
- 单实例 + 文件关联：通过 `open-pdf` 系统事件打开 PDF（如双击 .pdf 文件）；冷启动时丢失的 emit 由后端缓存，前端 listener 就绪后通过 `take_pending_open_pdfs` 取回并打开。
- i18n 框架接入（i18next + react-i18next）：当前 `lng` 硬编码 `zh-CN`、界面不可切换语言，`en.json` 为预埋；`targetLanguage` 是 LLM 输出语言，与 UI 语言无关。

明确未实现（已规划到后续版本）：

- Clause 索引、引用追踪。
- 术语表、测试清单生成。
- 表格截图 + 多模态读取。
- License 激活校验。

## 2. 技术栈

| 层级          | 技术                                                          |
| ------------- | ------------------------------------------------------------ |
| 桌面框架      | Tauri 2.0（Rust 后端 + Web 前端）                              |
| Tauri 插件    | log / dialog / shell / updater / process / single-instance   |
| 前端框架      | React 18 + TypeScript 5.6                                     |
| 构建工具      | Vite 6                                                        |
| PDF 渲染      | pdfjs-dist 4.8                                                |
| UI 图标       | 自定义 `Icon` 组件（SVG 集合）                                  |
| Markdown 渲染 | react-markdown（gfm / math / katex）                           |
| 国际化        | i18next + react-i18next                                       |
| 后端语言      | Rust（tauri 2.11, edition 2021）                               |
| 后端主要依赖  | reqwest / tokio / rusqlite / zip / keyring                     |
| 后端存储      | 本地 JSON 文件（AppData）                                      |
| 前端单元测试  | Vitest 4.1 + jsdom + @testing-library/react                   |
| E2E 测试      | Playwright 1.61                                               |
| 后端测试      | `cargo test`                                                  |

## 3. 开发环境要求

- Node.js >= 18
- Rust >= 1.77.2
- Tauri CLI（可选，项目内已有 `@tauri-apps/cli`）

安装前端依赖：

```bash
npm install
```

## 4. 项目结构

```
.
├── docs/                              # 产品设计文档
│   ├── PRD.md                         # 产品需求文档（v0.5）
│   ├── AGENT_TOOLS_DESIGN.md          # 完整目标架构设计（Tools / Clause 索引等）
│   └── LLM_PLATFORM_COMPATIBILITY.md  # 各 LLM 平台 OpenAI 兼容性调研
├── src/                               # 前端源码
│   ├── App.tsx                        # 应用顶层：编排 hooks、双栏布局、wizard / focusedViewer / pdfCacheRef
│   ├── App.css                        # 全局样式（reset、壳层布局、tab 栏、分割条、icon-btn 基础样式）
│   ├── main.tsx                       # React 入口（ErrorBoundary 顶层包裹）
│   ├── vite-env.d.ts                  # Vite 类型声明
│   ├── components/                    # React 组件（每个组件配同名 {Component}.css，由组件文件顶部 import）
│   │   ├── PdfViewer.tsx              # PDF 渲染协调层、选区、单页/连续模式、键盘导航
│   │   ├── PdfPage.tsx                # 单页渲染（canvas / textLayer / 悬停取词）
│   │   ├── PdfAnnotations.tsx         # 按页渲染 markers 与 popup
│   │   ├── AnnotationMarker.tsx       # 可拖动的翻译/解读/暂存/批注标记
│   │   ├── SelectionToolbar.tsx       # 选区上方浮动工具条（暂存/解读/翻译/复制/批注）
│   │   ├── TranslatePopup.tsx         # 翻译浮层
│   │   ├── ExplainPopup.tsx           # 解读详情浮层
│   │   ├── CommentPopup.tsx           # 批注浮层（拖动编辑、300ms 防抖保存、隐藏/删除）
│   │   ├── StashInterpretedPopup.tsx  # 已解读暂存浮层
│   │   ├── AiChatPanel.tsx            # 右侧面板（暂存区、解读记录、流式中止）
│   │   ├── ContextWidget.tsx          # 会话上下文用量条（数据源 activeSession.lastPromptTokens；frozen 态为预留半成品）
│   │   ├── MarkdownRenderer.tsx       # react-markdown + gfm/math/katex，自定义 sanitize schema，公式解析失败降级纯文本
│   │   ├── ThinkingIndicator.tsx      # 思考中/已思考 tokens 指示（可展开 reasoningContent）
│   │   ├── SettingsModal.tsx          # 全局设置 Modal（左侧分页：模型设置 / 功能设置 / 系统设置 / 关于）
│   │   ├── SetupWizard.tsx            # 首次启动配置向导（选平台 → 填 Key → 测试连接）
│   │   ├── TitleBar.tsx               # 自定义标题栏（data-tauri-drag-region + RecentFilesBar + 窗口控制）
│   │   ├── RecentFilesBar.tsx         # 最近文件：触发按钮 + 下拉面板（置顶/搜索/分屏打开）
│   │   ├── CustomInterpretModal.tsx   # 自定义解读弹窗
│   │   ├── ToolCallsIndicator.tsx     # 工具调用状态指示器（解读流中展示）
│   │   ├── WordTooltip.tsx            # 悬停单词翻译 tooltip
│   │   ├── ErrorBoundary.tsx          # 顶层错误边界
│   │   ├── ErrorBanner.tsx            # 错误横幅（预留，当前未接入）
│   │   └── Icon.tsx                   # SVG 图标组件
│   ├── hooks/                         # 可复用状态逻辑
│   │   ├── useTabs.ts                 # Tab 管理
│   │   ├── usePersistence.ts          # 批注/会话/暂存状态与持久化（含 Agent loop runSessionStream）
│   │   ├── useRightPanelLayout.ts     # 右侧面板布局
│   │   ├── useRecentFiles.ts          # 最近文件列表（置顶/单条移除/lastPage 回写/配额）
│   │   ├── useSplitView.ts            # 双排视图状态
│   │   ├── useDictionaryStatus.tsx    # 本地词典下载状态与进度
│   │   ├── useWordLookup.ts           # 悬停取词查词逻辑（PdfPage 使用）
│   │   ├── usePdfDocument.ts          # PDF 加载/缓存/大纲
│   │   ├── useViewportManager.ts      # viewport 预加载/可见页/wrapper refs/自加载回写（条目带 scale）
│   │   ├── useZoomAnchor.ts           # 缩放锚点捕获与恢复
│   │   ├── useSearchDomain.ts         # 搜索索引/高亮/导航（跨 text item 短语匹配，PDF 原始坐标）
│   │   ├── useScrollPageSync.ts       # 连续滚动页码同步（含换页死区）+ scrollTop 上报
│   │   ├── useTabRestore.ts           # tab 状态恢复 + pending 页跳转
│   │   ├── useDrag.ts                 # 通用拖拽（全局监听 + 阈值）
│   │   ├── useClampedPopupPosition.ts # 浮层 clamp 定位（支持 yPercent）
│   │   ├── useStreaming.ts            # LLM 流式输出状态
│   │   └── useModal.ts                # Modal 通用逻辑
│   ├── i18n/                          # i18next 初始化（index.ts，lng 硬编码 zh-CN）
│   ├── locales/                       # zh-CN.json / en.json（顶层 key 分组一致，en 为预埋）
│   ├── data/
│   │   └── platformPresets.ts         # LLM 平台预设（8 个，见 6.3）
│   ├── types/
│   │   └── llm.ts                     # LLM 相关类型（LlmProfile 等多 profile 类型为前瞻预留、未落地）
│   ├── utils/                         # 纯函数工具
│   │   ├── coordinateConverter.ts     # PDF↔wrapper↔screen 坐标转换
│   │   ├── zoomAnchor.ts              # 缩放锚点几何计算
│   │   ├── fitToWidth.ts              # 适合宽度 scale 计算
│   │   ├── popupPosition.ts           # 浮层定位 clamp 计算
│   │   ├── clipboard.ts               # 复制到剪贴板（navigator.clipboard + execCommand 回退）
│   │   ├── time.ts                    # 相对时间格式化（最近文件列表）
│   │   └── path.ts                    # 路径工具（basename/dirname/中间省略）
│   ├── services/                      # 业务逻辑与 Tauri 命令封装
│   │   ├── annotations.ts             # Annotation 类型（含 "comment"）+ CRUD + 持久化调用
│   │   ├── settings.ts                # 应用设置 CRUD、PlatformId 联合类型、checkApiKey/deleteApiKey
│   │   ├── dictionary.ts              # ECDICT 本地词典查询与下载进度监听
│   │   ├── llm.ts                     # streamChatCompletion（Channel 桥接后端代理）、Prompt 模板（i18n 化）
│   │   ├── pdfToolsRegistry.ts        # 当前打开 PDF 的轻量元数据注册表（Agent Tools 授权数据源）
│   │   ├── pdfTools.ts                # Agent Tools 执行层（瞬态 ToolSession）
│   │   ├── recentFiles.ts             # 最近文件 CRUD + 文件存在性检查
│   │   ├── sessions.ts                # 解读会话数据结构与管理
│   │   ├── stash.ts                   # 暂存片段数据结构与管理
│   │   ├── selection.ts               # SelectionState 类型
│   │   ├── dialog.ts                  # plugin-dialog 确认/消息框封装
│   │   ├── logs.ts                    # plugin-log 五级日志（所有消息先经 redactSensitiveInfo 脱敏 sk-/Bearer/主目录路径）
│   │   └── updater.ts                 # plugin-updater + plugin-process：checkForUpdate/checkUpdateInfo/installUpdate
│   └── test/                          # 测试工具
│       ├── setup.ts                   # Vitest 全局 setup / mock
│       └── mocks/tauri.ts             # mockTauriInvoke 辅助函数
├── src-tauri/                         # Tauri Rust 后端
│   ├── src/
│   │   ├── lib.rs                     # Tauri 命令注册与数据持久化（见 6.1）
│   │   ├── llm_proxy.rs               # LLM 请求后端代理（chat_completions_stream 等）+ 工具 schema
│   │   ├── dictionary.rs              # ECDICT 本地词典下载（断点续传）、解压、查询
│   │   ├── paths.rs                   # AppData 路径（app_data_dir()）+ 旧目录递归迁移
│   │   ├── secure_storage.rs          # ApiKeyStorage trait + KeyringStorage / MemoryStorage（API Key 按平台分条目）
│   │   └── main.rs                    # 后端入口
│   ├── capabilities/                  # Tauri 权限配置
│   ├── icons/                         # 应用图标
│   ├── Cargo.toml
│   └── tauri.conf.json                # 窗口（decorations: false）、CSP、updater 插件、构建打包配置
├── e2e/                               # Playwright E2E 测试
│   ├── fixtures/                      # 测试用 PDF（含 60 页大文档 sample-long.pdf）
│   ├── app.spec.ts                    # 主布局 / 面板显隐 / 设置
│   ├── multi-tab-state.spec.ts        # 多 tab 状态隔离
│   ├── pdf-large-doc.spec.ts          # 大文档 fit 不偏移 / 深度缩放页码稳定 / 快速切 tab 恢复
│   ├── pdf-page-jump.spec.ts          # 连续滚动页码跳转
│   ├── pdf-rapid-zoom.spec.ts         # 快速缩放回归
│   └── pdf-selection-translate.spec.ts # 选区翻译流程
├── scripts/                           # 辅助脚本
│   ├── gen-sample-pdf.mjs             # 生成测试 PDF
│   ├── gen-sample-short-pdf.mjs       # 生成短页测试 PDF
│   ├── gen-sample-long-pdf.mjs        # 生成 60 页大文档测试 PDF
│   ├── bump-version.mjs               # 同步 package.json / Cargo.toml / tauri.conf.json 版本号
│   └── prepare-release.mjs            # 发布前固化 CHANGELOG 版本段落并提取 Release notes
├── CHANGELOG.md                       # 版本变更记录（GitHub Release notes 来源）
├── package.json
├── vite.config.ts                     # Vite + Vitest 配置
├── playwright.config.ts               # Playwright 配置
├── tsconfig.json                      # 前端 TS 配置
├── tsconfig.node.json                 # Vite 配置文件的 TS 项目引用
└── index.html
```

## 5. 构建与运行命令

### 5.1 开发

```bash
# 仅启动 Vite 前端开发服务器（端口 1420）
npm run dev

# 启动 Tauri 桌面应用开发模式
npm run tauri-dev
```

`tauri dev` 会先启动 `npm run dev`，再拉起 Rust 窗口。

### 5.2 构建

```bash
# 构建前端生产包到 dist/
npm run build

# 构建完整桌面应用安装包（nsis / dmg / app）
npm run tauri-build

# 仅构建可执行文件（CI 发布模式，不生成安装包）
npm run tauri build -- --no-bundle
```

### 5.3 发版流程

通过 GitHub Actions 手动触发一键发布（`.github/workflows/release.yml`），当前仅发布 Windows 安装包与可执行文件，不进行 Windows 代码签名。

1. 开发过程中把变更记录到 `CHANGELOG.md` 的 `## [Unreleased]` 段落下（发布时为空则流程失败，不会打 tag）。
2. GitHub 仓库 → Actions → Release → Run workflow，输入版本号（如 `0.8.2`）。
3. workflow 自动：
   - 运行快速门禁（type-check / lint / 单元测试），失败即终止。
   - 用 `scripts/bump-version.mjs` 同步 `package.json` / `Cargo.toml` / `tauri.conf.json` 版本号。
   - 用 `scripts/prepare-release.mjs` 把 CHANGELOG 的 `[Unreleased]` 固化为 `## [x.y.z] - 日期` 段落，并提取该段落作为 Release notes。
   - commit（`release: vx.y.z`）+ 打 tag 并 push 到 master。
   - 在 Windows runner 用 `tauri-action` 构建 NSIS 安装包，自动生成 `.sig` 与 `latest.json`，创建 **Draft Release**（notes 取自 CHANGELOG 对应段落），并附加独立 exe `SpecReader AI v{version}.exe`。
4. 下载 Draft Release 中的安装包人工冒烟测试，确认无误后在 Release 页面点击 Publish。发布后 `latest.json` 生效，客户端启动 3 秒后自动检查发现新版本并提示下载重启。

> 注意：Tauri 更新包签名私钥保存在 `~/.tauri/specreader.key`，需配置为 GitHub Secret `TAURI_SIGNING_PRIVATE_KEY`。

### 5.4 测试与代码质量

```bash
# 前端单元 / 集成测试
npm run test

# 监听模式
npm run test:watch

# 覆盖率报告
npm run test:coverage

# E2E 测试（自动启动 Vite dev server）
npm run test:e2e

# E2E UI 模式
npm run test:e2e:ui

# 依次运行单元测试与 E2E 测试
npm run test:all

# TypeScript 类型检查
npm run type-check

# ESLint 代码检查
npm run lint

# Prettier 格式检查
npm run format:check

# 后端 Rust 测试
cd src-tauri && cargo test
```

## 6. 运行时架构

### 6.1 前端 - 后端边界

所有前端与 Rust 后端的通信均通过 Tauri `invoke` 完成，封装在 `src/services/*.ts` 中。

当前暴露的命令：

- `read_pdf_bytes(filePath: string)`：读取 PDF 原始字节。
- `get_pdf_hash(filePath: string)`：计算 PDF SHA-256 hash。
- `load_pdf_data(filePath: string)`：加载 `<AppData>/SpecReader/annotations/{hash}.json`。
- `save_pdf_data(filePath: string, data: PdfData)`：保存批注与会话引用。
- `load_session(sessionId: string)`：加载单个会话 JSON。
- `save_session(session: InterpretationSession)`：保存会话 JSON。
- `delete_session(sessionId: string)`：删除会话文件。
- `authorize_pdf_path(filePath: string)`：将用户通过对话框选择的 PDF 路径加入后端授权白名单，`read_pdf_bytes` / `get_pdf_hash` 会校验该白名单。
- `load_settings()` / `save_settings(settings: AppSettings)`：加载 / 保存应用设置（LLM 平台/模型 + 目标语言 + Agent Tools 总开关 + 悬停翻译开关 + 日志级别）；`load_settings` 返回前强制 `apiKey=""`，Key 只经系统钥匙串按平台读写。
- `load_recent_files()` / `save_recent_files(files: RecentFile[])`：加载 / 保存最近打开文件列表（`RecentFile` 含 `pinned` 置顶与 `lastPage` 阅读页码字段，旧数据通过 `#[serde(default)]` 兼容）。
- `check_files_exist(paths: string[])`：批量检查文件是否仍存在于磁盘，最近文件面板用它置灰已移动/删除的条目。
- `open_path(path: string)`：仅允许打开 `http://` / `https://` URL，禁止本地文件路径与目录。
- `open_logs_dir()`：打开应用日志目录，供用户导出排查。
- `check_dictionary()`：检查本地 ECDICT 词典是否存在及大小。
- `download_dictionary()`：下载 ECDICT SQLite 词典（支持断点续传），通过 `dictionary-download-progress` event 推送进度。
- `lookup_word(word: string)`：查询单词释义。
- `open_default_apps_settings()`：打开系统默认应用设置页（Windows），配合 PDF 文件关联引导。
- `check_api_key(platform_id)` / `delete_api_key(platform_id)`：按平台检查 / 删除钥匙串中的 API Key；key 按平台分条目存储（`llm_api_key_{platform_id}`，`secure_storage.rs`），旧单条目 `llm_api_key` 透明迁移。
- `chat_completions_stream(params, onEvent: Channel<StreamEvent>)`：LLM 请求后端代理（`llm_proxy.rs`），见 6.3。
- `cancel_chat_completions(request_id)`：中止进行中的 LLM 流。
- `test_connection(...)`：测试当前平台配置连通性（配置向导与设置页使用）。
- `take_pending_open_pdfs()`：返回并清空后端缓存的冷启动待打开 PDF 路径（前端在 `open-pdf` listener 注册完成后调用一次）。

### 6.2 数据持久化

后端将数据存在 **AppData** 目录下，根目录由 `src-tauri/src/paths.rs` 的 `app_data_dir()` 统一返回 `<AppData>/SpecReader`；因 bundle identifier 变更，首次访问会把旧目录 `<data_dir>/photonee/SpecReader` 递归迁移到新位置：

```
<AppData>/
└── SpecReader/
    ├── annotations/
    │   ├── {pdf_hash}.json        # 批注 + 关联 session ids
    │   └── sessions/
    │       └── {session_id}.json  # 解读会话详情
    ├── dict/
    │   ├── ecdict.sqlite          # ECDICT 本地离线词典（首次启用悬停翻译时下载）
    │   └── ecdict.sqlite.extract/ # 解压临时目录
    ├── logs/
    │   └── app.log                # 应用运行日志（默认 Warn 级别，可在设置中调整，保留最近 3 个文件各 10 MB）
    ├── settings.json              # LLM 平台/模型 + 目标语言 + Agent Tools 开关 + 悬停翻译开关 + 日志级别
    └── recent_files.json          # 最近打开文件列表
```

- 批注坐标以 **PDF 原始坐标（scale=1）**保存，渲染时乘以当前 scale。
- 文件 hash 用于识别同一 PDF，重命名不影响恢复。
- 旧版格式是纯 annotation 数组，后端仍兼容读取。

### 6.3 LLM 调用

LLM 流量已整体改为 **Rust 后端代理**（`src-tauri/src/llm_proxy.rs`），前端不再直接发起 HTTP 请求：

- 前端 `services/llm.ts` 的 `streamChatCompletion` 通过 `invoke("chat_completions_stream", { params, onEvent: Channel })` 建立流，AsyncGenerator 桥接 Channel 事件；abort 走 `cancel_chat_completions`。
- 后端从磁盘 settings 读 baseUrl / model、按 `platformId` 从钥匙串读 API Key，reqwest 流式 POST 后经 `tauri::ipc::Channel<StreamEvent>` 逐事件推给前端；SSE tool_call 片段按 `index` 累积，`finish_reason` 时一次性下发完整 toolCall。
- **API Key 不暴露给 webview**：`load_settings` 返回前强制 `apiKey=""`，旧版明文 key 自动迁移进钥匙串后从磁盘清除；`save_settings` 收到非空 key 只写钥匙串，钥匙串不可用则拒绝保存。
- Prompt 模板（`buildSelectionPrompt` 翻译/解读、`buildCustomInterpretPrompt` 自定义解读、`buildSystemPrompt`）仍在 `services/llm.ts`，已 i18n 化（走 `i18n.t`，模板文案在 locales JSON）；均接收 `targetLanguage` 参数。启用 Agent Tools 时 system prompt 追加 `llm.toolsSystemAddendum` 工具使用引导段（与用户可编辑 system prompt 解耦）。
- LLM 配置与目标语言通过 `services/settings.ts` 持久化到后端 AppData；首次启动时会从旧的 `localStorage` 键 `standardread-llm-config` 迁移一次。
- 平台预设集中在 `src/data/platformPresets.ts`（8 个：`deepseek` / `kimi` / `bailian` / `glm` / `volcengine` / `openrouter` / `openai` / `custom`，含 `supportsTools` / `supportsThinking` / `contextWindow` / `apiKeyHelpUrl` 等字段）；`PlatformId` 联合类型在 `services/settings.ts` 有一份需与预设同步。默认平台 `deepseek`、默认模型 `deepseek-v4-flash`，默认目标语言为 `中文`。

### 6.4 核心状态流

```
App.tsx（编排层，具体状态已下沉到 hooks）
├── useTabs：tabs / activeTabId / secondaryTabId   # PDF Tab 状态（单视图 + 并排视图）
├── usePersistence：annotations / sessions / stashes / selection
├── useRightPanelLayout：rightVisible / rightPanelWidth
├── useRecentFiles：recentFiles
├── useSplitView：splitPct                         # 并排视图左右面板比例
├── settings / settingsOpen                        # 全局设置与 Modal
├── dictionaryStatus                               # 本地 ECDICT 词典状态（存在性、下载进度）
├── wizardOpen                                     # 首次启动配置向导（settings 加载后对全部平台 checkApiKey，全未配置才自动弹出；设置里可重跑）
├── focusedViewer                                  # 分屏时决定选区消费（浮动工具条/暂存/解读）跟随哪个屏；面板暂存与解读记录为双屏合并显示
└── pdfCacheRef                                    # App 级 PDF bytes 缓存（filePath→Uint8Array），同步给 syncOpenPdfs

App.tsx 还接入：
├── TitleBar            # 自定义标题栏（品牌区 data-tauri-drag-region + RecentFilesBar + 打开PDF/设置 + 窗口控制）
├── SetupWizard         # 首次启动配置向导
├── updater             # 启动 3 秒后 checkForUpdate，失败仅记日志；设置「关于」页可手动检查
└── `open-pdf` 系统事件监听 + `take_pending_open_pdfs`（单实例 / 文件关联打开 PDF，含冷启动补取）
（main.tsx 顶层以 ErrorBoundary 包裹整个应用）

PdfViewer.tsx（协调层：UI + 组合 hooks）
├── usePdfDocument                      # pdf / numPages / isLoading / outline
├── useViewportManager                  # pageViewports / visiblePages / 预加载
├── useZoomAnchor                       # 缩放锚点（isZooming 抑制）
├── useSearchDomain                     # 跨 text item 短语搜索索引/高亮/导航（PDF 原始坐标）
├── useScrollPageSync                   # 滚动页码同步 + scrollTop 上报
├── useTabRestore                       # tab 状态恢复 + pending 跳转
├── pageNum / scale / viewMode          # 本组件持有的三要素状态
├── 文本选区 → onSelection
└── PdfPage                             # 单页渲染组件；悬停取词（useWordLookup + WordTooltip）已下沉到 PdfPage

AiChatPanel.tsx
├── expandedId / expandedStashIds
└── 检测到 isStreaming 会话时启动流；展示最终 assistant 消息上的 `toolEvents`

ToolCallsIndicator.tsx
└── 工具调用状态指示器：running / done / 折叠明细

SettingsModal.tsx
└── 左侧分页设置弹窗：模型设置（平台/模型/Key）、功能设置（语言/悬停翻译/Agent Tools 开关（默认关闭，开启后显示 maxToolRounds 轮次设置）/系统提示词）、系统设置（日志/默认打开方式/重跑向导）、关于（版本/软件更新/License）
```

### 6.5 Agent Tools 工作流

仅作用于 **解读 / 自定义解读 / 追问**（翻译不启用）：

```
runSessionStream（usePersistence.ts）
├── toolsEnabled = agentToolsEnabled && preset.supportsTools && action ∈ {explain, custom}
├── 若启用：beginToolSession() 创建瞬态 ToolSession（finally 中 dispose）
├── 每轮 streamChatCompletion 可能返回 toolCall 事件
│   └── onToolCall 更新最终 assistant 消息的 toolEvents（running）
├── 轮次结束有 toolCalls 且未达 maxToolRounds：
│   ├── 插入 assistant(toolCalls + reasoningContent) 消息并落盘
│   ├── 执行 toolSession.executeToolCall（同参去重，错误转文本）
│   ├── 更新 toolEvents 为 done
│   └── 插入 tool(toolCallId, content) 消息并落盘 → 进入下一轮
└── 无 toolCalls 或达轮次上限：收尾，写入累计 usage，finishStreaming
```

- PDF 文档实例为**瞬态**：每个 agent loop 内按需懒建 `PDFDocumentProxy`，loop 结束 `dispose` 销毁；不与 viewer 共享，避免切 tab 时生命周期耦合。
- 授权边界：白名单由前端 `pdfToolsRegistry.ts` 执行，只保留当前打开 tab 的轻量元数据（`fileHash` / `fileName` / `filePath` / `numPages`），工具只服务登记在册的 hash；`getPdfBytes` 优先复用 App 级 bytes 缓存，未命中时回退 `read_pdf_bytes`。（后端 `StreamParams.authorized_file_hashes` 为保留字段，未启用。）
- 工具消息（assistant-tool + tool result）会持久化到会话，追问时原样回放，并携带 `toolCalls` / `toolCallId` / `reasoningContent`。
- 轮次上限：`settings.maxToolRounds`（默认 **20**，见 `settings.ts` 的 `DEFAULT_SETTINGS`；UI 输入最小值 1）。
- 超限优雅收尾：最后一轮把 tool 消息改写为 user 上下文、剥掉 assistant `toolCalls` 并追加 system 指令（i18n key `llm.toolLimitFinalInstruction`）；若模型仍返回 toolCalls 且无正文，用 `llm.toolLimitReachedFallback` 文案兜底。
- 降级：总开关关闭或平台 `supportsTools=false` 时行为同未启用工具的旧流程。

## 7. 代码组织约定

### 7.1 文件组织

- 每个 React 组件单独文件，同文件可包含私有子组件。
- 组件单元测试与组件同目录，命名 `{Component}.test.tsx`。
- 纯业务逻辑放在 `services/`，并配套 `{service}.test.ts`。
- 类型定义优先放在消费侧（如 `services/annotations.ts` 中定义 `Annotation`）。

### 7.2 命名与风格

- React 组件使用 **PascalCase**。
- 文件路径、函数、变量使用 **camelCase**。
- 类型 / 接口使用 **PascalCase**。
- Hook 与工具函数优先使用 `useCallback` / `useMemo` 避免不必要重渲染，尤其是传给子组件的回调。
- 副作用使用 `useEffect`，并注意清理（定时器、事件监听、IntersectionObserver、render task cancel）。

### 7.3 TypeScript

- `tsconfig.json` 开启 `strict`、`noUnusedLocals`、`noUnusedParameters`、`noFallthroughCasesInSwitch`。
- 模块为 `ESNext` + `bundler` 解析。
- 不要添加未使用的 import 或变量，否则会编译失败。

### 7.4 CSS

- 全局样式（reset、壳层布局、tab 栏、分割条、icon-btn 基础样式）集中在 `src/App.css`（已收缩）。
- 每个组件另有同名 `{Component}.css`，由组件文件顶部 `import`；未使用 CSS Modules / Tailwind。
- 类名使用连字符（kebab-case），状态类如 `.active`、`.expanded`、`.streaming`、`.highlighted`。

### 7.5 注释

- 复杂交互逻辑（如连续滚动页码检测、跳转锁）需要写清楚原因。
- 中文注释与文档保持一致。

## 8. 测试策略

### 8.1 前端单元 / 集成测试

- **Vitest** 配置在 `vite.config.ts`：
  - `globals: true`
  - `environment: "jsdom"`
  - setup 文件：`src/test/setup.ts`
  - 匹配：`src/**/*.{test,spec}.{ts,tsx}`
  - 覆盖率 provider：`v8`
- 测试文件已 40+ 个，与源码同目录（`{name}.test.ts(x)`），按类别概括：
  - `services/`：annotations / settings / llm（Channel 流桥接、Prompt 构建）/ sessions / stash / pdfTools / pdfToolsRegistry / updater / clipboard 等，覆盖 CRUD、invoke mock、错误转文本、白名单拒绝等路径。
  - `hooks/`：usePersistence（Agent loop 全流程、流式中断、tab 清理）、useViewportManager / useZoomAnchor / useScrollPageSync / useTabRestore / useSearchDomain（页码、缩放、恢复回归的重灾区）、useRecentFiles / useSplitView / useDrag 等。
  - `components/`：PdfViewer（pageJump / state）、PdfPage、AiChatPanel、SettingsModal、RecentFilesBar、SelectionToolbar、AnnotationMarker、ToolCallsIndicator、SetupWizard 等渲染与交互。
  - `utils/`：coordinateConverter / zoomAnchor / fitToWidth / popupPosition / clipboard 等纯函数基准。
  - 完整清单直接看代码内 `*.test.*` 文件与 `TESTING.md`（含历史 bug 修复记录）。
- Mock 策略：
  - `setup.ts` 中全局 mock `crypto.randomUUID`、`localStorage`、`matchMedia`、`IntersectionObserver`、`ResizeObserver`。
  - 相关测试用 `vi.doMock("@tauri-apps/api/core")` mock `invoke`。
  - `App.test.tsx` mock `PdfViewer` 避免加载 pdfjs-dist。
  - `AiChatPanel.test.tsx` mock `streamChatCompletion`。
  - 涉及悬停翻译的测试还需 mock `@tauri-apps/api/event` 的 `listen`，并为 `check_dictionary` / `download_dictionary` 提供 handler。

### 8.2 E2E 测试

- Playwright 启动 `npm run dev` 作为 webServer，访问 `http://localhost:1420`，共 6 个 spec：
  - `app.spec.ts`：主布局、顶部最近文件入口、设置 Modal、面板显隐。
  - `pdf-page-jump.spec.ts`：连续滚动模式下页码跳转正确性，使用 mock 的 Tauri `invoke` 返回 PDF 字节。
  - `multi-tab-state.spec.ts`：多 tab 页码/批注隔离、关闭 tab 后状态保持。
  - `pdf-large-doc.spec.ts`：>50 页大文档回归——适合宽度不横向偏移、深度缩放页码不抖动、快速切换 tab 恢复页码（fixtures 含 `gen-sample-long-pdf.mjs` 生成的 60 页 PDF）。
  - `pdf-rapid-zoom.spec.ts`：快速缩放回归。
  - `pdf-selection-translate.spec.ts`：选区翻译流程。
- 单实例与文件关联需在打包后的安装包上手动验证，E2E 较难覆盖。

### 8.3 后端测试

- `src-tauri/src/lib.rs` 包含 `#[cfg(test)]` 模块。
- 覆盖：hash 计算、annotation 路径确定性、批注持久化往返、旧格式兼容、会话 CRUD、session id 路径穿越防护、PDF 路径授权、原子文件写入、最近文件 pinned/lastPage 字段兼容、`check_files_exist` 存在性判断、`check_dictionary` / `lookup_word` 非阻塞 I/O。
- `src-tauri/src/secure_storage.rs` 包含 `MemoryStorage` 测试实现，覆盖 API Key 钥匙串存取、失败降级。
- 纯逻辑与 `tauri::AppHandle` 解耦，便于测试。

## 9. 安全与隐私注意事项

- **PDF 不上传云端**：文件仅在本地读取和渲染。
- **仅主动选择的内容发送给 LLM**：翻译 / 解读只发送用户选中的文本片段，不会自动上传整篇文档。
- **API Key 存储**：API Key 通过 Rust `keyring` crate 按平台分条目存入系统钥匙串（`llm_api_key_{platform_id}`，旧单条目自动迁移）；`settings.json` 中只保留空占位，且 `load_settings` 返回前强制 `apiKey=""`，Key 不回传 webview（LLM 请求走后端代理）。钥匙串不可用时 `save_settings` 会明确拒绝保存并返回错误，不回退明文存储。
- **不要在前端日志中打印 API Key 或完整文件内容**；`services/logs.ts` 的 `redactSensitiveInfo` 会统一脱敏 `sk-` / `Bearer` / 主目录路径。
- Tauri CSP 已配置（`tauri.conf.json`：`default-src 'self'`；`connect-src 'self'` + localhost + `https:` 等），引入新的外部资源时需同步收紧。

## 10. 常见改动注意事项

### 10.1 修改 Tauri 命令

1. 在 `src-tauri/src/lib.rs` 添加 `#[tauri::command]` 函数。
2. 在 `run()` 的 `generate_handler![...]` 中注册。
3. 在 `src/services/*.ts` 中封装 TypeScript 调用。
4. 如有需要，在 `src/test/mocks/tauri.ts` 或相关测试中添加 mock handler。

### 10.2 修改数据模型

- Rust 与 TypeScript 的 `Annotation`、`InterpretationSession`、`StashSource`、`AppSettings`、`RecentFile` 等类型需要**保持同步**。
- 新增字段尽量使用 `#[serde(default)]` 和 `?` / `skip_serializing_if`，保持旧数据兼容。
- 如需破坏性变更，请同时编写旧数据迁移逻辑。

### 10.3 修改本地词典

- ECDICT 下载源、临时文件路径、最终文件路径集中在 `src-tauri/src/dictionary.rs` 顶部常量；`SPECREADER_DICT_URL` 环境变量可覆盖下载源。
- 下载支持断点续传：依赖服务器 `Accept-Ranges: bytes`，临时文件为 `ecdict.sqlite.zip.tmp`，最终文件为 `dict/ecdict.sqlite`（解压临时目录 `ecdict.sqlite.extract/`）。
- 下载过程带重试机制：单块读取超时、连接中断或服务器返回非成功状态码时，会自动从已下载位置重试最多 5 次，并继续通过 `dictionary-download-progress` event 推送进度。
- 解压防 zip 炸弹：总解压大小上限 1.5GB；预留 sha256 校验常量（当前为空串，跳过校验）。
- 解压后的 SQLite 文件通过文件头魔数 `SQLite format 3\0` 定位，不依赖 zip 内的文件名（避免中文文件名编码问题）。
- 替换词库时，建议同时删除旧 `ecdict.sqlite` 与 `.tmp`，并清空 `DICT_CONNECTION` 缓存。

### 10.4 修改 Prompt

- Prompt 模板函数集中在 `src/services/llm.ts`，模板文案已 i18n 化，实际文案在 `locales/zh-CN.json` / `en.json` 的 `llm.*` 段，改文案需两边同步。
- 修改后检查 `services/llm.test.ts` 中相关断言是否仍然成立。

### 10.5 修改 UI 布局

- 双栏宽度、最小宽度、默认比例等常量在 `App.tsx` 顶部：
  - `MIN_PANEL_WIDTH = 240`
  - `RIGHT_PANEL_MIN_WIDTH = 180`
  - `RIGHT_PANEL_DEFAULT_FRACTION = 3 / 8`
- 连续滚动相关常量（padding、spacing）同时在 `PdfViewer.tsx` 与 CSS 中定义，修改时需两边同步。

### 10.6 修改 Agent Tools

- 工具 schema 与累积逻辑在后端 `src-tauri/src/llm_proxy.rs`；工具名固定 snake_case（`list_open_pdfs` / `read_pdf_page` / `search_in_pdf`，定义在 `builtin_tools()`），新增/修改工具需同步前端 `pdfTools.ts`。
- 前端工具实现在 `src/services/pdfTools.ts`；任何错误都应捕获并转为 result 文本，不得向 loop 抛异常。
- 授权与元数据在 `src/services/pdfToolsRegistry.ts`；`App.tsx` 通过 `syncOpenPdfs(tabs, getCachedBytes)` 同步当前打开 tab。修改注册表接口时需同步 `App.tsx` 调用点与 `pdfToolsRegistry.test.ts`。
- Agent loop 在 `hooks/usePersistence.ts` 的 `runSessionStream`；修改轮次、去重、收尾逻辑时需同步 `usePersistence.test.tsx`。
- UI 状态组件为 `components/ToolCallsIndicator.tsx`；样式在同名 `ToolCallsIndicator.css`。
- 相关 i18n key 在 `locales/zh-CN.json` / `en.json` 的 `tools.*` 与 `llm.toolsSystemAddendum` 段，修改后需两边同步。

## 11. 持续集成

CI 分层触发，避免每次 push 都跑全量：

| Workflow       | 触发                               | 内容                                                                                                             |
| -------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `ci-quick.yml` | 非 master 分支 push                | type-check / lint / 单元测试（目标 < 5 分钟）                                                                    |
| `ci-full.yml`  | master push / PR                   | 上述全部 + 前端 build + cargo test / clippy / audit + 双浏览器 E2E + npm audit（三个 job 并行，Rust 依赖有缓存） |
| `release.yml`  | 手动 dispatch（输入版本号）        | 一键发布，见 5.3 发版流程                                                                                        |
| `landing.yml`  | master 上 `landing/**` 变更 / 手动 | 部署 GitHub Pages                                                                                                |

约定：

- `docs/**`、`landing/**`、`**.md` 的变更不触发 CI（paths-ignore）。
- 审计类检查（npm audit / cargo audit）只在 master 集成时运行，不作为日常 push 门禁；cargo-audit 通过 `taiki-e/install-action` 安装预编译二进制。
- 每个 workflow 都配置了 concurrency 自动取消同分支的旧 run。

本地仍可单独运行各层测试以加快反馈：

```bash
npm ci
npx playwright install chromium
npm run test
npm run test:e2e
cd src-tauri && cargo test
```

## 12. 参考文档

- `docs/PRD.md`：产品需求、MVP 范围、数据模型。
- `docs/AGENT_TOOLS_DESIGN.md`：完整目标架构（Tools、Clause 索引、术语表、测试清单、表格多模态读取）。
- `docs/LLM_PLATFORM_COMPATIBILITY.md`：各 LLM 平台 OpenAI 兼容性调研（平台预设参考）。
- `TESTING.md`：详细测试说明与已发现的 bug 修复记录。
- `README.md`：快速开始与项目简介。

## 13. 版本信息

- 前端版本：`0.9.5`
- Tauri 应用版本：`0.9.5`
- 产品名称：`SpecReader AI`
- 应用标识：`com.photonee.specreader`
