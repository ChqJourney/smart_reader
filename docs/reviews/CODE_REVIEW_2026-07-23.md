# 代码审查记录 2026-07-23（v0.9.5）

> 来源：文档同步（0.8.3 → 0.9.5）过程中对当前代码实现的一次全面审计。
> 仅记录问题，本次未修改任何代码。严重程度：高 / 中 / 低。

## 中等问题（建议优先处理）

### 1. LLM 401 错误透传可能回显 API Key（安全）

- 位置：`src-tauri/src/llm_proxy.rs:283-285`（`classify_http_error`）
- 问题：认证错误时把服务商响应体中的 `error.message` 原样作为 `Auth.detail` 透传前端。DeepSeek 等平台的 401 响应会回显 key（本文件测试样例 `:918` 即 `"Your api key: fake is invalid"`）。
- 影响面：该 detail 会被 `src/hooks/usePersistence.ts:599` 拼进会话消息 content 并落盘到 session JSON，也会在 UI 展示；`src/services/logs.ts` 的 `redactSensitiveInfo` 脱敏覆盖不到这条路径（detail 不经过日志）。
- 这是 keyring 链路上仅剩的明文暴露点。

### 2. Agent loop 轮次间隙无法中断（功能）

- 位置：`src/hooks/usePersistence.ts:904, 737, 1187-1191`
- 问题：`handleInterruptSession` 用 `abortPrefix(streamingMessageId)` 只能中止正在进行的那一轮流。若用户在工具执行阶段（两轮之间）点停止，`runAgentLoop` 不检查任何中断标志，下一轮 `runOneRound` 会新建未中止的 AbortController 继续发 LLM 请求。
- 现象：UI 已显示 `isStreaming: false`，但消息仍在流式更新。

### 3. macOS 文件关联打开会失败（功能）

- 位置：`src-tauri/src/lib.rs:223-237`（`RunEvent::Opened`）
- 问题：直接 emit `url.to_string()`，结果是 `file:///Users/x/y.pdf`（且空格等被百分号编码）。前端 `openPdfByPath` 原样传给 `read_pdf_bytes`，`std::fs::read` 按文件系统路径读取必失败。
- Windows 单实例走 argv 原始路径（`emit_open_pdf`）无此问题，仅 macOS 分支有。

## 低优先级问题

### 4. 死代码 / 未落地类型

- `src/components/ErrorBanner.tsx`：孤儿组件，全项目无任何 import（仅 `src/services/sessions.ts:22` 注释预留挂载点）。
- `src/types/llm.ts:22-47, 120-136`：`LlmProfile` / `LlmRequestConfig` / `ChatCompletionsRequest` / `TestConnectionRequest` / `TestConnectionResult` 从未被 import，描述的是不存在的「多 profile」设计（`profileId` 与后端实际 `StreamParams` 的 `platformId`/`requestId` 不符），易误导后续开发。

### 5. ContextWidget 半成品与传参不一致

- frozen 态无写入方：`frozen`/`frozenReason` 仅在 `src/services/sessions.ts:47-49` 定义，没有任何代码写 `session.frozen`；`AiChatPanel` 也未传 `onNewSession`。
- `App.tsx:768-771` 只在分屏分支给 AiChatPanel 传 `contextWindow`，单视图分支走组件默认值 128000，与实际模型上下文窗口可能不符。

### 6. `saveSettings` 吞错导致死代码与迁移丢 key

- 位置：`src/services/settings.ts:161-167`
- 问题：捕获 invoke 错误只记日志、从不抛出：
  1. `SetupWizard.tsx:232-236` 的 try/catch 成为死代码，保存失败用户无感知；
  2. `mergeWithLegacy`（`settings.ts:122-126`）在保存失败时仍 `removeItem` 旧 localStorage 配置，迁移中的 API key 直接丢失。

### 7. Markdown sanitize 放行 `style` 属性（安全，低）

- 位置：`src/components/MarkdownRenderer.tsx:78` + `src-tauri/tauri.conf.json:27`
- 问题：`"*"` 属性白名单含 `style`，且 CSP `style-src` 含 `'unsafe-inline'`。LLM 输出（或经 LLM 中转的恶意 PDF 文本）可用 `position:fixed` 等做界面覆盖/钓鱼。
- 事件处理器与 `javascript:` 协议已被 sanitize 拦截，仅 UI redress 级别，非 RCE。

### 8. `maxToolRounds` 兜底值与注释矛盾

- 位置：`src/hooks/usePersistence.ts:448-449`（`maxRounds = maxToolRounds > 0 ? maxToolRounds : 5`）vs `src/services/settings.ts:35-36`（注释「0 = use default 20」）
- UI 输入最小值为 1（`SettingsModal.tsx:732-755`），该分支实际不可达，但两处语义应统一。

### 9. 小 bug 隐患

- `src/components/TitleBar.tsx:46-52`：`.then()` 回调里的清理函数被 Promise 丢弃，`win.onResized` 监听在卸载后永不移除（组件生命周期≈应用生命周期，实际影响小）。
- `src/components/CommentPopup.tsx:73-78`：`[localContent]` effect 挂载时也执行，打开批注弹窗 300ms 后触发一次无实际变更的批注持久化写入。

### 10. 数据模型轻微不同步

- `Annotation.fileHash` 仅存在于 TS 侧（`src/services/annotations.ts:25`），Rust `Annotation`（`src-tauri/src/lib.rs:398-419`）没有该字段，`save_pdf_data` 序列化往返会丢弃它。当前靠加载时回填兜底（`usePersistence.ts:247,286`），功能不受影响；若将来依赖持久化的 `fileHash` 会踩坑。

## 核查无问题的项

- 版本号一致：`package.json` / `Cargo.toml` / `Cargo.lock` / `tauri.conf.json` 均为 0.9.5。
- 端口一致：playwright `baseURL`/webServer 与 vite 均为 1420；`package.json` scripts 引用文件均存在。
- 数据模型 serde 兼容：`InterpretationSession` / `StashSource` / `RecentFile` / `AppSettings` Rust↔TS 字段同步，新增字段均有 `#[serde(default)]`，旧数据兼容有测试覆盖。
- `open_path` 仅放行 http/https；`authorize_pdf_path` 路径校验（扩展名 + 精确匹配）无绕过。
- 日志未发现打印 API Key 或 PDF 正文（`llm_proxy.rs:603` 只记 model/url）。
- 词典解压无 zip-slip/zip-bomb 问题（固定文件名 `entry_{i}` + 1.5GB 上限）；但 sha256 完整性校验常量为空串（TODO，仅靠 HTTPS 防篡改）。
- CSP 已配置（`default-src 'self'` 等）；`connect-src` 放行任意 `https:` 是自定义 LLM Base URL 的设计权衡。
