# StandardRead AI

面向检测认证工程师的桌面端 AI 助手，用于降低阅读、理解和执行各类标准 PDF 文件时的认知与智力开销。

## 技术栈

- **桌面框架**：Tauri 2.0（Rust 后端 + Web 前端）
- **前端**：React + TypeScript + Vite
- **PDF 渲染**：PDF.js
- **PDF 文本提取**：pdf-extract（Rust）
- **AI 调用**：OpenAI 兼容 API（DeepSeek / Kimi / Qwen / OpenAI 等）

## 开发环境要求

- Node.js >= 18
- Rust >= 1.77
- Tauri CLI：`npm install -g @tauri-apps/cli`

## 快速开始

```bash
# 安装前端依赖
npm install

# 运行开发版本
npm run tauri-dev

# 构建生产版本
npm run tauri-build

# 运行测试
npm run test          # 前端单元/集成测试
npm run test:e2e      # Playwright 端到端测试
cd src-tauri && cargo test  # 后端 Rust 测试
```

详细测试说明见 [TESTING.md](./TESTING.md)。

## 项目结构

```
.
├── docs/                    # 产品设计文档
│   ├── PRD.md              # 产品需求文档
│   └── AGENT_TOOLS_DESIGN.md # LLM Tools 技术方案
├── src/                     # 前端源码
│   ├── App.tsx
│   ├── App.css
│   └── main.tsx
├── src-tauri/               # Tauri Rust 后端
│   ├── src/
│   │   └── lib.rs          # 后端主入口，包含 invoke 命令
│   ├── capabilities/       # 权限配置
│   ├── Cargo.toml
│   └── tauri.conf.json     # Tauri 配置
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## MVP 目标

- 打开本地 PDF 文件
- 提取并清洗 PDF 文本
- 通过 LLM Tools 与文档交互
- 选中即问、术语解释、测试清单提取

## License

商业软件，需激活 License 使用。
