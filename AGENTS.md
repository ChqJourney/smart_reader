# SpecReader AI 项目指南

> 本文件供 AI coding agent 阅读，用于快速理解项目结构、技术栈、构建流程与开发约定。

## 1. 项目概述

**SpecReader AI**（内部代号 `pdf-standard-agent`）是一款面向检测认证工程师的桌面端 AI 助手，用于降低阅读、理解和执行 IEC / ISO / EN / GB / UL / ASTM / IEEE 等标准 PDF 文件时的认知与智力开销。

当前处于**「超轻量版」**，核心闭环为：

```
打开本地 PDF → 本地渲染 → 选中文本 → AI 翻译 / 解读
```

已实现能力：

- 多 PDF Tab 同时打开（最多 10 个），支持左右分屏并排对照两份 PDF。
- PDF 本地渲染、文本选区、缩放、页码跳转、单页 / 连续滚动阅读模式。
- 全文搜索（Ctrl / Cmd + F，结果逐页高亮、Enter / Shift+Enter 前后跳转）。
- 大纲 / 目录导航面板（PDF 自带 outline 时可用，点击跳转章节）。
- 选中文本后浮动工具条：加入暂存、解读、翻译。
- 翻译生成可拖动 / 隐藏 / 删除的浮层批注。
- 解读生成蓝色标记，并在右侧面板展示可点击跳转的解读记录，支持多轮追问。
- 自定义解读：把多个暂存片段一次性发给 LLM。暂存区支持选择模式勾选部分片段（未进入选择模式时默认全选）；解读要求弹窗仅能通过「取消」/「发送」关闭。
- 批注和解读记录按 PDF 文件 SHA-256 hash 持久化到本地 AppData。
- 最近文件下拉面板：置顶常用标准、按文件名/路径搜索、显示目录/相对时间/上次读到的页码、失效文件置灰、单条移除与两段式清空、从列表直接在分屏打开对照（快捷键 Ctrl/Cmd+Shift+O 开合面板）。
- 鼠标悬停英文单词显示本地 ECDICT 词典翻译（设置中可开关，首次启用需下载离线词典）。
- LLM 配置（Base URL、Model、目标语言等）保存于后端 AppData；API Key 单独存放于系统钥匙串（macOS Keychain / Windows Credential Manager / Linux Secret Service），不再落入 `settings.json`。

明确未实现（已规划到后续版本）：

- Clause 索引、引用追踪。
- 术语表、测试清单生成。
- 表格截图 + 多模态读取。
- License 激活校验。

## 2. 技术栈

