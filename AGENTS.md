# StandardRead AI 项目指南

> 本文件供 AI coding agent 阅读，用于快速理解项目结构、技术栈、构建流程与开发约定。

## 1. 项目概述

**StandardRead AI**（内部代号 `pdf-standard-agent`）是一款面向检测认证工程师的桌面端 AI 助手，用于降低阅读、理解和执行 IEC / ISO / EN / GB / UL / ASTM / IEEE 等标准 PDF 文件时的认知与智力开销。

当前处于**「超轻量版」**，核心闭环为：

```
打开本地 PDF → 本地渲染 → 选中文本 → AI 翻译 / 解读
```

已实现能力：

- 多 PDF Tab 同时打开（最多 10 个）。
- PDF 本地渲染、文本选区、缩放、页码跳转、单页 / 连续滚动阅读模式。
- 选中文本后浮动工具条：加入暂存、解读、翻译。
- 翻译生成可拖动 / 隐藏 / 删除的浮层批注。
- 解读生成蓝色标记，并在右侧面板展示可点击跳转的解读记录。
- 自定义解读：把多个暂存片段一次性发给 LLM。
- 批注和解读记录按 PDF 文件 SHA-256 hash 持久化到本地 AppData。
- LLM 配置（Base URL、API Key、Model）保存于 `localStorage`。

明确未实现（已规划到后续版本）：

- PDF 文本提取、Clause 索引、目录导航、全文搜索。
- 术语表、引用追踪、测试清单生成。
- 表格截图 + 多模态读取。
- License 激活校验。

## 2. 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri 2.0（Rust 后端 + Web 前端） |
| 前端框架 | React 18 + TypeScript 5.6 |
| 构建工具 | Vite 6 |
| PDF 渲染 | pdfjs-dist 4.8 |
| UI 图标 | 自定义 `Icon` 组件（SVG 集合） |
| Markdown 渲染 | react-markdown |
| 后端语言 | Rust（tauri 2.11, edition 2021） |
| 后端存储 | 本地 JSON 文件（AppData） |
| 前端单元测试 | Vitest 4.1 + jsdom + @testing-library/react |
| E2E 测试 | Playwright 1.61 |
| 后端测试 | `cargo test` |

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
│   │   ├── AiChatPanel.tsx            # 右侧面板（设置、暂存区、解读记录）
│   │   ├── CustomInterpretModal.tsx   # 自定义解读弹窗
│   │   └── Icon.tsx                   # SVG 图标组件
│   ├── services/                      # 业务逻辑与 Tauri 命令封装
│   │   ├── annotations.ts             # Annotation 类型 + CRUD + 持久化调用
│   │   ├── llm.ts                     # LLM 配置、SSE 流式请求、Prompt 模板
│   │   ├── sessions.ts                # 解读会话数据结构与管理
│   │   └── stash.ts                   # 暂存片段数据结构与管理
│   └── test/                          # 测试工具
│       ├── setup.ts                   # Vitest 全局 setup / mock
│       └── mocks/tauri.ts             # mockTauriInvoke 辅助函数
├── src-tauri/                         # Tauri Rust 后端
│   ├── src/
│   │   ├── lib.rs                     # Tauri 命令：read_pdf_bytes / get_pdf_hash / load_pdf_data / save_pdf_data / load_session / save_session / delete_session
│   │   └── main.rs                    # 后端入口
│   ├── capabilities/                  # Tauri 权限配置
│   ├── icons/                         # 应用图标
│   ├── Cargo.toml
│   └── tauri.conf.json                # 应用窗口、构建、打包配置
├── e2e/                               # Playwright E2E 测试
│   ├── fixtures/                      # 测试用 PDF
│   ├── app.spec.ts                    # 主布局 / 面板显隐 / 设置
│   └── pdf-page-jump.spec.ts          # 连续滚动页码跳转
├── scripts/                           # 辅助脚本
│   ├── gen-sample-pdf.mjs             # 生成测试 PDF
│   └── gen-sample-short-pdf.mjs       # 生成短页测试 PDF
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
```

### 5.3 测试

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

# 后端 Rust 测试
cd src-tauri && cargo test
```

## 6. 运行时架构

### 6.1 前端 - 后端边界

所有前端与 Rust 后端的通信均通过 Tauri `invoke` 完成，封装在 `src/services/*.ts` 中。

当前暴露的命令：

- `read_pdf_bytes(filePath: string)`：读取 PDF 原始字节。
- `get_pdf_hash(filePath: string)`：计算 PDF SHA-256 hash。
- `load_pdf_data(filePath: string)`：加载 `<AppData>/annotations/{hash}.json`。
- `save_pdf_data(filePath: string, data: PdfData)`：保存批注与会话引用。
- `load_session(sessionId: string)`：加载单个会话 JSON。
- `save_session(session: InterpretationSession)`：保存会话 JSON。
- `delete_session(sessionId: string)`：删除会话文件。
- `open_path(path: string)`：使用系统默认程序打开路径。

### 6.2 数据持久化

后端将数据存在 **AppData** 目录下：

```
<AppData>/
└── annotations/
    ├── {pdf_hash}.json        # 批注 + 关联 session ids
    └── sessions/
        └── {session_id}.json  # 解读会话详情
```

- 批注坐标以 **PDF 原始坐标（scale=1）**保存，渲染时乘以当前 scale。
- 文件 hash 用于识别同一 PDF，重命名不影响恢复。
- 旧版格式是纯 annotation 数组，后端仍兼容读取。

### 6.3 LLM 调用

