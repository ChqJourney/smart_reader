# SpecReader AI 审核报告修复方案

> 对应审核报告：`AUDIT_REPORT.html`（审查日期 2026-07-11）
>
> 本方案逐条核实了报告中的 48 个问题，按优先级给出可执行的修复路径、涉及文件与验收标准。
>
> **修正说明**：本版已根据复核反馈对上一版方案进行修正，包括删除有缺陷的修复选项、补充遗漏项、明确安全降级策略、调整实施顺序等。

---

## 0. 核实结论概览

| 级别     | 数量 | 已核实可复现 | 备注                       |
| -------- | ---- | ------------ | -------------------------- |
| Critical | 5    | 5            | 均需立即修复               |
| High     | 11   | 11           | 影响安全、数据可靠性与交付 |
| Medium   | 18   | 18           | 工程债与体验问题           |
| Low      | 14   | 14           | 可渐进处理                 |

**核心判断**：审核报告指出的问题基本属实。其中 Critical/High 级问题（状态管理缺陷、路径穿越、无路径校验、非原子写入、API Key 明文、CSP 过宽、崩溃监控缺失）直接决定产品能否安全交付，应优先处理。

---

## 1. 修复优先级总览

建议按以下阶段推进：

1. **P0 — 安全与数据可靠性**：2~3 天
   - C-1、C-2、H-1、H-2、H-3、H-7、H-10
2. **P1 — 状态与资源正确性**：2 天
   - H-4、H-5、H-6
3. **P2 — 测试与质量门禁**：2~3 天
   - H-9（应与 C-1 同步或提前完成）、H-11
4. **P3 — 商业化基础设施**：1~2 周
   - C-3、C-4、C-5、H-8
5. **P4 — 工程体验优化**：持续迭代
   - Medium / Low 项

## 1.1 实施状态

已完成的项：

- **P0**：C-1、C-2、H-1、H-2、H-3、H-7、H-10
- **P1**：H-4、H-5、H-6
- **P2**：H-9、H-11
- **P3**：H-8（本地日志 + 全局 ErrorBoundary + panic hook；Sentry 远程上报作为可选后续项）、C-5（LICENSE 与元数据）

尚未实施的项：

- **P3**：C-3（自动更新）、C-4（代码签名）

已实施的项（本次 P4 与 Settings 改版完成后追加）：

- **P4**：M-1 ~ M-18、L-1 ~ L-14 已全部完成，包括 i18n 抽取、CSS 拆分、`useStreaming` 抽取、`PdfPage` 拆分、词典/日志/路径/单实例等优化。

---

## 2. Critical 级问题修复方案

### C-1. `handleFollowUp` 在 `setSessions` updater 内发起副作用

- **位置**：`src/hooks/usePersistence.ts:444-457`
- **核实**：已确认。`main.tsx:6` 启用了 `React.StrictMode`，开发模式下 state updater 会被双重调用，导致 LLM 流式请求双发。
- **推荐修复**（仅推荐此方案）：
  1. 在 `handleFollowUp` 内部用 ref 保存当前 `sessions` 快照。
  2. 基于快照计算新的 session 数组和 `updatedSession` 引用。
  3. 调用 `setSessions(nextSessions)` 进行纯状态更新。
  4. **在 `setSessions` 调用之后**（updater 外部），使用 `updatedSession` 直接调用 `runSessionStream(updatedSession, updatedSession.streamingMessageId!)`。
- **不推荐**：在 `useEffect` 中监听 `sessions` 变化并启动流。流式输出期间每个 chunk 都会更新 `sessions`，会导致 effect 反复触发；需要额外区分"新 session 需启动流"和"流式 chunk 更新中"，极易产生无限循环或重复启动流。
- **验收**：
  - 在 StrictMode 开发环境下，FollowUp 只产生一条 SSE 连接。
  - 单元测试中双重调用 `handleFollowUp` 只产生一个 AbortController（见 H-9 测试方案）。

### C-2. `session_path` 路径穿越漏洞

