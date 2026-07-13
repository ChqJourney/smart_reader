# 审核报告修复方案

> 基于源码核实的修复方案，对应 `AUDIT_REPORT_COMMERCIAL_2026-07-13.html` 中的全部发现。
>
> 版本基准：v0.7.0 · 核实日期：2026-07-13

---

## P0 · 发布阻断项（2-3 周）

### D1 · 代码签名

**问题**：macOS `signingIdentity: "-"`（ad-hoc），Windows exe 未签名。Gatekeeper / SmartScreen 将阻止安装。

**修复方案**：

#### macOS

1. 采购 Apple Developer ID Application 证书（$99/年）。
2. 将证书导出为 `.p12`，base64 编码后存入 GitHub Secrets：`MACOS_CERTIFICATE`、`MACOS_CERTIFICATE_PWD`。
3. 在 `cd.yml` 新增 `release-macos` job（`runs-on: macos-latest`），导入证书后构建：

```yaml
- name: Import code signing certificate
  run: |
    echo ${{ secrets.MACOS_CERTIFICATE }} | base64 --decode > certificate.p12
    security create-keychain -p "" build.keychain
    security import certificate.p12 -k build.keychain -P ${{ secrets.MACOS_CERTIFICATE_PWD }} -T /usr/bin/codesign
    security set-key-partition-list -S apple-tool:,apple: -s -k "" build.keychain

- name: Sign and notarize
  env:
    APPLE_ID: ${{ secrets.APPLE_ID }}
    APPLE_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
    APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
  run: npm run tauri build
```

4. 修改 `tauri.conf.json`：

```json
"macOS": {
  "signingIdentity": "Developer ID Application: Your Team (XXXXXXXXXX)",
  "entitlements": null
}
```

#### Windows

1. 采购 Windows Authenticode 代码签名证书（OV 或 EV）。
2. 将证书存入 GitHub Secrets：`WINDOWS_CERTIFICATE`（base64 pfx）、`WINDOWS_CERTIFICATE_PWD`。
3. 在 `cd.yml` 的 `release-windows` job 中，构建前导入证书：

```yaml
- name: Import code signing certificate
  shell: pwsh
  run: |
    $certBytes = [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE)
    [IO.File]::WriteAllBytes("cert.pfx", $certBytes)
    $pwd = ConvertTo-SecureString -String $env:WINDOWS_CERTIFICATE_PWD -AsPlainText -Force
    Import-PfxCertificate -FilePath cert.pfx -CertStoreLocation Cert:\CurrentUser\My -Password $pwd
  env:
    WINDOWS_CERTIFICATE: ${{ secrets.WINDOWS_CERTIFICATE }}
    WINDOWS_CERTIFICATE_PWD: ${{ secrets.WINDOWS_CERTIFICATE_PWD }}
```

4. 在 `tauri.conf.json` 中配置签名参数：

```json
"windows": {
  "certificateThumbprint": null,
  "digestAlgorithm": "sha256",
  "timestampUrl": "http://timestamp.digicert.com"
}
```

**验证**：构建产物在未修改系统设置的 macOS / Windows 上可正常安装运行，无安全警告。

---

### S1 · LLM 调用代理到 Rust 后端，API Key 不进入 WebView

**问题**：`load_settings` 从钥匙串读出 API Key 经 IPC 返回前端，`streamChatCompletion` 在 WebView 中直连 LLM API，Key 长期驻留 JS 内存。

**修复方案**：

#### 1. 后端新增 Tauri 命令 `stream_chat`

在 `src-tauri/src/lib.rs` 新增命令，从钥匙串读取 Key，用 reqwest 发起 SSE 请求，通过 tauri event 逐 chunk 推送前端：

