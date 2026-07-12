# 日志系统审计与埋点评估

> 审计时间：2026-07-12  
> 范围：前端（React/TypeScript）+ 后端（Tauri/Rust）+ 设置 UI

---

## 1. 执行摘要

当前 SpecReader AI 的日志系统处于「能跑、能查」的初级阶段：

- **结构上基本可用**：后端使用 `tauri-plugin-log`，日志写入 AppData，具备 panic 捕获和打开日志目录的能力。
- **埋点几乎为零**：没有事件埋点、没有性能指标、没有 LLM 调用监控、没有用户行为追踪。
- **前后端日志未完全打通**：前端大量错误仅输出到 `console.error`，未持久化到文件。
- **日志治理存在隐患**：切分策略为 `KeepAll`，长期运行会导致日志文件无限累积。

本报告按「现状 → 问题 → 建议」三部分展开，并给出优先级和关键代码位置。

---

## 2. 现状梳理

### 2.1 后端日志（Rust）

| 项目         | 现状                                                    |
| ------------ | ------------------------------------------------------- |
| 日志框架     | `tauri-plugin-log` + `log` crate                        |
| 初始化位置   | `src-tauri/src/lib.rs:118-146`                          |
| 日志目录     | `<AppData>/SpecReader/logs/`                            |
| 文件名       | `app.log`，单文件上限 10 MB                             |
| 切分策略     | `RotationStrategy::KeepAll`（保留所有历史文件）         |
| 日志级别     | Debug 构建：`Info`；Release 构建：`Warn`                |
| 时区         | 本地时间                                                |
| 崩溃捕获     | `src-tauri/src/main.rs:8-20` 注册 panic hook，写入日志  |
| 前端错误接收 | `src-tauri/src/lib.rs:898-901` 暴露 `log_error` command |

初始化代码：

```rust
let log_level = if cfg!(debug_assertions) {
    log::LevelFilter::Info
} else {
    log::LevelFilter::Warn
};
app.handle().plugin(
    tauri_plugin_log::Builder::default()
        .level(log_level)
        .target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::Folder {
                path: logs_dir,
                file_name: Some(LOG_FILE_NAME.to_string()),
            },
        ))
        .max_file_size(MAX_LOG_FILE_SIZE)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
        .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
        .build(),
)?;
```

### 2.2 前端日志（TypeScript/React）

| 项目     | 现状                                                           |
| -------- | -------------------------------------------------------------- |
| 日志封装 | `src/services/logs.ts` 提供 `openLogsDir()` 和 `logError()`    |
| 后端通道 | `logError()` 调用 Rust `log_error` command                     |
| 错误边界 | `src/components/ErrorBoundary.tsx` 捕获 React 未处理异常       |
| 设置入口 | `src/components/SettingsModal.tsx` 系统页提供「打开日志」按钮  |
| 其他位置 | **30 处 `console.error`，无 `console.warn`，无 `console.log`** |

`src/services/logs.ts`：

```ts
export async function logError(
  message: string,
  error?: unknown
): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error);
  try {
    await invoke("log_error", { message: `${message}: ${detail}` });
  } catch {
    console.error(message, error);
  }
}
```

### 2.3 埋点/监控现状

全仓库未找到以下内容：

- Sentry / Bugsnag / 自研错误上报
- 用户行为事件（打开 PDF、翻译、解读、暂存等）
- LLM 调用性能/成功率指标
- 应用性能指标（PDF 首屏、渲染耗时等）
- 词典下载/更新安装漏斗

目前所有日志均为**被动排障日志**，没有**产品或稳定性埋点**。

---

## 3. 问题清单

### 3.1 前端错误大量丢失（高优先级）

全仓库 30 处 `console.error`，只有 4 处调用 `logError` 持久化到文件：

```ts
// src/hooks/usePersistence.ts
logError("savePdfData failed", err);
logError("savePdfData secondary failed", err);
logError("deleteSessionOnDisk failed", err);
logError("saveSession failed", err);
```

其余前端异常（PDF 加载失败、渲染失败、设置保存失败、词典检查失败等）只会在 DevTools 中短暂出现，用户反馈问题时无法通过日志复现。

### 3.2 usePersistence.ts 双重日志（中优先级）