- **位置**：`src-tauri/src/lib.rs:284-287`
- **核实**：已确认。`session_id` 直接拼入文件名，若包含 `../` 可覆盖任意文件。
- **修复**：
  1. 新增 `validate_session_id(session_id: &str) -> Result<(), String>`，要求仅含 `A-Z`、`a-z`、`0-9`、`-`、`_`（UUID 格式兼容）。
  2. 在 `save_session_to_disk`、`delete_session_from_disk`、`load_session_from_disk` 入口调用校验。
  3. 增加 Rust 单元测试：非法 session id（含 `..`、`/`、`\`）应返回错误。
- **验收**：`cargo test` 新增路径穿越防护测试通过。

### C-3. 无自动更新机制

- **位置**：全项目
- **核实**：已确认。`Cargo.toml` 无 `tauri-plugin-updater`，`tauri.conf.json` 无 updater 配置。
- **修复**：
  1. 后端：添加 `tauri-plugin-updater = "2"` 依赖，在 `lib.rs` 初始化插件。
  2. 生成签名密钥对：
     ```bash
     cargo tauri signer generate -w ~/.tauri/specreader.key
     ```
     私钥 `specreader.key` 妥善保管并作为 CI secret；公钥写入 `tauri.conf.json` 的 `plugins.updater.pubkey`。
  3. 配置：在 `tauri.conf.json` 增加 `plugins.updater` 节点，配置 `endpoints`（指向 CDN/Release 下的 `.json` 更新清单）。
  4. 前端：应用启动后调用 `check()`，发现更新时提示用户；支持后台下载与安装重启。
  5. 签名：配合 C-4 完成更新包签名。
- **验收**：发布新版本后，旧版客户端能检测到更新并下载安装；更新包签名验证通过。

### C-4. 无代码签名配置

- **位置**：`src-tauri/tauri.conf.json:42`、`.github/workflows/cd.yml`
- **核实**：已确认。macOS `signingIdentity: "-"` 为 ad-hoc 签名；Windows 无签名；CD 仅 Windows 且 `--no-bundle`。
- **修复**：
  1. macOS：申请 Apple Developer ID，配置 `signingIdentity`、notarization（`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID` 通过 CI secrets 注入）。
  2. Windows：申请代码签名证书（OV/EV），在 CI 中使用 `signtool` 或 Tauri 的 `windows.certificateThumbprint`。
  3. CD：新增 `release-macos`（x64 + aarch64，可构建 universal binary）和 `release-linux`（x64 + aarch64 AppImage/deb）。
  4. 移除 `--no-bundle`，生成 `.dmg`、`.app`、`.msi`、`.appimage` 等可分发包。
- **验收**：Gatekeeper / SmartScreen 不再拦截；GitHub Release 包含多平台安装包。

### C-5. 无 LICENSE 文件与元数据缺失

- **位置**：`package.json`、`src-tauri/Cargo.toml:6`
- **核实**：已确认。无 LICENSE 文件，`Cargo.toml` 中 `license = ""`、`authors = ["you"]`、`description = "A Tauri App"`、`repository = ""`。
- **修复**：
  1. 在项目根目录添加 `LICENSE` 文件（商业软件建议采用自定义商业许可；如走开源，需与产品策略对齐）。
  2. 填写 `package.json` 的 `license`、`author`、`description`、`repository`。
  3. 填写 `Cargo.toml` 的 `license`、`authors`、`description`、`repository`。
  4. 如为商业软件，在设置界面或关于页面展示许可信息。
- **验收**：`npm run build` / `cargo build` 不再产生空 license 警告；根目录存在 LICENSE。

---

## 3. High 级问题修复方案

### H-1. `read_pdf_bytes` / `open_path` / `get_pdf_hash` 无路径校验

- **位置**：`src-tauri/src/lib.rs:76-98`
- **核实**：已确认。三个命令均接受任意路径。
- **修复**：
  1. **主方案 — 维护 dialog 授权文件白名单**：
     - 在 Rust 后端维护一个 `HashSet<String>`（或持久化到内存/临时文件），记录通过 `@tauri-apps/plugin-dialog` 选择的文件路径。
     - `read_pdf_bytes` / `get_pdf_hash` 执行前校验 `file_path` 是否在白名单中；不在白名单则返回错误。
     - 白名单在应用启动时为空，每次 `handleOpenPdf` / `openPdfByPath` 成功后加入。
  2. **补充校验 — 扩展名检查**：仅作为第二层防护，校验路径扩展名为 `.pdf`（大小写不敏感）。注意：单独的扩展名校验可被 `~/.ssh/id_rsa.pdf` 等方式绕过，不能替代白名单。
  3. **`open_path` 特殊处理**：
     - 经全代码扫描，`open_path` 当前在前端无任何调用点（仅注册未使用）。
     - 方案 A（推荐）：直接移除 `open_path` 命令，消除攻击面。
     - 方案 B：若保留，限制为 `http://`/`https://` 协议或本地 `.pdf` 文件；拒绝 `file://`、拒绝目录、拒绝可执行文件。