```rust
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamChatRequest {
    messages: Vec<ChatMessage>,
    model: String,
    base_url: String,
}

#[tauri::command]
async fn stream_chat(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    request: StreamChatRequest,
) -> Result<(), String> {
    let storage = state.api_key_storage.clone();
    let api_key = match storage.retrieve()? {
        Some(k) => k,
        None => return Err("API key not configured".to_string()),
    };

    let url = format!("{}/chat/completions", request.base_url);
    let body = serde_json::json!({
        "model": request.model,
        "messages": request.messages,
        "stream": true,
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let _ = app.emit("llm-stream-error", &text);
        return Err(format!("LLM API error: {}", status));
    }

    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream read error: {}", e))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        let lines: Vec<&str> = buffer.split('\n').collect();
        buffer = lines.last().unwrap_or("").to_string();

        for line in &lines[..lines.len().saturating_sub(1)] {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed == "data: [DONE]" { continue; }
            if let Some(data) = trimmed.strip_prefix("data: ") {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(delta) = parsed["choices"][0]["delta"]["content"].as_str() {
                        let _ = app.emit("llm-stream-chunk", delta);
                    }
                }
            }
        }
    }

    let _ = app.emit("llm-stream-done", ());
    Ok(())
}
```

在 `generate_handler!` 中注册 `stream_chat`。添加 `Cargo.toml` 依赖 `futures-util = "0.3"`。

#### 2. 后端 `load_settings` 不再返回 API Key

修改 `load_settings_with_storage`（`lib.rs:738`），返回前清空 key：

```rust
// 在 Ok(settings) 之前添加：
settings.llm.api_key = String::new();
```

#### 3. 前端改用 Tauri event 接收流

修改 `src/services/llm.ts`，将 `streamChatCompletion` 改为通过后端代理：

```typescript
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export async function* streamChatCompletion(
  config: LlmConfig,
  messages: ChatMessage[],
  signal?: AbortSignal
): AsyncGenerator<
  { type: "chunk"; content: string } | { type: "error"; message: string },
  void
> {
  const unlisteners: (() => void)[] = [];
  type Item =
    | { type: "chunk"; content: string }
    | { type: "error"; message: string }
    | { type: "done" };
  const pending: Item[] = [];
  let resolveItem: ((item: Item) => void) | null = null;

  const push = (item: Item) => {
    if (resolveItem) { resolveItem(item); resolveItem = null; }
    else { pending.push(item); }
  };

  unlisteners.push(await listen<string>("llm-stream-chunk", (e) =>
    push({ type: "chunk", content: e.payload })));
  unlisteners.push(await listen<string>("llm-stream-error", (e) =>
    push({ type: "error", message: e.payload })));
  unlisteners.push(await listen("llm-stream-done", () => push({ type: "done" })));

  signal?.addEventListener("abort", () => {
    invoke("abort_stream_chat").catch(() => {});
  });

  invoke("stream_chat", {
    request: { messages, model: config.model, baseUrl: config.baseUrl },
  }).catch((err) => push({ type: "error", message: String(err) }));

  try {
    while (true) {
      const item = pending.length > 0
        ? pending.shift()!
        : await new Promise<Item>((resolve) => { resolveItem = resolve; });
      if (item.type === "done") return;
      if (item.type === "error") { yield { type: "error", message: item.message }; return; }
      yield { type: "chunk", content: item.content };
    }
  } finally {
    unlisteners.forEach((fn) => fn());
  }
}
```

#### 4. CSP 收紧（与 S3 合并）

修改 `tauri.conf.json`，移除 `connect-src` 中的 `https:`。

**验证**：DevTools 搜索不到 API Key；翻译/解读流式输出正常；中止按钮正常终止。

---

### R1 · pdf.js 文档 destroy

**问题**：`PdfViewer.tsx:330-332` 的 load effect cleanup 仅设 `isCancelled = true`，旧 `PDFDocumentProxy` 从未调用 `.destroy()`。

**修复方案**：

修改 `src/components/PdfViewer.tsx`：

1. 新增 ref 保存当前 pdf 实例：

```tsx
const pdfRef = useRef<PDFDocumentProxy | null>(null);
```

2. 在 `loadPdf` 中 `setPdf` 之前，销毁旧文档并更新 ref：

```tsx
pdfRef.current?.destroy();
pdfRef.current = loadedPdf;
setPdf(loadedPdf);
```

3. 在 load effect 的 cleanup 中销毁：

```tsx
return () => {
  isCancelled = true;
  loadingTask?.destroy();
  pdfRef.current?.destroy();
  pdfRef.current = null;
};
```

4. 组件卸载时也需销毁（新增独立 effect）：

```tsx
useEffect(() => {
  return () => { pdfRef.current?.destroy(); };
}, []);
```

**验证**：连续打开 5 个大 PDF（>50MB），Activity Monitor 确认内存不会持续膨胀。