- `services/llm.ts` 中的 `streamChatCompletion` 使用标准 OpenAI 兼容 SSE 接口。
- Prompt 模板包括 `buildSelectionPrompt`（翻译 / 解读）和 `buildCustomInterpretPrompt`（自定义解读）。
- 配置保存于 `localStorage`，键为 `standardread-llm-config`。
- 默认模型为 `gpt-4o-mini`。

### 6.4 核心状态流

```
App.tsx
├── tabs / activeTabId            # PDF Tab 状态
├── annotations                   # 全局批注列表
├── sessions                      # 全局解读会话列表
├── stashes                       # 当前 PDF 的暂存片段
├── selection                     # 当前 PDF 选区
└── rightVisible / rightPanelWidth # 面板布局

PdfViewer.tsx
├── pdf / numPages / pageNum / scale / viewMode
├── visiblePages / pageViewports  # 连续滚动懒加载 + 精确跳转
└── 文本选区 → onSelection

AiChatPanel.tsx
├── config（LLM 配置）
├── expandedId / expandedStashIds
└── 检测到 isStreaming 会话时启动 SSE 流
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
  - `services/llm.test.ts`：LLM 配置默认值、SSE 流解析、Prompt 构建。
  - `services/sessions.test.ts`：会话消息更新、流状态。
  - `services/stash.test.ts`：暂存片段管理。
  - `components/SelectionToolbar.test.tsx`：工具条渲染、点击外部关闭。
  - `components/AnnotationMarker.test.tsx`：拖拽后不误触发点击。
  - `components/PdfAnnotations.test.tsx`：按页过滤、交互回调。
  - `components/AiChatPanel.test.tsx`：设置面板、流式更新。
  - `components/PdfViewer.pageJump.test.tsx`：连续滚动页码跳转。
  - `App.test.tsx`：面板显隐、会话清理。
- Mock 策略：
  - `setup.ts` 中全局 mock `crypto.randomUUID`、`localStorage`、`matchMedia`、`IntersectionObserver`、`ResizeObserver`。
  - 相关测试用 `vi.doMock("@tauri-apps/api/core")` mock `invoke`。
  - `App.test.tsx` mock `PdfViewer` 避免加载 pdfjs-dist。
  - `AiChatPanel.test.tsx` mock `streamChatCompletion`。

### 8.2 E2E 测试

- Playwright 启动 `npm run dev` 作为 webServer，访问 `http://localhost:1420`。
- `app.spec.ts`：主布局、面板显隐、设置开关。
- `pdf-page-jump.spec.ts`：连续滚动模式下页码跳转正确性，使用 mock 的 Tauri `invoke` 返回 PDF 字节。
- CI 环境下建议设置 `CI=true`。

### 8.3 后端测试

- `src-tauri/src/lib.rs` 包含 `#[cfg(test)]` 模块。
- 覆盖：hash 计算、annotation 路径确定性、批注持久化往返、旧格式兼容、会话 CRUD。
- 纯逻辑与 `tauri::AppHandle` 解耦，便于测试。

## 9. 安全与隐私注意事项

- **PDF 不上传云端**：文件仅在本地读取和渲染。
- **仅主动选择的内容发送给 LLM**：翻译 / 解读只发送用户选中的文本片段，不会自动上传整篇文档。
- **API Key 存储**：目前保存在前端 `localStorage`，未加密。后续计划使用系统安全存储 / Keychain。
- **不要在前端日志中打印 API Key 或完整文件内容**。
- Tauri CSP 当前配置为 `null`，后续如引入外部资源需要收紧。

## 10. 常见改动注意事项

### 10.1 修改 Tauri 命令

1. 在 `src-tauri/src/lib.rs` 添加 `#[tauri::command]` 函数。
2. 在 `run()` 的 `generate_handler![...]` 中注册。
3. 在 `src/services/*.ts` 中封装 TypeScript 调用。
4. 如有需要，在 `src/test/mocks/tauri.ts` 或相关测试中添加 mock handler。

### 10.2 修改数据模型

- Rust 与 TypeScript 的 `Annotation`、`InterpretationSession`、`StashSource` 等类型需要**保持同步**。
- 新增字段尽量使用 `#[serde(default)]` 和 `?` / `skip_serializing_if`，保持旧数据兼容。
- 如需破坏性变更，请同时编写旧数据迁移逻辑。

### 10.3 修改 Prompt

- Prompt 模板集中在 `src/services/llm.ts`。
- 修改后检查 `services/llm.test.ts` 中相关断言是否仍然成立。

### 10.4 修改 UI 布局

- 双栏宽度、最小宽度、默认比例等常量在 `App.tsx` 顶部：
  - `MIN_PANEL_WIDTH = 240`
  - `RIGHT_PANEL_MIN_WIDTH = 180`
  - `RIGHT_PANEL_DEFAULT_FRACTION = 3 / 8`
- 连续滚动相关常量（padding、spacing）同时在 `PdfViewer.tsx` 与 CSS 中定义，修改时需两边同步。

## 11. 持续集成建议

```bash
npm ci
npx playwright install chromium
npm run test
npm run test:e2e
cd src-tauri && cargo test
```

可单独运行各层测试以加快反馈。

## 12. 参考文档

- `docs/PRD.md`：产品需求、MVP 范围、数据模型。
- `docs/AGENT_TOOLS_DESIGN.md`：完整目标架构（Tools、Clause 索引、术语表、测试清单、表格多模态读取）。
- `TESTING.md`：详细测试说明与已发现的 bug 修复记录。
- `README.md`：快速开始与项目简介。

## 13. 版本信息

- 前端版本：`0.1.0`
- Tauri 应用版本：`0.1.0`
- 产品名称：`StandardRead AI`
- 应用标识：`com.standardread.app`