上述 4 处 `logError` 调用**上方都有对应的 `console.error`**，同一个错误被记录两次。例如 `src/hooks/usePersistence.ts:283-284`：

```ts
console.error("Failed to save PDF data:", err);
logError("savePdfData failed", err);
```

由于 `logError` 的 fallback 本身就会在 invoke 失败时输出 `console.error`，保留额外的 `console.error` 是冗余的。

### 3.3 ErrorBoundary 未将白屏错误落盘（高优先级）

`src/components/ErrorBoundary.tsx:26`：

```ts
componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
  console.error("Uncaught error:", error, errorInfo);
}
```

React 白屏错误仅 `console.error`，未调用 `logError` 持久化。

### 3.4 日志文件会无限增长（高优先级）

`src-tauri/src/lib.rs:7-8, 142-143`：

```rust
const MAX_LOG_FILE_SIZE: u128 = 10 * 1024 * 1024; // 10 MB
...
.max_file_size(MAX_LOG_FILE_SIZE)
.rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
```

`KeepAll` 表示每次达到 10 MB 就生成 `app.log.0`、`app.log.1`… 永远不会删除。长期运行后磁盘占用不可控。  
`AGENTS.md` 中描述为「保留最近 10 MB」，与实际实现不符。

### 3.5 没有日志级别开关（中优先级）

Release 构建固定为 `Warn`。用户遇到偶发问题时，无法临时开启 `Info/Debug` 复现问题；开发者也无法在不重新编译的情况下拿到更详细的日志。

### 3.6 没有结构化上下文（中优先级）

所有日志都是扁平字符串，例如：

```rust
log::warn!("Failed to emit open-pdf event: {}", e);
```

缺少统一字段：`timestamp`、`level`、`source`、`version`、`tab_id`、`file_hash` 等。多 Tab、多会话场景下难以关联排查。

### 3.7 关键业务路径缺少日志（中优先级）

以下动作当前基本无日志：

- PDF 打开/关闭、渲染失败、页码跳转
- 翻译/解读触发、LLM 流式中断
- 批注增删改、拖拽位置变化
- 暂存区变化、自定义解读提交
- 词典下载进度/失败/完成
- 更新检查/下载/安装

### 3.8 updater.ts 无持久化日志（高优先级）

`src/services/updater.ts:30` 只有 `console.error`：

```ts
console.error("[updater] 检查更新失败:", error);
```

更新检查/下载/安装失败是用户最常遇到的问题之一，但目前不会落盘。

### 3.9 安全/隐私审计不足（中优先级）

- PDF 路径未授权访问失败时，只在 command 返回 `Err`，没有安全审计日志。
- 注释声明「日志不包含敏感内容」，但代码中没有统一脱敏机制（路径、API Key、PDF 文本）。

### 3.10 log_error 命令能力受限（中优先级）

`src-tauri/src/lib.rs:898-901` 的自定义命令只接受字符串并固定记录为 `error` 级别：

```rust
#[tauri::command]
fn log_error(message: String) {
    log::error!("{}", message);
}
```

前端无法记录 `warn`/`info`/`debug` 级别，也无法带结构化 key-value 字段。

### 3.11 panic = "abort" 与日志刷盘风险（低优先级）

`src-tauri/Cargo.toml:47`：

```toml
panic = "abort"
```

Release 构建中 panic 后进程立即终止。虽然 panic hook 会执行 `log::error!`，但如果 logger 有内部缓冲，日志可能未刷盘就终止。需要验证 `tauri-plugin-log`（基于 fern）是否同步写入，或在 panic hook 中显式 flush。

### 3.12 dictionary.rs user-agent 版本号过时（低优先级）

`src-tauri/src/dictionary.rs:139`：

```rust
.user_agent("SpecReader/0.1.0")
```

实际版本已更新到 `0.5.5`（见 `tauri.conf.json:4` 和 `Cargo.toml:3`），但词典下载请求仍使用旧版本号。  
同时 `AGENTS.md:443-444` 仍写「前端版本：`0.1.0` / Tauri 应用版本：`0.1.0`」，与产物版本不一致。

---

## 4. 改进建议

### 4.1 P0：立即止血

#### 4.1.1 统一前端日志入口：优先使用 tauri-plugin-log 内置能力