---

### P1 · 大文档性能

**问题**：`loadViewports`（542-563）对所有页调用 `getPage(i)`；搜索（615-682）每次按键触发全量遍历，无防抖。

**修复方案**：

#### 1. 视口懒计算

将 `loadViewports` 改为仅计算前 10 页（初始可视区域），后续按需补充：

```tsx
const initialPages = Math.min(numPages, 10);
for (let i = 1; i <= initialPages; i++) { ... }
```

滚动时通过 IntersectionObserver 检测新进入的页面，按需计算并补充到 `pageViewports`。

页码跳转时，如果目标页 viewport 尚未计算，先同步计算再跳转：

```tsx
if (viewMode === "continuous" && !pageViewports.has(page)) {
  const pg = await pdf.getPage(page);
  const vp = pg.getViewport({ scale });
  setPageViewports(prev => new Map(prev).set(page, { width: vp.width, height: vp.height }));
}
```

#### 2. 搜索防抖

在 `searchQuery` 变化的 effect 中增加 300ms 防抖：

```tsx
let cancelled = false;
const timer = setTimeout(() => {
  const build = async () => { /* 原有 build 逻辑 */ };
  build();
}, 300);

return () => { cancelled = true; clearTimeout(timer); };
```

**验证**：200 页 PDF 首次加载 <5s；搜索框快速输入不会每次按键触发全量扫描。

---

### D2 · 补齐 macOS 构建流水线

**问题**：`cd.yml` 仅 Windows runner，无 macOS / Linux 构建。

**修复方案**：

在 `cd.yml` 新增 `release-macos` job：

```yaml
release-macos:
  name: Release macOS
  runs-on: macos-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: ${{ env.NODE_VERSION }}
        cache: "npm"
    - uses: dtolnay/rust-toolchain@stable
      with:
        targets: aarch64-apple-darwin,x86_64-apple-darwin
    - run: npm ci
    # 导入证书（见 D1）
    - name: Build universal binary
      run: npm run tauri build -- --target universal-apple-darwin
    - name: Upload to Release
      uses: softprops/action-gh-release@v2
      with:
        files: |
          src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg
```

更新 `latest.json` 增加 `darwin-aarch64` 和 `darwin-x86_64` 平台条目。

**验证**：tag push 后 Release 中包含 macOS dmg 和 Windows exe。

---

## P1 · 安全收敛（3-4 天）

### S2 · 离线词典下载完整性校验

**问题**：`dictionary.rs:32,37` 两个 SHA-256 常量为空串，下载后仅做 schema 校验。

**修复方案**：

1. 下载当前发布版 ECDICT zip，计算 SHA-256：

```bash
shasum -a 256 ecdict.sqlite.zip
shasum -a 256 ecdict.sqlite
```

2. 将哈希值填入常量：

```rust
const EXPECTED_DICT_ZIP_SHA256: &str = "abcdef1234567890...";
const EXPECTED_DICT_SQLITE_SHA256: &str = "0987654321fedcba...";
```

3. 确认 `download_dictionary` 中已有校验逻辑会自动生效（空串时跳过，非空时校验）。

**验证**：篡改临时文件后下载，校验失败并删除。

---

### S3 · CSP connect-src 收紧

**问题**：`tauri.conf.json:26` 允许任意 `https:`。

**修复方案**：完成 S1 后，移除 `connect-src` 中的 `https:`：

```
connect-src 'self' http://localhost:* http://127.0.0.1:*;
```

**验证**：应用功能正常，WebView 不再能直连外部 HTTPS。

---

### S4 · 移除未使用的 shell 能力

**问题**：`capabilities/default.json:10` 授予 `shell:default`，但应用通过 `open` crate 打开路径，未使用 `tauri-plugin-shell`。

**修复方案**：

1. 移除 `src-tauri/capabilities/default.json` 中的 `"shell:default"`：

```json
{
  "permissions": [
    "core:default",
    "dialog:default",
    "log:default",
    "updater:default",
    "process:default"
  ]
}
```

2. 移除 `src-tauri/Cargo.toml` 中的依赖：

```toml
# 删除这行
tauri-plugin-shell = "2"
```

3. 移除 `src-tauri/src/lib.rs:123` 的 plugin 注册：

