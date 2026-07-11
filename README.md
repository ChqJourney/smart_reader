# SpecReader AI

面向检测认证工程师的桌面端 AI 助手，用于降低阅读、理解和执行各类标准 PDF 文件时的认知与智力开销。

## 技术栈

- **桌面框架**：Tauri 2.0（Rust 后端 + Web 前端）
- **前端**：React 18 + TypeScript 5.6 + Vite 6
- **PDF 渲染**：pdfjs-dist 4.8
- **Markdown 渲染**：react-markdown
- **AI 调用**：OpenAI 兼容 API（DeepSeek / Kimi / Qwen / OpenAI 等）

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

# 后端 Rust 测试
cd src-tauri && cargo test
```

详细测试说明见 [TESTING.md](./TESTING.md)。

## 项目结构

```
.
├── docs/                              # 产品设计文档
│   ├── PRD.md                         # 产品需求文档
│   └── AGENT_TOOLS_DESIGN.md          # 完整目标架构设计（Tools / Clause 索引等）
├── src/                               # 前端源码
│   ├── App.tsx                        # 应用顶层：Tab 管理、双栏布局、批注/会话状态
│   ├── App.css                        # 全局样式
│   ├── main.tsx                       # React 入口
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
│   │   ├── WordTooltip.tsx            # 悬停单词翻译 tooltip
│   │   └── Icon.tsx                   # SVG 图标组件
│   ├── services/                      # 业务逻辑与 Tauri 命令封装
│   │   ├── annotations.ts             # Annotation 类型 + CRUD + 持久化调用
│   │   ├── settings.ts                # 应用设置（LLM + 目标语言 + 悬停翻译开关）CRUD
│   │   ├── dictionary.ts              # ECDICT 本地词典查询与下载进度监听
│   │   ├── llm.ts                     # LLM 配置、SSE 流式请求、Prompt 模板
│   │   ├── sessions.ts                # 解读会话数据结构与管理
│   │   └── stash.ts                   # 暂存片段数据结构与管理
│   └── test/                          # 测试工具与全局 mock
│       ├── setup.ts
│       └── mocks/tauri.ts
├── src-tauri/                         # Tauri Rust 后端
│   ├── src/
│   │   ├── lib.rs                     # Tauri 命令
│   │   └── main.rs                    # 后端入口
│   ├── capabilities/                  # Tauri 权限配置
│   ├── Cargo.toml
│   └── tauri.conf.json
├── e2e/                               # Playwright E2E 测试
├── scripts/                           # 辅助脚本
├── package.json
├── vite.config.ts
├── playwright.config.ts
└── tsconfig.json
```

## 当前已实现能力（超轻量版）

- 多 PDF Tab 同时打开（最多 10 个）。
- PDF 本地渲染、文本选区、缩放、页码跳转、单页 / 连续滚动阅读模式。
- 选中文本后浮动工具条：加入暂存、解读、翻译。
- 翻译生成可拖动 / 隐藏 / 删除的浮层批注。
- 解读生成蓝色标记，并在右侧面板展示可点击跳转的解读记录。
- 自定义解读：把多个暂存片段一次性发给 LLM。
- 解读记录支持多轮追问。
- 批注和解读记录按 PDF 文件 SHA-256 hash 持久化到本地 AppData。
- 鼠标悬停英文单词显示本地 ECDICT 词典翻译（设置中可开关，首次启用需下载离线词典）。
- LLM 配置（Base URL、API Key、Model）保存于 `localStorage`。

明确未实现（已规划到后续版本）：

- PDF 文本提取、Clause 索引、目录导航、全文搜索。
- 术语表、引用追踪、测试清单生成。
- 表格截图 + 多模态读取。
- License 激活校验。

## 隐私说明

- PDF 文件内容不上传云端，仅在本地读取和渲染。
- 仅用户主动选中的文本片段会发送给用户配置的 LLM API。
- API Key 当前保存在前端 `localStorage`，未加密；后续计划迁移到系统安全存储。

## License

商业软件，后续版本计划加入 License 激活。当前「超轻量版」暂不强制校验 License。
