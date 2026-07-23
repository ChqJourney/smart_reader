# 测试指南

本项目包含前端单元/集成测试、前端 E2E 测试以及后端 Rust 单元测试，用于在后续功能扩展时保持稳定性。

## 测试结构

```
.
├── src/                          # 前端源码
│   ├── services/*.test.ts        # 服务层单元测试
│   ├── components/*.test.tsx     # React 组件测试
│   ├── App.test.tsx              # 顶层应用组件测试
│   └── test/                     # 测试工具与全局 mock
│       ├── setup.ts              # Vitest 全局 setup
│       └── mocks/tauri.ts        # Tauri invoke mock 辅助
├── e2e/                          # Playwright E2E 测试（6 个 spec）
│   ├── fixtures/                 # 测试用 PDF（gen-sample-*.mjs 生成，含 60 页大文档）
│   ├── app.spec.ts
│   ├── pdf-page-jump.spec.ts
│   ├── multi-tab-state.spec.ts
│   ├── pdf-large-doc.spec.ts
│   ├── pdf-rapid-zoom.spec.ts
│   └── pdf-selection-translate.spec.ts
├── playwright.config.ts          # Playwright 配置
├── vite.config.ts                # Vitest 配置
└── src-tauri/src/                # Rust 源码与测试（lib.rs / secure_storage.rs / llm_proxy.rs）
```

## 可用命令

| 命令                         | 说明                        |
| ---------------------------- | --------------------------- |
| `npm run test`               | 运行前端单元/集成测试       |
| `npm run test:watch`         | 监听模式运行前端测试        |
| `npm run test:coverage`      | 生成前端测试覆盖率报告      |
| `npm run test:e2e`           | 运行 Playwright E2E 测试    |
| `npm run test:e2e:ui`        | 以 UI 模式运行 E2E 测试     |
| `npm run test:all`           | 依次运行单元测试与 E2E 测试 |
| `npm run type-check`         | TypeScript 类型检查         |
| `npm run lint`               | ESLint 代码检查             |
| `npm run format:check`       | Prettier 格式检查           |
| `cd src-tauri && cargo test` | 运行后端 Rust 测试          |

## 前端测试

### 工具栈

- **Vitest**：与 Vite 集成，提供单元/集成测试运行环境。
- **@testing-library/react**：组件渲染与交互测试。
- **@testing-library/jest-dom**：DOM 断言扩展。
- **jsdom**：浏览器环境模拟。

### 配置

Vitest 配置位于 `vite.config.ts`：

- 启用全局 API（`globals: true`）
- 使用 `jsdom` 环境
- 全局 setup 文件：`src/test/setup.ts`
- 测试匹配：`src/**/*.{test,spec}.{ts,tsx}`
- 覆盖率 provider：`v8`

### 测试范围

当前约 40 个 `*.test.*` 文件，按目录分类概括如下：