```rust
// 删除这行
.plugin(tauri_plugin_shell::init())
```

**验证**：`cargo build` 通过，应用功能正常。

---

### S5 · load/save_pdf_data 增加 validate_pdf_access

**问题**：`lib.rs:799-827` 的 `load_pdf_data` 和 `save_pdf_data` 未调用 `validate_pdf_access`。

**修复方案**：

在两个命令入口添加校验：

```rust
#[tauri::command]
async fn load_pdf_data(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    file_path: String,
) -> Result<PdfAnnotationsFile, String> {
    validate_pdf_access(&state, &file_path)?;  // 新增
    let cache = state.pdf_hash_cache.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base_dir = paths::app_data_dir(&app)?;
        load_pdf_data_from_disk(&cache, &base_dir, &file_path)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
async fn save_pdf_data(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    file_path: String,
    data: PdfAnnotationsFile,
) -> Result<(), String> {
    validate_pdf_access(&state, &file_path)?;  // 新增
    let cache = state.pdf_hash_cache.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base_dir = paths::app_data_dir(&app)?;
        save_pdf_data_to_disk(&cache, &base_dir, &file_path, data)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}
```

**验证**：未授权路径调用这两个命令返回错误。

---

## P2 · 健壮性（2-3 天）

### R2 · saveSettings/loadSettings 错误可见

**问题**：`settings.ts:124-130` 钥匙串写入失败时 catch 吞掉，用户无感知。

**修复方案**：

修改 `saveSettings` 不再吞错，将错误回传调用方：

```typescript
export async function saveSettings(settings: AppSettings): Promise<void> {
  await invoke("save_settings", { settings });
}
```

在调用方（`SettingsModal.tsx`）的保存按钮 handler 中加 try/catch，失败时弹出提示。

**验证**：模拟钥匙串不可用（如测试环境），保存设置后 UI 显示错误提示。

---

### S6 · 日志脱敏规则扩展

**问题**：`logs.ts:26-28` 仅匹配 `sk-` 和 `Bearer` 模式，非 `sk-` 格式的 Key 可能漏脱敏。

**修复方案**：

扩展 `redactSensitiveInfo` 的正则规则：

```typescript
export function redactSensitiveInfo(message: string): string {
  return (
    message
      // OpenAI-style: sk-...
      .replace(/sk-[a-zA-Z0-9_-]{20,}/g, "[REDACTED]")
      // Anthropic: sk-ant-...
      .replace(/sk-ant-[a-zA-Z0-9_-]{20,}/g, "[REDACTED]")
      // Azure: hex keys (48+ chars)
      .replace(/[a-f0-9]{48,}/gi, "[REDACTED]")
      // Generic Bearer tokens
      .replace(/Bearer\s+\S+/g, "Bearer [REDACTED]")
      // Generic key=... patterns
      .replace(/(?:api[_-]?key|secret|token|password)["'\s:=]+\S+/gi, "[REDACTED]")
      // 路径脱敏（原有）
      .replace(/(?:\/Users\/[^/\s]+|\/home\/[^/\s]+)(?=\/)/g, "~")
      .replace(/[A-Za-z]:\\Users\\[^\\\s]+(?=\\)/g, "~")
  );
}
```

**验证**：构造包含各种格式 Key 的日志字符串，确认全部被脱敏。

---

### S7 · 移除 open_path 死代码

**问题**：`lib.rs:244-256` 的 `open_path` 命令无前端调用方，但仍在 `generate_handler!` 中注册。

**修复方案**：

1. 移除 `src-tauri/src/lib.rs` 中的 `open_path` 函数（244-256 行）和 `validate_open_url` 函数（250-256 行）。
2. 从 `generate_handler!` 中移除 `open_path`（179 行）。

**注意**：`open_logs_dir` 和 `open_default_apps_settings` 使用 `open::that` crate 而非 `open_path` 命令，不受影响。

**验证**：`cargo build` 通过，前端功能正常。

---

### C1 · Mutex unwrap 改为安全访问

**问题**：`lib.rs:55,60` 对 `Mutex` 用 `.unwrap()`，release `panic="abort"` 下 poison 即退出。

**修复方案**：

将 `authorize_path` 和 `is_path_allowed` 中的 `.unwrap()` 改为 `unwrap_or_else`：