- **验收**：读取白名单外的非 PDF 路径返回 403/400 类错误；`open_path` 要么被移除要么受严格限制。

### H-2. 文件写入非原子操作

- **位置**：`src-tauri/src/lib.rs:318-404`
- **核实**：已确认。`save_pdf_data_to_disk`、`save_session_to_disk`、`save_settings_to_disk`、`save_recent_files_to_disk` 均直接 `std::fs::write`。
- **修复**：
  1. 新增统一的原子写入辅助函数 `atomic_write(path, content)`：先写入同目录 `.tmp` 文件（如 `settings.json.tmp`），再 `std::fs::rename` 覆盖目标文件。
  2. 所有保存函数改用该辅助函数。
  3. 对临时文件写入失败做清理，避免残留。
- **验收**：在保存过程中杀掉进程，目标 JSON 文件不被截断；`cargo test` 增加崩溃场景模拟。

### H-3. `lookup_word` / `check_dictionary` 阻塞 I/O 在 async runtime 上执行

- **位置**：`src-tauri/src/lib.rs:535-547`
- **核实**：已确认。`check_dictionary`（行 535-537）和 `lookup_word`（行 544-547）均为 async command，但直接调用同步文件/SQLite 操作。
- **修复**（仅推荐此方案）：
  - 将 `dictionary::check_dictionary` 和 `dictionary::lookup_word` 的同步逻辑用 `tauri::async_runtime::spawn_blocking` 包裹。
- **不推荐**：将 command 改为同步。Tauri 2 同步 command 在主线程执行，SQLite 阻塞查询会卡死整个命令分发线程，比 async + 阻塞更严重。
- **验收**：并发查词 / 检查词典时不会阻塞 tokio 工作线程。

### H-4. `handleAnnotationDelete` 手动写盘与防抖 effect 竞态

- **位置**：`src/hooks/usePersistence.ts:496-502`
- **核实**：已确认。手动 `loadPdfData → savePdfData` 与防抖 effect 竞争。
- **修复**：
  1. 删除 `handleAnnotationDelete` 中的手动 `loadPdfData` / `savePdfData` 调用。
  2. 该函数只更新内存中的 `sessions` 与 `annotations`。
  3. 防抖 effect 成为唯一写盘入口，并按以下逻辑推导需要保存的 PDF 与 session 关联：
     - 维护一个 `filePath -> sessionId set` 的映射。
     - 对每个 session，遍历 `session.sources`，将 `session.id` 加入该 source 对应 `filePath` 的集合。
     - 对每个打开的 PDF（activeTab 和 secondaryTab 的 filePath），保存其 annotations 和关联的 session ids。
     - 注意：自定义解读的 session 可能跨多个 PDF，必须从 `session.sources` 反推，不能仅按 activeTab.filePath 保存。
  4. 当前 debounce effect 已覆盖 activeTab 和 secondaryTab，需扩展为：监听 `annotations` 和 `sessions`，计算所有涉及 PDF 的保存集合。
- **验收**：删除解读标注后，500ms 内防抖保存的结果与内存状态一致；快速连续删除不丢数据；跨文件自定义解读的 session 在各 PDF 中的引用同步更新。

### H-5. 分屏视图两个 `PdfViewer` 共享同一 annotations 数组