- **services/**：`annotations`（CRUD 与持久化）、`settings`（默认值、后端 invoke、旧 localStorage 迁移）、`llm`（配置读写、Prompt 构建、SSE 流解析）、`sessions`（消息更新、流状态、删除）、`stash`（暂存片段增删改）、`pdfTools`（Agent Tools 三工具正常路径、白名单拒绝、页码越界、截断、搜索无命中、未知工具、非法 JSON、异常转错误文本、session dispose 幂等）、`pdfToolsRegistry`（打开 PDF 元数据同步、关闭 tab 授权失效、bytes 缓存命中与回退）、`dictionary`（词典状态与查询）。
- **hooks/**：`usePersistence`（StrictMode 下 `handleFollowUp` 不双发、流式中断、annotation 删除、分屏隔离、关闭 Tab 资源清理；Agent Loop 工具调用→执行→收尾、消息落盘与追问回放、同参去重、达 `maxRounds` 强制无 tools 收尾、总开关关闭降级）、`useRecentFiles`（增删、置顶、配额、lastPage 回写）、`useSplitView`、`useTabs`、`useViewportManager`（viewport 预加载与就绪门控）、`useZoomAnchor`（缩放锚点捕获/恢复）、`useScrollPageSync`（滚动页码同步与换页死区）、`useTabRestore`（tab 状态恢复与 pending 跳转）、`useSearchDomain`（PDF 坐标索引与搜索导航）、`useDrag`（拖拽阈值与清理）、`useDictionaryStatus`（下载进度状态流转）。
- **components/**：`PdfViewer` 拆分为 pageJump / state / zoom 三组测试（连续滚动跳转、tab 状态恢复、快速缩放回归）；`PdfPage`（wrapper 尺寸直驱、过期 scale 重算）；`SelectionToolbar`、`AnnotationMarker`（拖拽后不误触发点击）、`PdfAnnotations`（按页与 fileHash 过滤）、`AiChatPanel`（流式更新、中止）、`ToolCallsIndicator`、`SettingsModal`、`RecentFilesBar`、`CustomInterpretModal`、`CommentPopup`、`ExplainPopup`、`TranslatePopup`、`MarkdownRenderer`。
- **utils/**：`coordinateConverter` / `zoomAnchor` / `fitToWidth` / `popupPosition` / `time` / `path` / `clipboard` 等纯函数基准测试。
- **App.test.tsx**：面板显隐切换、头部渲染、会话清理、悬停翻译开关集成（mock `PdfViewer` 避免加载 pdfjs-dist）。

### Mock 策略

- `@tauri-apps/api/core` 的 `invoke` 在相关测试中被 mock。
- `@tauri-apps/api/event` 的 `listen` 在涉及下载进度监听的测试中被 mock（如 `App.test.tsx`、`SettingsModal.test.tsx`）。
- `localStorage`、`IntersectionObserver`、`ResizeObserver`、`matchMedia` 在 `setup.ts` 中全局 mock。
- `crypto.randomUUID` 被固定为 `test-uuid-1234`。
- `PdfViewer` 在 `App.test.tsx` 中被 mock，避免加载 pdfjs-dist。
- `streamChatCompletion` 在 `AiChatPanel.test.tsx` 中被 mock。

## E2E 测试

### 工具栈

- **Playwright**：端到端测试。

### 配置

`playwright.config.ts` 会启动 `npm run dev` 作为 webServer，E2E 测试访问 `http://localhost:1420`。

### 测试范围

E2E 测试通过 mock Tauri `invoke` 返回 PDF 字节，fixtures 目录包含 `scripts/gen-sample-*.mjs` 生成的三个测试 PDF（含 60 页大文档 `sample-long.pdf`）。

`e2e/app.spec.ts` 覆盖：

- 主布局渲染、顶部最近文件入口。
- PDF 面板与 AI 面板显隐切换。
- 设置 Modal 的打开与关闭。

`e2e/pdf-page-jump.spec.ts` 覆盖：

- 连续滚动模式下通过页码输入框跳转后，当前可视页码与输入值一致。
- 从已滚动位置跳转、连续多次跳转、大视口/短页面场景下的跳转准确性。
- 跳转完成后页码输入框不再漂移（防止可见页检测与跳转锁竞争）。

`e2e/multi-tab-state.spec.ts` 覆盖：

- 多 tab 页码 / 批注状态隔离。
- 关闭 tab 后重新打开的状态保持。

`e2e/pdf-large-doc.spec.ts` 覆盖（60 页大文档回归）：

- 适合宽度时不横向偏移。
- 深度缩放时页码稳定不抖动。
- 快速切换 tab 后页码恢复正确。

`e2e/pdf-rapid-zoom.spec.ts` 覆盖：

- 快速连续缩放场景的渲染与页码回归。

`e2e/pdf-selection-translate.spec.ts` 覆盖：

- 选中文本 → 浮动工具条 → 翻译流程。

### 运行注意

E2E 测试启动 Vite dev server，首次运行可能需要下载 Chromium。CI 环境下建议设置 `CI=true`。单实例与文件关联需在打包后的安装包上手动验证，E2E 较难覆盖。

## 后端测试

### 工具栈

- **cargo test**：Rust 标准测试。
- **tempfile**：创建临时目录与文件。

### 测试范围

`src-tauri/src/lib.rs` 中的 `#[cfg(test)]` 模块覆盖：

- `compute_pdf_hash`：PDF 文件哈希计算。
- `annotations_path`：标注文件路径的确定性与结构。
- `save_pdf_data_to_disk` / `load_pdf_data_from_disk`：标注持久化往返、旧格式兼容、缺失文件返回空。
- `save_session_to_disk` / `load_session_from_disk` / `delete_session_from_disk`：解读会话 CRUD、session id 路径穿越防护。
- `validate_pdf_access` / `authorize_pdf_path`：PDF 路径授权白名单。
- `atomic_write`：原子文件写入。
- `read_pdf_bytes` 命令的文件读取正确性。

`src-tauri/src/secure_storage.rs` 中的 `#[cfg(test)]` 模块覆盖：

- `MemoryStorage` API Key 存取与删除。
- `load_settings_with_storage` / `save_settings_with_storage`：settings JSON 中无 API Key 明文、keyring 失败时拒绝保存。

`src-tauri/src/llm_proxy.rs` 中的 `#[cfg(test)]` 模块覆盖：

- 请求体构建：思考参数（thinking）按开启/关闭/自动正确下发或省略、tools 字段序列化、tool 消息 snake_case 字段名。
- 错误分类：401 → 认证错误、404 → 模型不存在、429 → 限流、500 → 服务器错误、400 context length → 上下文超限。

### 可测试性重构

为了让 Rust 代码易于测试，`lib.rs` 将纯逻辑与 `tauri::AppHandle` 解耦：

- `compute_pdf_hash`：纯函数，接收文件路径。
- `annotations_dir`、`annotations_path`、`load_pdf_data_from_disk`、`save_pdf_data_to_disk`：基于 `std::path::Path` 的纯函数。
- `sessions_dir`、`session_path`、`load_session_from_disk`、`save_session_to_disk`、`delete_session_from_disk`：基于 `std::path::Path` 的纯函数。
- Tauri command 仅负责从 `AppHandle` 解析 `app_data_dir` 并调用纯函数。

## 测试驱动发现的 bug 修复

在建立测试套件的过程中，发现并修复了以下问题：

1. **AnnotationMarker 拖拽后误触发点击**
   - 问题：拖拽标注结束后释放鼠标会同时触发 `onClick`，导致用户本想移动标注却打开了弹窗。
   - 修复：`src/components/AnnotationMarker.tsx` 使用 `hasMovedRef` 记录是否发生实际移动，并在 `click` 事件后重置，避免拖拽被误判为点击。
   - 回归测试：`src/components/AnnotationMarker.test.tsx`

2. **`loadLlmConfig` 对部分配置缺少默认值**
   - 问题：如果 `localStorage` 中只保存了部分字段（如仅有 `apiKey`），`baseUrl` 和 `model` 会变为 `undefined`，导致后续 LLM 调用失败。
   - 修复：`src/services/llm.ts` 中 `loadLlmConfig` 使用默认值合并存储的配置。
   - 回归测试：`src/services/llm.test.ts`

3. **App 高亮定时器在卸载时未清理**
   - 问题：`handleGotoAnnotation` 和 `onExplainClick` 中使用了 `setTimeout`，组件卸载时可能尝试更新已卸载组件的状态，产生 React 警告。
   - 修复：`src/App.tsx` 引入 `highlightTimeoutRef`，并在卸载 effect 中统一清理。

4. **PdfViewer `initialState` effect 依赖整个对象**
   - 问题：依赖 `initialState` 对象会导致父组件每次渲染都触发状态同步 effect，可能重置用户当前的查看位置。
   - 修复：`src/components/PdfViewer.tsx` 将 effect 依赖拆分为 `initialState?.pageNum`、`initialState?.scale`、`initialState?.viewMode`。

5. **App 回调引用不稳定**
   - 问题：`handleAnnotationUpdate`、`handleAnnotationDelete` 等回调每次渲染都重新创建，导致依赖它们的子组件 effect 不必要地重复执行。
   - 修复：`src/App.tsx` 使用 `useCallback` 稳定这些回调引用。

6. **连续滚动页码跳转后页码漂移**
   - 问题：连续滚动模式下，旧版可见页检测以页面中心为基准，在大视口或短页面场景下，跳转到目标页后当前页码会漂移到相邻页。
   - 修复：`src/components/PdfViewer.tsx` 改为以「页面顶部距离视口顶部最近」作为当前页判断标准，并引入跳转锁避免可见页检测与跳转滚动竞争。
   - 回归测试：`src/components/PdfViewer.pageJump.test.tsx` 与 `e2e/pdf-page-jump.spec.ts`

## 安全与数据可靠性修复

针对安全审计发现的 Critical / High / P0 / P1 / P2 项做过一轮集中修复，核心变化如下：

1. **`handleFollowUp` StrictMode 双发 SSE（C-1）**
   - 修复：`src/hooks/usePersistence.ts` 将 `runSessionStream` 移到 `setSessions` updater 外部。
   - 回归测试：`src/hooks/usePersistence.test.tsx`

2. **`session_path` 路径穿越（C-2）**
   - 修复：`src-tauri/src/lib.rs` 增加 `validate_session_id`，限制 session id 字符集。
   - 回归测试：`src-tauri/src/lib.rs` Rust tests

3. **PDF 命令无路径校验（H-1）**
   - 修复：`src-tauri/src/lib.rs` 增加 `AppState` 授权路径白名单与 `validate_pdf_access`。
   - 回归测试：`src-tauri/src/lib.rs` Rust tests

4. **文件写入非原子（H-2）**
   - 修复：`src-tauri/src/lib.rs` 增加 `atomic_write`，所有 JSON 保存均通过 tmp + rename。
   - 回归测试：`src-tauri/src/lib.rs` Rust tests

5. **词典查询阻塞 I/O（H-3）**
   - 修复：`src-tauri/src/lib.rs` 对 `check_dictionary` / `lookup_word` 使用 `spawn_blocking`。
   - 回归测试：并发场景由集成测试与后端测试覆盖

6. **CSP `connect-src` 过宽（H-7）**
   - 修复：`src-tauri/tauri.conf.json` 收紧为 `http://localhost:* http://127.0.0.1:* https:`。

7. **API Key 明文存储（H-10）**
   - 修复：新增 `src-tauri/src/secure_storage.rs`，使用 `keyring` crate 存储 API Key；`settings.json` 中只保留空字符串。
   - 回归测试：`src-tauri/src/lib.rs` / `src-tauri/src/secure_storage.rs` Rust tests

8. **持久化写入竞态（H-4）**
   - 修复：`src/hooks/usePersistence.ts` 移除 `handleAnnotationDelete` 中的手动读盘/写盘，统一由防抖 effect 处理；session effect 增加删除检测。
   - 回归测试：`src/hooks/usePersistence.test.tsx`

9. **分屏标注错显（H-5）**
   - 修复：`Annotation` 增加 `fileHash`，`PdfAnnotations` 按 `fileHash + page` 过滤；加载分屏 PDF 时合并 annotations。
   - 回归测试：`src/hooks/usePersistence.test.tsx`、`src/components/PdfAnnotations.test.tsx`

10. **关闭 Tab 未中止流式请求（H-6）**
    - 修复：`src/hooks/usePersistence.ts` 增加 `abortSessionsForTab`；`src/App.tsx` 关闭标签时调用。
    - 回归测试：`src/hooks/usePersistence.test.tsx`

11. **CI 缺少 type-check / lint / build / audit（H-11）**
    - 修复：新增 `eslint.config.js`、`.prettierrc.json` 与相关 npm scripts；CI workflow 增加对应步骤与 `cargo audit`（现 CI 已分层，见下文「持续集成」）。
    - 回归测试：CI 流水线自身验证

## 悬停取词翻译测试

新增功能「悬停取词翻译」涉及前端、后端与第三方资源下载，测试时需注意：

1. **离线词典下载**
   - 后端 `src-tauri/src/dictionary.rs` 的下载逻辑支持 HTTP Range 断点续传，并在连接中断、单块超时或服务器返回非成功状态码时自动重试最多 5 次；完整下载测试需要真实网络与较大临时空间，单元测试不覆盖真实下载。
   - 前端 `useDictionaryStatus` 与 `SettingsModal` 的测试通过 mock `invoke` 与 `listen` 验证状态流转：开关开启 → 检查词典 → 提示下载 → 下载完成 → 开关自动变 checked（本地状态）→ 用户点击保存后生效。开关切换本身不会立即保存或关闭设置窗口。

2. **单词提取与 tooltip**
   - `PdfViewer.tsx` 内的单词提取依赖 pdfjs 渲染后的 `TextItem` 几何信息，主要在集成环境 / E2E 中验证。
   - `WordTooltip.tsx` 为纯展示组件，可通过传入 `entry` / `loading` 等 props 单独测试。

3. **Mock 要点**
   - `check_dictionary`：返回 `{ exists: false, path: "" }` 模拟未下载；返回 `{ exists: true, path: "...", size: ... }` 模拟已就绪。
   - `download_dictionary`：返回 resolved Promise，并通过 `listen` 的回调推送 `{ status: "done", downloaded, total }` 模拟下载完成。
   - `lookup_word`：返回 `{ word, phonetic, translation, ... }` 或 `null`。

## 持续集成

CI 在 `.github/workflows/` 下分层触发，避免每次 push 都跑全量：

| Workflow       | 触发                               | 内容                                                                                              |
| -------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `ci-quick.yml` | 非 master 分支 push                | type-check / lint / 单元测试                                                                      |
| `ci-full.yml`  | master push / PR                   | 上述全部 + 前端 build + cargo test / clippy / audit + 双浏览器 E2E（三个 job 并行，Rust 依赖有缓存） |
| `release.yml`  | 手动 dispatch（输入版本号）        | 一键发版，当前仅发布 Windows 安装包与可执行文件                                                    |
| `landing.yml`  | master 上 `landing/**` 变更 / 手动 | 部署 GitHub Pages                                                                                 |

约定：`docs/**`、`landing/**`、`**.md` 的变更不触发 CI（paths-ignore）；审计类检查（npm audit / cargo audit）只在 master 集成时运行，不作为日常 push 门禁。

本地可按需单独运行各层检查以加快反馈：

```bash
npm ci
npx playwright install chromium
npm run test
npm run test:e2e
cd src-tauri && cargo test
```