| 层级          | 技术                                        |
| ------------- | ------------------------------------------- |
| 桌面框架      | Tauri 2.0（Rust 后端 + Web 前端）           |
| 前端框架      | React 18 + TypeScript 5.6                   |
| 构建工具      | Vite 6                                      |
| PDF 渲染      | pdfjs-dist 4.8                              |
| UI 图标       | 自定义 `Icon` 组件（SVG 集合）              |
| Markdown 渲染 | react-markdown                              |
| 后端语言      | Rust（tauri 2.11, edition 2021）            |
| 后端存储      | 本地 JSON 文件（AppData）                   |
| 前端单元测试  | Vitest 4.1 + jsdom + @testing-library/react |
| E2E 测试      | Playwright 1.61                             |
| 后端测试      | `cargo test`                                |

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
│   └── AGENT_TOOLS_DESIGN.md          # 完整目标架构设计（Tools / Clause 索引等）
├── src/                               # 前端源码
│   ├── App.tsx                        # 应用顶层：Tab 管理、双栏布局、批注/会话状态
│   ├── App.css                        # 全局样式
│   ├── main.tsx                       # React 入口
│   ├── vite-env.d.ts                  # Vite 类型声明
│   ├── components/                    # React 组件
│   │   ├── PdfViewer.tsx              # PDF 渲染、选区、单页/连续模式、键盘导航
│   │   ├── PdfAnnotations.tsx         # 按页渲染 markers 与 popup
│   │   ├── AnnotationMarker.tsx       # 可拖动的翻译/解读/暂存标记
│   │   ├── SelectionToolbar.tsx       # 选区上方浮动工具条
│   │   ├── TranslatePopup.tsx         # 翻译浮层
│   │   ├── ExplainPopup.tsx           # 解读详情浮层
│   │   ├── StashInterpretedPopup.tsx  # 已解读暂存浮层
│   │   ├── AiChatPanel.tsx            # 右侧面板（暂存区、解读记录、流式中止）
│   │   ├── SettingsModal.tsx          # 全局设置 Modal（左侧分页：模型设置 / 功能设置 / 系统设置 / 关于）
│   │   ├── RecentFilesBar.tsx         # 最近文件：顶栏触发按钮 + 下拉面板（置顶/搜索/分屏打开）
│   │   ├── CustomInterpretModal.tsx   # 自定义解读弹窗
│   │   ├── WordTooltip.tsx            # 悬停单词翻译 tooltip
│   │   └── Icon.tsx                   # SVG 图标组件
│   ├── hooks/                         # 可复用状态逻辑
│   │   ├── useTabs.ts                 # Tab 管理
│   │   ├── usePersistence.ts          # 批注/会话/暂存状态与持久化
│   │   ├── useRightPanelLayout.ts     # 右侧面板布局
│   │   ├── useRecentFiles.ts          # 最近文件列表（置顶/单条移除/lastPage 回写/配额）
│   │   ├── useSplitView.ts            # 双排视图状态
│   │   ├── useDictionaryStatus.tsx    # 本地词典下载状态与进度
│   │   ├── useWordLookup.ts           # 悬停取词查词逻辑
│   │   ├── usePdfDocument.ts          # PDF 加载/缓存/大纲（自 PdfViewer 抽出）
│   │   ├── useViewportManager.ts      # viewport 预加载/可见页/wrapper refs/自加载回写（条目带 scale）
│   │   ├── useZoomAnchor.ts           # 缩放锚点捕获与恢复
│   │   ├── useSearchDomain.ts         # 搜索索引/高亮/导航（PDF 原始坐标）
│   │   ├── useScrollPageSync.ts       # 连续滚动页码同步（含换页死区）+ scrollTop 上报
│   │   ├── useTabRestore.ts           # tab 状态恢复 + pending 页跳转
│   │   ├── useDrag.ts                 # 通用拖拽（全局监听 + 阈值）
│   │   ├── useClampedPopupPosition.ts # 浮层 clamp 定位（支持 yPercent）
│   │   ├── useStreaming.ts            # LLM 流式输出状态
│   │   └── useModal.ts                # Modal 通用逻辑
│   ├── utils/                         # 纯函数工具
│   │   ├── coordinateConverter.ts     # PDF↔wrapper↔screen 坐标转换
│   │   ├── zoomAnchor.ts              # 缩放锚点几何计算
│   │   ├── fitToWidth.ts              # 适合宽度 scale 计算
│   │   ├── popupPosition.ts           # 浮层定位 clamp 计算
│   │   ├── time.ts                    # 相对时间格式化（最近文件列表）
│   │   └── path.ts                    # 路径工具（basename/dirname/中间省略）
│   ├── services/                      # 业务逻辑与 Tauri 命令封装
│   │   ├── annotations.ts             # Annotation 类型 + CRUD + 持久化调用
│   │   ├── settings.ts                # 应用设置（LLM + 目标语言 + 悬停翻译开关）CRUD
│   │   ├── dictionary.ts              # ECDICT 本地词典查询与下载进度监听
│   │   ├── llm.ts                     # LLM 配置读取、SSE 流式请求、Prompt 模板
│   │   ├── recentFiles.ts             # 最近文件 CRUD + 文件存在性检查
│   │   ├── sessions.ts                # 解读会话数据结构与管理
│   │   └── stash.ts                   # 暂存片段数据结构与管理
│   └── test/                          # 测试工具
│       ├── setup.ts                   # Vitest 全局 setup / mock
│       └── mocks/tauri.ts             # mockTauriInvoke 辅助函数
├── src-tauri/                         # Tauri Rust 后端
│   ├── src/
│   │   ├── lib.rs                     # Tauri 命令：read_pdf_bytes / get_pdf_hash / load_pdf_data / save_pdf_data / load_session / save_session / delete_session / load_recent_files / save_recent_files / check_files_exist / check_dictionary / download_dictionary / lookup_word
│   │   ├── dictionary.rs              # ECDICT 本地词典下载（断点续传）、解压、查询
│   │   └── main.rs                    # 后端入口
│   ├── capabilities/                  # Tauri 权限配置
│   ├── icons/                         # 应用图标
│   ├── Cargo.toml
│   └── tauri.conf.json                # 应用窗口、构建、打包配置
├── e2e/                               # Playwright E2E 测试
│   ├── fixtures/                      # 测试用 PDF（含 60 页大文档 sample-long.pdf）
│   ├── app.spec.ts                    # 主布局 / 面板显隐 / 设置
│   ├── pdf-page-jump.spec.ts          # 连续滚动页码跳转
│   ├── multi-tab-state.spec.ts        # 多 tab 状态隔离
│   └── pdf-large-doc.spec.ts          # 大文档 fit 不偏移 / 深度缩放页码稳定 / 快速切 tab 恢复
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
- `load_settings()` / `save_settings(settings: AppSettings)`：加载 / 保存应用设置（LLM + 目标语言 + 悬停翻译开关 + 日志级别）；API Key 通过系统钥匙串读写。
- `load_recent_files()` / `save_recent_files(files: RecentFile[])`：加载 / 保存最近打开文件列表（`RecentFile` 含 `pinned` 置顶与 `lastPage` 阅读页码字段，旧数据通过 `#[serde(default)]` 兼容）。
- `check_files_exist(paths: string[])`：批量检查文件是否仍存在于磁盘，最近文件面板用它置灰已移动/删除的条目。
- `open_path(path: string)`：仅允许打开 `http://` / `https://` URL，禁止本地文件路径与目录。
- `open_logs_dir()`：打开应用日志目录，供用户导出排查。
- `check_dictionary()`：检查本地 ECDICT 词典是否存在及大小。
- `download_dictionary()`：下载 ECDICT SQLite 词典（支持断点续传），通过 `dictionary-download-progress` event 推送进度。
- `lookup_word(word: string)`：查询单词释义。