- **位置**：`src/App.tsx:374-430`
- **核实**：已确认。两个 `PdfViewer` 都接收 `persistence.annotations`。
- **修复**：
  1. 方案 A（推荐）：为 `Annotation` 增加 `fileHash` 字段，`PdfAnnotations` 按 `fileHash + page` 过滤显示。
  2. 方案 B：在 `PdfViewer` 外层按 `fileHash` 过滤后传入 `annotations`。
  3. 同时修复：进入分屏时加载 secondary PDF 的 annotations（目前只加载 sessions）。
- **验收**：两个不同 PDF 同页码时，标注不会互相错显；分屏保存后各自 PDF 的标注独立恢复。

### H-6. 关闭 Tab 时运行中的流式请求未 abort，sessions 未清理

- **位置**：`src/App.tsx:231-246`
- **核实**：已确认。`handleCloseTab` 仅清理 stashes。
- **修复**：
  1. 在 `usePersistence` 中暴露 `abortSessionsForTab(tabId)` 或 `abortSessionsForFileHash(fileHash)`。
  2. `handleCloseTab` 中：找到该 tab 关联的 session，调用 `handleInterruptSession`；从 `sessions` 中移除；从 `annotations` 中移除该文件相关标注。
  3. 若 session 同时被另一个打开 tab 引用，则仅移除该 tab 的 annotations，不删除共享 session。
- **验收**：关闭标签后，Network 面板中该 tab 的 SSE 请求被 abort；内存中无残留 session。

### H-7. CSP `connect-src` 允许 `http:`

- **位置**：`src-tauri/tauri.conf.json:26`
- **核实**：已确认。`connect-src 'self' http: https:` 过宽。
- **修复**：
  - 将 `http:` 收紧为 `http://localhost:* http://127.0.0.1:*`，支持本地 LLM（如 Ollama）。
  - 如果必须支持任意自定义 HTTP 端点，应作为独立工作项将 LLM 请求代理到 Rust 后端（涉及 SSE 透传、API Key 管理、超时重试等），**不应与 CSP 收紧混为一谈**。
- **验收**：CSP 报错中不再允许任意 HTTP 域名；本地 Ollama 仍能访问。

### H-8. 无崩溃监控 / 错误上报系统

- **位置**：全项目
- **核实**：已确认。无 Sentry/Bugsnag，无全局 ErrorBoundary，`tauri-plugin-log` 仅在 debug 初始化。
- **修复**：
  1. **Release 本地日志**：移除 `cfg!(debug_assertions)` 限制，在 `src-tauri/src/lib.rs` 的 `setup` 中始终初始化 `tauri-plugin-log`；日志目录为 `<AppData>/SpecReader/logs/`，文件名为 `app.log`；Release 默认 `Warn` 级别，Debug 默认 `Info` 级别；单文件 10 MB 上限并启用 `KeepAll` 轮转；时区使用本地时间。
  2. **用户导出日志**：新增 `open_logs_dir` Tauri 命令，在 `SettingsModal` 底部和全局 `ErrorBoundary` fallback 中提供「打开日志目录」按钮。
  3. **全局错误边界**：新增 `src/components/ErrorBoundary.tsx`，在 `src/main.tsx` 最外层包裹 `<App />`，捕获未处理 React 异常并显示「重新加载」/「打开日志目录」入口。
  4. **Rust panic 捕获**：在 `src-tauri/src/main.rs` 设置自定义 `panic_hook`，将 panic 信息写入日志后保留默认行为，确保 Release 崩溃也能留下排查痕迹。
  5. **Sentry 远程上报（可选后续项）**：默认不启用，需用户在 Settings 中配置 DSN。涉及 `@sentry/react` + `sentry` crate 集成，不应与本地日志混为一谈；只上报异常堆栈，不上传 PDF 内容、选中文本、API Key、文件路径。
- **验收**：
  - Release 构建运行后 `<AppData>/SpecReader/logs/app.log` 存在且包含 Warn 及以上级别日志。
  - Settings 中点击「打开日志目录」可打开日志所在文件夹。
  - 人为在组件内抛错时全局 ErrorBoundary 显示 fallback UI。
  - Rust 端发生 panic 时日志文件记录 panic 信息。
  - `cargo test`、`npm run test`、`npm run type-check`、`npm run lint` 均通过。