```rust
fn authorize_path(&self, path: &std::path::Path) {
    self.allowed_paths
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(path.to_path_buf());
}

fn is_path_allowed(&self, path: &std::path::Path) -> bool {
    self.allowed_paths
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(path)
}
```

同理修改 `compute_pdf_hash_cached`（287,298 行）和其他 `.lock().unwrap()` 处。

**验证**：`cargo test` 通过。

---

### C2 · 写锁注册表与哈希缓存回收

**问题**：`ATOMIC_WRITE_LOCKS`（600 行）和 `pdf_hash_cache` 只增不删，随文件数增长。

**修复方案**：

#### 哈希缓存 LRU

将 `pdf_hash_cache` 的 `HashMap` 替换为带容量上限的 LRU：

```rust
use std::collections::VecDeque;

struct LruCache<K, V> {
    map: HashMap<K, V>,
    order: VecDeque<K>,
    capacity: usize,
}
```

或直接使用 `lru` crate（添加依赖 `lru = "0.12"`）。

容量设为 20（足够覆盖用户同时打开的 Tab 数上限 10 的两倍）。

#### 写锁回收

在 `atomic_write` 完成后，如果该路径无其他等待者则从注册表移除：

```rust
fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let file_lock = file_write_lock(path)?;
    let _guard = file_lock.lock().unwrap_or_else(|e| e.into_inner());
    // ... 写入逻辑 ...

    // 写完后尝试回收：如果 Arc 引用计数为 1，说明无其他等待者
    // 可以从注册表移除（可选优化，影响较小）
    Ok(())
}
```

**验证**：打开/关闭大量文件后，内存中锁注册表条目不无限增长。

---

## P3 · 工程体验（持续）

### D3 · 设置保存失败反馈 + 关于页

**问题**：设置保存失败无 UI 反馈；缺"关于/许可"页。

**修复方案**：

1. 在 `SettingsModal.tsx` 的保存 handler 中加 try/catch，失败时显示错误提示。
2. 在设置弹窗左侧分页新增"关于"页，展示版本号、License 信息、开源依赖声明。

---

### D4 · 黄金路径 E2E 测试

**问题**：E2E 仅覆盖布局与页码跳转，缺核心业务路径覆盖。

**修复方案**：

新增 `e2e/golden-path.spec.ts`，覆盖：打开 PDF -> 选中文本 -> 翻译 -> 解读 -> 关闭 -> 重开恢复批注与会话。

需要 mock `streamChatCompletion` 返回固定 SSE 响应。

---

### D5 · 测试覆盖率阈值

**问题**：`vite.config.ts` 未设 `thresholds`。

**修复方案**：

在 `vite.config.ts` 的 `test.coverage` 中添加：

```typescript
coverage: {
  provider: "v8",
  thresholds: {
    lines: 70,
    functions: 70,
    branches: 60,
    statements: 70,
  },
},
```

---

### P2 · 大文件流式读取

**问题**：`read_pdf_bytes` 整文件读入 `Vec<u8>` 再经 IPC 传为 ArrayBuffer，100MB+ 文件内存峰值高。

**修复方案**：

中短期：在 `read_pdf_bytes` 中对大文件（>50MB）给出降级提示。

长期：实现 pdf.js 自定义 `CustomLoadingTask`，通过 Tauri 命令按需读取字节范围（Range Request），避免整文件加载。这需要：

1. 后端新增 `read_pdf_range(filePath, start, end)` 命令。
2. 前端实现 `PDFDataRangeTransport` 替代 `getDocument({ data })`。

此为较大改动，建议在 P0 完成后再规划。

---

## 修复优先级总结

| 阶段 | 事项 | 预计 |
|------|------|------|
| P0 发布阻断 | D1 签名 · S1 LLM 代理 · R1 pdf.js destroy · P1 性能 · D2 多平台 | 2-3 周 |
| P1 安全收敛 | S2 词典哈希 · S3 CSP 收紧 · S4 移除 shell · S5 load/save 校验 | 3-4 天 |
| P2 健壮性 | R2 错误可见 · C1 锁 poison · C2 缓存/锁回收 · S6/S7 日志与死代码 | 2-3 天 |
| P3 工程体验 | D4 黄金路径 E2E · D5 覆盖率阈值 · D3 关于页/错误反馈 · P2 大文件流式 | 持续 |