### 6.2 数据持久化

后端将数据存在 **AppData** 目录下：

```
<AppData>/
└── photonee/SpecReader/          # identifier 保持 photonee
    ├── annotations/
    │   ├── {pdf_hash}.json        # 批注 + 关联 session ids
    │   └── sessions/
    │       └── {session_id}.json  # 解读会话详情
    ├── dict/
    │   └── ecdict.sqlite          # ECDICT 本地离线词典（首次启用悬停翻译时下载）
    ├── logs/
    │   └── app.log                # 应用运行日志（默认 Warn 级别，可在设置中调整，保留最近 3 个文件各 10 MB）
    ├── settings.json              # LLM 配置 + 目标语言 + 悬停翻译开关 + 日志级别
    └── recent_files.json          # 最近打开文件列表
```

- 批注坐标以 **PDF 原始坐标（scale=1）**保存，渲染时乘以当前 scale。
- 文件 hash 用于识别同一 PDF，重命名不影响恢复。
- 旧版格式是纯 annotation 数组，后端仍兼容读取。

### 6.3 LLM 调用

- `services/llm.ts` 中的 `streamChatCompletion` 使用标准 OpenAI 兼容 SSE 接口。
- Prompt 模板包括 `buildSelectionPrompt`（翻译 / 解读）和 `buildCustomInterpretPrompt`（自定义解读），均接收 `targetLanguage` 参数。
- System prompt 也通过 `buildSystemPrompt(targetLanguage)` 按目标语言生成。
- LLM 配置与目标语言通过 `services/settings.ts` 持久化到后端 AppData；首次启动时会从旧的 `localStorage` 键 `standardread-llm-config` 迁移一次。
- 默认模型为 `gpt-4o-mini`，默认目标语言为 `中文`。

### 6.4 核心状态流

```
App.tsx
├── tabs / activeTabId / secondaryTabId   # PDF Tab 状态（单视图 + 并排视图）
├── annotations                           # 全局批注列表
├── sessions                              # 全局解读会话列表
├── stashes                               # 当前 PDF 的暂存片段
├── selection                             # 当前 PDF 选区
├── rightVisible / rightPanelWidth        # 面板布局
├── recentFiles                           # 最近打开文件列表
├── settings / settingsOpen               # 全局设置与 Modal
├── dictionaryStatus                      # 本地 ECDICT 词典状态（存在性、下载进度）
└── splitPct                              # 并排视图左右面板比例

PdfViewer.tsx（协调层：UI + 组合 hooks，详见 docs/REFACTOR_PLAN.md）
├── usePdfDocument                      # pdf / numPages / isLoading / outline
├── useViewportManager                  # pageViewports / visiblePages / 预加载
├── useZoomAnchor                       # 缩放锚点（isZooming 抑制）
├── useSearchDomain                     # 搜索索引/高亮/导航（PDF 原始坐标）
├── useScrollPageSync                   # 滚动页码同步 + scrollTop 上报
├── useTabRestore                       # tab 状态恢复 + pending 跳转
├── pageNum / scale / viewMode          # 本组件持有的三要素状态
├── 文本选区 → onSelection
└── hoverTranslate → WordTooltip        # 悬停取词翻译

AiChatPanel.tsx
├── expandedId / expandedStashIds
└── 检测到 isStreaming 会话时启动 SSE 流

SettingsModal.tsx
└── 左侧分页设置弹窗：模型设置（LLM）、功能设置（语言/悬停翻译/系统提示词）、系统设置（日志/默认打开方式）、关于（版本/软件更新/License）
```

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