### H-9. `usePersistence.ts` 零直接测试

- **位置**：`src/hooks/usePersistence.ts`
- **核实**：已确认。无 `usePersistence.test.ts`。
- **修复**：
  1. 新增 `src/hooks/usePersistence.test.tsx`。
  2. 覆盖场景：
     - 加载 PDF 数据后 annotations / sessions 正确初始化。
     - 启动解释/翻译后 `isStreaming` 与 AbortController 关联。
     - `handleInterruptSession` 正确 abort。
     - `handleAnnotationDelete` 删除 session 并触发防抖保存。
     - 切换 activeTab 时 state 正确重置。
     - StrictMode 下 `handleFollowUp` 不会双发（直接验证 C-1）。
  3. Mock 依赖：
     - `@tauri-apps/api/core` 的 `invoke`
     - `@tauri-apps/api/event` 的 `listen`
     - `crypto.randomUUID`
     - `localStorage`
     - `AbortController`
     - `streamChatCompletion`（mock 为可控的 async generator，支持 emit chunk/error/abort）
- **验收**：`usePersistence` 语句覆盖率达到 80% 以上；C-1 双重调用测试通过。

### H-10. API Key 明文存储在 JSON 文件中

- **位置**：`src-tauri/src/lib.rs:216-222`
- **核实**：已确认。`settings.json` 中 `apiKey` 明文保存。
- **修复**：
  1. 后端：直接使用 Rust `keyring` crate（较 `tauri-plugin-keyring` 更成熟稳定），将 `apiKey` 存入系统钥匙串（macOS Keychain / Windows Credential Manager / Linux Secret Service）。
  2. `save_settings` 时将 `apiKey` 分离保存到 keyring，settings 文件中只保留占位或空字符串。
  3. `load_settings` 时从 keyring 读取 `apiKey` 并回填。
  4. **旧数据迁移**：`load_settings` 时若钥匙串中无 API Key，但旧版 `settings.json` 中仍有明文 `apiKey`，则自动将其迁入钥匙串并清空磁盘文件中的明文字段，避免老用户升级后 key 丢失。
  5. **降级策略**：keyring 不可用时**拒绝保存 API Key 并提示用户**，不静默回退到明文存储。商业软件应明确安全降级策略，避免在钥匙串不可用时泄露密钥。
- **验收**：`settings.json` 中看不到明文 API Key；LLM 请求仍正常携带；keyring 不可用时给出明确错误提示；老用户升级时明文 key 自动迁移到 keyring。

### H-11. CI 缺少 type-check / lint / build / 安全扫描

- **位置**：`.github/workflows/ci.yml`
- **核实**：已确认。CI 只有 test 和 e2e。
- **修复**：
  1. 添加 `eslint` + `prettier` + `@typescript-eslint` 配置。
  2. CI 增加步骤：
     - `npm run lint`
     - `npm run type-check`（新增脚本：`tsc --noEmit`）
     - `npm run build`
     - `npm audit --audit-level=moderate`
     - `cargo audit`（需安装 `cargo-audit`）
  3. 可选：设置覆盖率阈值（lines 80%）。
- **验收**：CI 流水线包含上述步骤且全部通过。

---

## 4. Medium 级问题修复方案（精选）