`tauri-plugin-log` Rust 端已内置 `log` command（支持 `level` + `key_values`），项目当前自定义的 `log_error` 命令是对该能力的降级封装。建议：

1. 安装 JS SDK：
   ```bash
   npm install @tauri-apps/plugin-log
   ```
2. 用内置 API 替换 `services/logs.ts`：
   ```ts
   import { debug, info, warn, error } from "@tauri-apps/plugin-log";

   export { debug, info, warn, error };
   export { openLogsDir } from "./logs-dir"; // 如需要可单独保留
   ```
3. 将所有 `console.error` 替换为 `error()`。

如果暂时不想引入新依赖，可保留自定义 command，但应扩展为支持 level 和 key_values，而不是继续扩展 `logError`/`logWarn`/`logInfo` 这种平级封装。

#### 4.1.2 ErrorBoundary 调用 error() 并修正参数

当前 `logError(message, object)` 会把对象序列化为 `"[object Object]"`，不能直接传对象。正确做法：

```ts
componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
  error(
    `React ErrorBoundary caught error: ${error.toString()}\n` +
    `Stack: ${error.stack}\n` +
    `ComponentStack: ${errorInfo.componentStack}`
  );
}
```

若使用插件内置 `error()` 并传 `key_values`，则需确认 JS SDK 类型支持。

#### 4.1.3 修复日志无限增长

`tauri-plugin-log` 提供三种 `RotationStrategy`：

- `KeepAll`：当前使用，保留所有历史文件
- `KeepOne`：仅保留当前文件，旋转时删除旧文件
- `KeepSome(usize)`：保留 N 个最近的文件

**建议改为 `RotationStrategy::KeepSome(3)`**，保留最近 3 个 10 MB 文件，总上限约 30 MB，一行代码即可解决：

```rust
.rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
```

同步更新 `AGENTS.md` 中的描述，使其与实际策略一致。

#### 4.1.4 删除 usePersistence.ts 中的冗余 console.error

`usePersistence.ts:283/310/342/358` 的 `console.error` 应删除，仅保留 `logError`（或 `error()`），避免同一错误重复记录。

#### 4.1.5 updater.ts 错误必须落盘

`src/services/updater.ts:30` 的 `console.error` 应改为 `error()`，确保更新失败可排查。

---

### 4.2 P1：可观测性增强

#### 4.2.1 增加日志级别设置

`tauri-plugin-log` 在初始化时调用 `log::set_max_level()`，插件本身不暴露运行时修改 API。可选方案：

**方案 A（简单，推荐）**：

- 在 Settings → System 页面增加「日志级别」下拉：Error / Warn / Info / Debug
- 保存到 `settings.json`
- 启动时读取设置并传入 `Builder::level()`
- UI 提示「重启后生效」

**方案 B（进阶）**：

- 新增 Tauri command，调用 `log::set_max_level(LevelFilter::Info)` 实现热切换
- 需要验证 `tauri-plugin-log` 的 `enabled()` 方法是否会二次过滤

#### 4.2.2 增加结构化上下文

`tauri-plugin-log` 输出的是纯文本格式（带时间戳前缀），不支持原生 JSON 结构化输出。可选方案：

**方案 A（推荐，成本最低）**：
保持文本格式，但在消息中使用统一前缀约定：

```ts
error(`[tabId=${tabId} fileHash=${fileHash}] Failed to save PDF data: ${err}`);
```

排查时用 grep/awk 即可过滤。

**方案 B**：
在自定义 `log` command 中手动 `serde_json::to_string` 后写入，但输出格式会与插件其他日志不一致。

**方案 C**：
替换 `tauri-plugin-log` 为自定义 log 实现（如 fern + JSON encoder），效果最好但工作量最大。

#### 4.2.3 关键路径加 Info 日志

在以下位置增加 `info()` 调用：

- PDF 打开成功/失败：`info("pdfOpened", { fileHash, pageCount })`
- LLM 请求开始/完成/失败：`info("llmRequestStarted", { model })` / `warn("llmRequestFailed", { status, error })`
- 批注/会话保存成功/失败
- 词典下载起止
- 更新检查起止

---

### 4.3 P2：埋点与指标

#### 4.3.1 跳过独立 telemetry 层