- 样式集中写在 `src/App.css` 一个文件中（当前项目未使用 CSS Modules / Tailwind）。
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
- 主要覆盖：
  - `services/annotations.test.ts`：批注 CRUD、Tauri invoke mock。
  - `services/settings.test.ts`：AppSettings 默认值、后端 invoke mock、旧 localStorage 配置迁移。
  - `services/llm.test.ts`：LLM 配置默认值、SSE 流解析、Prompt 构建（含目标语言）。
  - `services/sessions.test.ts`：会话消息更新、流状态。
  - `services/stash.test.ts`：暂存片段管理。
  - `hooks/usePersistence.test.tsx`：StrictMode 下 `handleFollowUp` 不双发、流式中断、annotation 删除、分屏 annotation 隔离、关闭 Tab 资源清理。
  - `hooks/useRecentFiles.test.ts`：最近文件增删、置顶/超额降级、单条移除、lastPage 回写、分组配额。
  - `hooks/useSplitView.test.ts`：双排视图进入/退出。
  - `components/SelectionToolbar.test.tsx`：工具条渲染、点击外部关闭。
  - `components/AnnotationMarker.test.tsx`：拖拽后不误触发点击。
  - `components/PdfAnnotations.test.tsx`：按页与 `fileHash` 过滤、交互回调。
  - `components/AiChatPanel.test.tsx`：流式更新、中止按钮。
  - `components/SettingsModal.test.tsx`：设置表单与保存回调。
  - `components/RecentFilesBar.test.tsx`：面板开合、置顶分组、元信息行、搜索过滤、键盘导航、失效文件置灰、两段式清空。
  - `components/PdfViewer.pageJump.test.tsx`：连续滚动页码跳转、过期 scale 条目按 live scale 重算的滚动位置累加。
  - `components/PdfViewer.state.test.tsx`：tab 状态恢复、恢复窗口页码同步抑制、记录回灌防 stomp。
  - `components/PdfPage.test.tsx`：wrapper 尺寸渲染期直驱（无 prop→state 滞后）、过期 scale 条目重算、自加载上报。
  - `hooks/useViewportManager.test.tsx`：viewport 预加载、ensureViewport 按需加载与就绪门控、可见页 bail-out、条目去重、rapid-zoom 无混合尺度、reportViewportLoaded 批量回写/过期 scale 丢弃。
  - `hooks/useZoomAnchor.test.tsx`：缩放锚点捕获/恢复、边界缩放置锁抑制、缩放连点中锚点按 live scale 换算。
  - `hooks/useScrollPageSync.test.tsx`：滚动页码即时同步、jump/zoom 抑制、页边界换页死区（PAGE_SWITCH_MARGIN_PX）。
  - `hooks/useTabRestore.test.tsx`：mount 恢复一次语义、initialState 仅 mount 应用一次（防记录回灌）、恢复窗口 jump 锁持有/释放、pending 跳转等待目标页以上全部 viewport、激活 tab 的 post-mount 跳转。
  - `hooks/useSearchDomain.test.tsx`：PDF 坐标索引、缩放不重建、goToPageRef 不重跳、searchLoading 重置。
  - `hooks/useDrag.test.tsx`：拖拽阈值、全局监听、清理。
  - `utils/coordinateConverter.test.ts` / `utils/zoomAnchor.test.ts` / `utils/fitToWidth.test.ts` / `utils/popupPosition.test.ts`：纯函数基准。
  - `App.test.tsx`：面板显隐、会话清理、Recent Files。
  - `components/WordTooltip.test.tsx`：悬停翻译 tooltip 渲染（可选，与 PdfViewer 集成测试覆盖）。
  - `services/dictionary.test.ts` / `hooks/useDictionaryStatus.test.ts`：词典状态与下载进度（如补充）。
- Mock 策略：
  - `setup.ts` 中全局 mock `crypto.randomUUID`、`localStorage`、`matchMedia`、`IntersectionObserver`、`ResizeObserver`。
  - 相关测试用 `vi.doMock("@tauri-apps/api/core")` mock `invoke`。
  - `App.test.tsx` mock `PdfViewer` 避免加载 pdfjs-dist。
  - `AiChatPanel.test.tsx` mock `streamChatCompletion`。
  - 涉及悬停翻译的测试还需 mock `@tauri-apps/api/event` 的 `listen`，并为 `check_dictionary` / `download_dictionary` 提供 handler。

### 8.2 E2E 测试