| 编号 | 问题                                        | 修复动作                                                                                           | 涉及文件                                        |
| ---- | ------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| M-1  | JSON 持久化无并发写入保护                   | 在原子写入基础上加文件锁（`fs2::FileExt`）或串行化同一文件写入任务                                 | `lib.rs`                                        |
| M-2  | `compute_pdf_hash` 整文件读入内存           | 改为流式分块读取计算 SHA-256                                                                       | `lib.rs:100-106`                                |
| M-3  | 流式逻辑未统一抽取                          | 新增 `useStreaming` hook，封装 SSE、累积、错误、abort；`TranslatePopup` 与 `usePersistence` 复用   | `src/hooks/useStreaming.ts`                     |
| M-4  | `textContent.items` 使用 `any`              | 使用 `pdfjs-dist` 的 `TextItem` / `TextMarkedContent` 类型联合并收窄                               | `PdfViewer.tsx:224-226`                         |
| M-5  | 模态框无 Escape 关闭与焦点陷阱              | 自定义 `useModal` hook：监听 Escape、Focus Trap（Tab 循环）、点击 overlay 关闭                     | `SettingsModal.tsx`、`CustomInterpretModal.tsx` |
| M-6  | 全硬编码中文                                | 引入 `react-i18next`，抽取 UI 文案；`index.html` lang 改为 `zh-CN`                                 | `src/locales/*`、`index.html`                   |
| M-7  | 使用 `window.confirm` / `alert`             | 替换为 Tauri `dialog:confirm` / 自定义确认 Modal                                                   | `usePersistence.ts:484`、`useTabs.ts:39`        |
| M-8  | `dictionary.rs` 结构体缺 `rename_all`       | 为 `DictionaryStatus` / `DictEntry` / `DownloadProgress` 添加 `#[serde(rename_all = "camelCase")]` | `dictionary.rs:17-44`                           |
| M-9  | Release 构建无日志                          | 在 Release 中初始化 `tauri-plugin-log`，日志级别 Warn，输出到文件                                  | `lib.rs:39-45`                                  |
| M-10 | E2E 仅 chromium                             | 增加 WebKit 项目；补充核心用户流程 E2E（打开 PDF → 选中文本 → 翻译/解读 → 持久化 → 重启恢复）      | `playwright.config.ts`、`e2e/`                  |
| M-11 | `identifier` 不符合 reverse-DNS             | 改为 `com.photonee.specreader` 或公司正式 reverse-DNS                                              | `tauri.conf.json:5`                             |
| M-12 | `sortedSessions` / `renderPages` 未 memoize | `useMemo` 包裹                                                                                     | `AiChatPanel.tsx:84`、`PdfViewer.tsx:911-920`   |
| M-13 | `lineThreshold` 魔法数字                    | 提取常量 `const LINE_GROUPING_THRESHOLD = 4`；统一使用                                             | `PdfViewer.tsx`                                 |
| M-14 | `app_data_dir` 重复定义                     | 迁移到公共模块 `src-tauri/src/paths.rs`，两处复用                                                  | `lib.rs`、`dictionary.rs`                       |
| M-15 | tokio `time` feature 未显式启用             | `Cargo.toml` 增加 `time` feature                                                                   | `Cargo.toml:34`                                 |
| M-16 | 词典下载缺校验和                            | 在服务器发布校验和文件，下载后比对 SHA-256；失败则删除并重试                                       | `dictionary.rs`                                 |
| M-17 | macOS 单实例 / 文件关联未实现               | 接入 `tauri-plugin-deep-link` 或平台特定 RunEvent 处理                                             | `lib.rs:68-72`                                  |
| M-18 | `single-instance` 未平台条件化              | 将 `tauri-plugin-single-instance` 改为 `#[cfg(any(windows, linux))]` 依赖                          | `Cargo.toml:32`                                 |

---

## 5. Low 级问题修复方案（精选）

