# SpecReader AI

面向检测认证工程师的桌面端 AI 助手，用于降低阅读、理解和执行各类标准 PDF 文件时的认知与智力开销。

👉 [查看产品演示页](https://chqjourney.github.io/smart_reader/) | [下载最新版](https://github.com/ChqJourney/smart_reader/releases)

## 技术栈

- **桌面框架**：Tauri 2.0（Rust 后端 + Web 前端）
- **前端**：React 18 + TypeScript 5.6 + Vite 6
- **PDF 渲染**：pdfjs-dist 4.8
- **Markdown 渲染**：react-markdown
- **AI 调用**：OpenAI 兼容 API，经 Rust 后端代理转发，API Key 存系统钥匙串、不进入 webview；多平台预设（DeepSeek / Kimi / 百炼 / GLM / 火山引擎 / OpenRouter / OpenAI / 自定义），默认平台 DeepSeek、默认模型 deepseek-v4-flash

## 开发环境要求

- Node.js >= 18
- Rust >= 1.77.2
- Tauri CLI（可选，项目内已有 `@tauri-apps/cli`）

## 快速开始

```bash
# 安装前端依赖
npm install

# 仅启动 Vite 前端开发服务器（端口 1420）
npm run dev

# 启动 Tauri 桌面应用开发模式
npm run tauri-dev

# 构建前端生产包到 dist/
npm run build

# 构建完整桌面应用安装包
npm run tauri-build
```

## 测试

```bash
# 前端单元/集成测试
npm run test

# 监听模式
npm run test:watch

# 覆盖率报告
npm run test:coverage

# E2E 测试
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

详细测试说明见 [TESTING.md](./TESTING.md)。

## 项目结构

```
.
├── docs/                              # 产品设计文档（PRD / Agent Tools 设计）
├── src/                               # 前端源码
│   ├── App.tsx / App.css / main.tsx   # 应用顶层、全局样式、React 入口
│   ├── components/                    # React 组件（30+，每组件配同名 .css）
│   │   ├── TitleBar.tsx               # 自定义标题栏（品牌区、最近文件、窗口控制）
│   │   ├── SetupWizard.tsx            # 首次启动配置向导（选平台 → 填 Key → 测试连接）
│   │   ├── PdfViewer.tsx / PdfPage.tsx            # PDF 渲染、选区、缩放、单页/连续模式
│   │   ├── PdfAnnotations.tsx / AnnotationMarker.tsx / *Popup.tsx  # 批注与浮层
│   │   ├── AiChatPanel.tsx            # 右侧面板（暂存区、解读记录、追问）
│   │   ├── SettingsModal.tsx / RecentFilesBar.tsx / CustomInterpretModal.tsx
│   │   └── MarkdownRenderer.tsx / ContextWidget.tsx / ThinkingIndicator.tsx / Icon.tsx 等
│   ├── hooks/                         # 可复用状态逻辑（18 个）
│   │   └── useTabs / usePersistence / useRecentFiles / useSplitView /
│   │       usePdfDocument / useViewportManager / useZoomAnchor / useSearchDomain /
│   │       useScrollPageSync / useTabRestore / useWordLookup / useDictionaryStatus /
│   │       useDrag / useClampedPopupPosition / useStreaming / useModal / useRightPanelLayout
│   ├── services/                      # 业务逻辑与 Tauri 命令封装
│   │   ├── llm.ts / settings.ts / updater.ts / dialog.ts / logs.ts / selection.ts
│   │   ├── annotations.ts / sessions.ts / stash.ts / recentFiles.ts / dictionary.ts
│   │   └── pdfTools.ts / pdfToolsRegistry.ts      # Agent Tools 执行层与授权注册表
│   ├── data/platformPresets.ts        # LLM 多平台预设
│   ├── types/llm.ts                   # LLM 相关类型
│   ├── i18n/ + locales/               # i18next 接入（zh-CN / en）
│   └── test/                          # 测试工具与全局 mock
├── src-tauri/                         # Tauri Rust 后端
│   ├── src/
│   │   ├── lib.rs                     # Tauri 命令
│   │   ├── llm_proxy.rs               # LLM 请求代理（SSE 转发、工具调用累积、错误分类）
│   │   ├── secure_storage.rs          # API Key 系统钥匙串封装
│   │   └── dictionary.rs / paths.rs / main.rs
│   ├── capabilities/                  # Tauri 权限配置
│   ├── Cargo.toml
│   └── tauri.conf.json
├── e2e/                               # Playwright E2E 测试（6 个 spec + fixtures）
├── scripts/                           # 辅助脚本（版本同步、发版、测试 PDF 生成）
├── package.json / vite.config.ts / playwright.config.ts / tsconfig.json
└── eslint.config.js
```

## 当前已实现能力（超轻量版）

- 多 PDF Tab 同时打开（最多 10 个），支持左右分屏并排对照两份 PDF。
- 自定义标题栏：无边框窗口，集成品牌区、最近文件入口、打开 PDF / 设置与窗口控制按钮。
- 首次启动配置向导（SetupWizard）：选平台 → 填 API Key → 测试连接（真实调用 LLM 验证）；全部平台未配置 Key 时自动弹出，设置中可重跑。
- PDF 本地渲染、文本选区、缩放、页码跳转、单页 / 连续滚动阅读模式。
- 全文搜索（Ctrl / Cmd + F，跨 text item 短语匹配，结果逐页高亮跳转）与大纲 / 目录导航。
- 选中文本后浮动工具条：复制、批注、加入暂存、解读、翻译；批注生成紫色可拖动标记（CommentPopup，防抖保存）。
- 翻译生成可拖动 / 隐藏 / 删除的浮层批注。
- 解读生成蓝色标记，并在右侧面板展示可点击跳转的解读记录，支持多轮追问。
- 自定义解读：把多个暂存片段一次性发给 LLM。
- **解读 / 自定义解读 / 追问时启用 Agent Tools**：LLM 可通过 Function Calling 查阅当前打开的 PDF 原文，辅助验证条款引用与跨页内容；轮次上限默认 20，超限优雅收尾并提示。
- LLM 请求经 Rust 后端代理转发：API Key 只存系统钥匙串、按平台分条目，不再暴露给 webview；多平台预设（deepseek / kimi / bailian / glm / volcengine / openrouter / openai / custom）。
- 批注和解读记录按 PDF 文件 SHA-256 hash 持久化到本地 AppData。
- 最近文件面板：置顶、搜索、失效置灰、上次读到的页码回写、分屏对照打开。
- 鼠标悬停英文单词显示本地 ECDICT 词典翻译（设置中可开关，首次启用需下载离线词典）。
- 会话上下文用量条（ContextWidget）、思考过程展示（ThinkingIndicator）、Markdown 渲染（含 KaTeX 公式）。
- 软件自动更新：启动 3 秒后自动检查，设置「关于」页可手动检查。
- i18n 框架接入（i18next，zh-CN / en 两个 locales；当前界面固定中文，en 预埋）。

明确未实现（已规划到后续版本）：

- Clause 索引、引用追踪。
- 术语表、测试清单生成。
- 表格截图 + 多模态读取。
- License 激活校验。

## 隐私说明

- PDF 文件内容不上传云端，仅在本地读取和渲染。
- 仅用户主动选中的文本片段会发送给用户配置的 LLM API。
- API Key 通过 Rust `keyring` crate 存入系统钥匙串；`settings.json` 中只保留空占位。钥匙串不可用时保存会明确报错，不回退明文存储。

## License

商业软件，后续版本计划加入 License 激活。当前「超轻量版」暂不强制校验 License。