SpecReader AI 是本地桌面应用，所有数据在本地，且目前没有远程上报通道。独立的 `telemetry.ts` 抽象价值有限——用户仍需手动打开日志目录查看，与直接看日志没有本质区别。

**建议**：直接在关键路径调用 `info()`/`warn()`/`error()` 记录事件。等后续有远程上报、数据仓库或隐私政策支持时，再引入 telemetry 抽象层。

#### 4.3.2 LLM 调用监控

`src/services/llm.ts` 的 `streamChatCompletion`（第 13-116 行）有清晰的请求入口和出口，适合加监控：

```ts
info(`llmRequestStarted: model=${config.model}`);
// ... 请求结束后 ...
warn(`llmRequestFailed: status=${status}, error=${error.message}`);
```

注意：不要记录完整 prompt 或响应原文；可记录 token 数（如响应头返回）。

---

### 4.4 P3：安全与合规

#### 4.4.1 路径访问审计

对以下事件记录 `warn` 级安全日志：

- 未授权 PDF 路径访问尝试
- 单实例接收到的打开参数
- API Key 钥匙串读取失败（不记录 key 本身）

#### 4.4.2 敏感信息脱敏

在日志发送前统一替换：

- 用户主目录路径 → `~`
- API Key → `[REDACTED]`
- 完整 PDF 文本长度超过阈值时截断

#### 4.4.3 验证 panic 日志刷盘

由于 `Cargo.toml` 设置了 `panic = "abort"`，建议在 panic hook 中显式 flush logger（如果插件 API 支持），或验证 fern 是否同步写入文件。

#### 4.4.4 修正版本号不一致

- `src-tauri/src/dictionary.rs:139` 的 `user_agent` 改为 `"SpecReader/0.5.5"`（或从构建时注入的版本号读取）
- `AGENTS.md:443-444` 的版本号更新为 `0.5.5`，与产物保持一致

---

## 5. 关键代码位置速查

| 功能                   | 文件                               | 行号                               |
| ---------------------- | ---------------------------------- | ---------------------------------- |
| 后端日志插件初始化     | `src-tauri/src/lib.rs`             | 118-146                            |
| panic 日志             | `src-tauri/src/main.rs`            | 8-20                               |
| 前端日志封装           | `src/services/logs.ts`             | 1-18                               |
| log_error command      | `src-tauri/src/lib.rs`             | 898-901                            |
| 打开日志目录 command   | `src-tauri/src/lib.rs`             | 190-198                            |
| ErrorBoundary          | `src/components/ErrorBoundary.tsx` | 15-65                              |
| 系统设置页             | `src/components/SettingsModal.tsx` | 470-570                            |
| 日志切分/大小常量      | `src-tauri/src/lib.rs`             | 7-8                                |
| 持久化逻辑（双重日志） | `src/hooks/usePersistence.ts`      | 283-284, 310-311, 342-343, 358-359 |
| LLM 调用               | `src/services/llm.ts`              | 13-116                             |
| 更新检查               | `src/services/updater.ts`          | 13-33                              |
| 词典下载 user-agent    | `src-tauri/src/dictionary.rs`      | 139                                |
| panic 构建配置         | `src-tauri/Cargo.toml`             | 47                                 |
| AGENTS.md 版本号       | `AGENTS.md`                        | 443-444                            |

---

## 6. 下一步行动建议

建议分阶段实施：

1. **第一阶段（本周）**：
   - 引入 `@tauri-apps/plugin-log` 或扩展自定义 command 支持 level/key_values
   - 统一前端 `console.error` → `error()`
   - ErrorBoundary 错误落盘
   - 删除 `usePersistence.ts` 冗余 `console.error`
   - `updater.ts` 错误落盘
   - 日志切分改为 `KeepSome(3)`

2. **第二阶段（下周）**：
   - 增加日志级别设置项（保存到 settings.json，重启生效）
   - 关键路径加 `info()` 日志
   - 增加统一前缀约定实现轻量结构化

3. **第三阶段（后续）**：
   - LLM 调用监控（耗时、失败率）
   - 安全审计日志（未授权访问、单实例参数）
   - 验证 panic 日志刷盘
   - 修正 `dictionary.rs` 和 `AGENTS.md` 版本号

如果需要，可基于此文档直接产出具体 PR 级改动计划。