| 编号 | 问题                                       | 修复动作                                                            | 涉及文件                         |
| ---- | ------------------------------------------ | ------------------------------------------------------------------- | -------------------------------- |
| L-1  | `secondaryTab` 每次渲染 find               | `useMemo` 缓存                                                      | `App.tsx:50-51`                  |
| L-2  | `AiChatPanel` 自动切 tab 打断用户          | 仅在初始无 stash 时切换；用户手动切过后不再自动覆盖                 | `AiChatPanel.tsx:68-70`          |
| L-3  | `index.html lang="en"`                     | 改为 `zh-CN`                                                        | `index.html:2`                   |
| L-4  | `TranslatePopup` effect 空依赖但引用 props | 补充正确依赖或拆分逻辑；避免卸载时 `onUpdate` 引用旧闭包            | `TranslatePopup.tsx:56-108`      |
| L-5  | `PdfViewer.tsx` 过大                       | 将 `PdfPage` 拆分到独立文件                                         | `src/components/PdfPage.tsx`     |
| L-6  | `useRightPanelLayout` 渲染期同步读 DOM     | 用 `useLayoutEffect` + state 缓存，避免布局抖动                     | `useRightPanelLayout.ts:120-135` |
| L-7  | `App.css` 过大                             | 按组件/页面拆分为多个 CSS 文件                                      | `src/components/*.css`           |
| L-8  | `useDictionaryStatus` 多处实例化状态不同步 | 提升到 Context 或 App 顶层通过 props 下发                           | `App.tsx`、`SettingsModal.tsx`   |
| L-9  | `let _ =` 静默吞错误                       | 使用 `?` 传播或显式 `map_err` 日志                                  | `lib.rs`、`dictionary.rs` 多处   |
| L-10 | `read_pdf_bytes_reads_file` 测试无价值     | 改为测试 `read_pdf_bytes` command 实际返回 PDF 字节                 | `lib.rs:793-800`                 |
| L-11 | `DICT_CONNECTION` Mutex 查询期间持有       | 改为每次查询时打开连接并关闭，或使用 `r2d2` 连接池                  | `dictionary.rs:451-490`          |
| L-12 | 词典下载 URL 硬编码                        | 抽离配置，支持环境变量或镜像列表                                    | `dictionary.rs:6-7`              |
| L-13 | `tauri-plugin-shell` 未授权                | 在 `capabilities/default.json` 添加 `shell:default` 或仅允许 `open` | `capabilities/default.json`      |
| L-14 | `goToPage` scroll 监听器可能泄漏           | 在 `useEffect` cleanup 中确保移除 listener 并清除 timeout           | `PdfViewer.tsx:784-796`          |

---

## 6. 推荐实施顺序（前 15 项）

1. **H-9** 为 `usePersistence` 添加直接单元测试（为 C-1 验收做准备）
2. **C-1** 修复 `handleFollowUp` StrictMode 双发
3. **C-2** 修复 `session_path` 路径穿越
4. **H-1** 为 PDF 相关命令添加路径校验
5. **H-2** 实现原子文件写入
6. **H-3** `lookup_word` / `check_dictionary` 改用 `spawn_blocking`
7. **H-4** 统一持久化写入为单一防抖入口
8. **H-5** 修复分屏标注跨文件错显
9. **H-6** 关闭 Tab 时 abort 流式请求并清理资源
10. **H-7** 收紧 CSP `connect-src`
11. **H-10** API Key 迁移到系统钥匙串
12. **H-11** CI 增加 type-check / lint / build / audit
13. **C-3** 添加自动更新机制
14. **C-4** 配置代码签名 + 多平台 CD
15. **C-5** 添加 LICENSE + 填写元数据

---

## 7. 验收检查清单

- [x] `npm run test` 通过且覆盖率提升。
- [x] `npm run build` 通过（`npx tsc --noEmit` 通过）。
- [x] `cd src-tauri && cargo test` 通过。
- [x] 在 `React.StrictMode` 开发环境下，翻译/解读/追问均只产生一条 SSE 请求（C-1 单元测试覆盖）。
- [x] 关闭标签后，对应 SSE 请求被 abort，专属 session/annotation 被清理（H-6 单元测试覆盖）。
- [x] 分屏打开两个不同 PDF，标注不互相错显（H-5 单元测试覆盖）。
- [x] 保存过程中强制退出，PDF 标注文件不损坏（H-2 原子写入测试通过）。
- [x] `settings.json` 中无 API Key 明文（H-10 实现并测试）。
- [x] 非法 session id 无法写入 sessions 目录外（C-2 测试通过）。
- [x] CI 包含 type-check、lint、build、audit（H-11 已更新 `.github/workflows/ci.yml`）。

---

## 8. 说明

- 本方案基于 `AUDIT_REPORT.html` 中的指控逐条核对源码后整理，所有 Critical/High 项均已定位到具体文件与行号。
- 实施时建议每个问题独立 PR，便于 review 与回滚。
- 商业化基础设施（自动更新、代码签名、崩溃监控）涉及证书/账号申请，可与代码修复并行推进。
- 本版已根据复核反馈修正了上一版中的缺陷选项、遗漏项和实施顺序问题。