- Playwright 启动 `npm run dev` 作为 webServer，访问 `http://localhost:1420`。
- `app.spec.ts`：主布局、顶部最近文件入口、设置 Modal、面板显隐。
- `pdf-page-jump.spec.ts`：连续滚动模式下页码跳转正确性，使用 mock 的 Tauri `invoke` 返回 PDF 字节。
- `multi-tab-state.spec.ts`：多 tab 页码/批注隔离、关闭 tab 后状态保持。
- `pdf-large-doc.spec.ts`：>50 页大文档回归——适合宽度不横向偏移、深度缩放页码不抖动、快速切换 tab 恢复页码（fixtures 含 `gen-sample-long-pdf.mjs` 生成的 60 页 PDF）。
- 单实例与文件关联需在打包后的安装包上手动验证，E2E 较难覆盖。

### 8.3 后端测试

- `src-tauri/src/lib.rs` 包含 `#[cfg(test)]` 模块。
- 覆盖：hash 计算、annotation 路径确定性、批注持久化往返、旧格式兼容、会话 CRUD、session id 路径穿越防护、PDF 路径授权、原子文件写入、最近文件 pinned/lastPage 字段兼容、`check_files_exist` 存在性判断、`check_dictionary` / `lookup_word` 非阻塞 I/O。
- `src-tauri/src/secure_storage.rs` 包含 `MemoryStorage` 测试实现，覆盖 API Key 钥匙串存取、失败降级。
- 纯逻辑与 `tauri::AppHandle` 解耦，便于测试。

## 9. 安全与隐私注意事项

- **PDF 不上传云端**：文件仅在本地读取和渲染。
- **仅主动选择的内容发送给 LLM**：翻译 / 解读只发送用户选中的文本片段，不会自动上传整篇文档。
- **API Key 存储**：API Key 通过 Rust `keyring` crate 存入系统钥匙串；`settings.json` 中只保留空占位。钥匙串不可用时 `save_settings` 会明确拒绝保存并返回错误，不回退明文存储。
- **不要在前端日志中打印 API Key 或完整文件内容**。
- Tauri CSP 当前配置为 `null`，后续如引入外部资源需要收紧。

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

- ECDICT 下载源、临时文件路径、最终文件路径集中在 `src-tauri/src/dictionary.rs` 顶部常量。
- 下载支持断点续传：依赖服务器 `Accept-Ranges: bytes`，临时文件为 `ecdict.sqlite.zip.tmp`，最终文件为 `dict/ecdict.sqlite`。
- 下载过程带重试机制：单块读取超时、连接中断或服务器返回非成功状态码时，会自动从已下载位置重试最多 5 次，并继续通过 `dictionary-download-progress` event 推送进度。
- 解压后的 SQLite 文件通过文件头魔数 `SQLite format 3\0` 定位，不依赖 zip 内的文件名（避免中文文件名编码问题）。
- 替换词库时，建议同时删除旧 `ecdict.sqlite` 与 `.tmp`，并清空 `DICT_CONNECTION` 缓存。

### 10.3 修改 Prompt

- Prompt 模板集中在 `src/services/llm.ts`。
- 修改后检查 `services/llm.test.ts` 中相关断言是否仍然成立。

### 10.4 修改 UI 布局

- 双栏宽度、最小宽度、默认比例等常量在 `App.tsx` 顶部：
  - `MIN_PANEL_WIDTH = 240`
  - `RIGHT_PANEL_MIN_WIDTH = 180`
  - `RIGHT_PANEL_DEFAULT_FRACTION = 3 / 8`
- 连续滚动相关常量（padding、spacing）同时在 `PdfViewer.tsx` 与 CSS 中定义，修改时需两边同步。

## 11. 持续集成

CI 分层触发，避免每次 push 都跑全量：

| Workflow | 触发 | 内容 |
| --- | --- | --- |
| `ci-quick.yml` | 非 master 分支 push | type-check / lint / 单元测试（目标 < 5 分钟） |
| `ci-full.yml` | master push / PR | 上述全部 + 前端 build + cargo test / clippy / audit + 双浏览器 E2E + npm audit（三个 job 并行，Rust 依赖有缓存） |
| `release.yml` | 手动 dispatch（输入版本号） | 一键发布，见 5.3 发版流程 |
| `landing.yml` | master 上 `landing/**` 变更 / 手动 | 部署 GitHub Pages |

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
- `TESTING.md`：详细测试说明与已发现的 bug 修复记录。
- `README.md`：快速开始与项目简介。

## 13. 版本信息

- 前端版本：`0.8.1`
- Tauri 应用版本：`0.8.1`
- 产品名称：`SpecReader AI`
- 应用标识：`com.photonee.specreader`
