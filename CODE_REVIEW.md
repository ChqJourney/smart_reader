# SpecReader AI — 代码审查报告

> 审查对象：`pdf-standard-agent`（Tauri 2.0 + React 18 + TypeScript + Rust）
> 审查范围：架构 / 逻辑 / 功能 / 冗余 / 安全
> 审查日期：2026-07-09
> 结论：整体工程素质良好（结构清晰、测试意识强、Tauri 命令做了纯函数解耦），但存在一个 **Critical 级持久化缺陷** 和若干架构/冗余问题，建议优先修复。

---

## 一、总体评价

| 维度           | 评分     | 说明                                                                           |
| -------------- | -------- | ------------------------------------------------------------------------------ |
| 架构           | ⭐⭐⭐⭐ | Tauri 命令与纯逻辑解耦、service 层职责清晰、防抖持久化思路正确                 |
| 逻辑正确性     | ⭐⭐     | 存在序列化大小写错配导致的持久化失效（致命）及多处冗余写                       |
| 功能完整性     | ⭐⭐⭐⭐ | 打开/渲染/选区/翻译/解读/暂存/多 Tab 闭环完整                                  |
| 冗余与可维护性 | ⭐⭐⭐   | 有死代码、双写、God Component；可进一步拆分                                    |
| 测试           | ⭐⭐⭐⭐ | 单测/E2E/Rust 单测齐全，但**缺少跨进程序列化往返测试（正是缺陷被掩盖的原因）** |

---

## 二、🔴 Critical：Rust 序列化大小写错配，持久化在读写双向失效

### 现象

`src-tauri/src/lib.rs` 中所有结构体均使用 Rust 原生 snake_case 字段，且**没有** `#[serde(rename_all = "camelCase")]`：

```rust
struct Annotation {
    id: String,
    #[serde(rename = "type")]
    annotation_type: String,
    ...
    #[serde(default)]
    created_at: u64,
    session_id: Option<String>,
    stash_id: Option<String>,
    interpreted_group_size: Option<u32>,
    interpreted_index: Option<u32>,
    is_streaming: bool,
}
struct PdfAnnotationsFile { annotations: Vec<Annotation>, session_ids: Vec<String> }
```

而前端 `src/services/annotations.ts` 等全部使用 camelCase：
`createdAt / sessionId / stashId / interpretedGroupSize / interpretedIndex / isStreaming / sessionIds`。

### 为什么是致命的

Tauri v2 的命令返回/参数序列化为标准 JSON（字段名即声明名），**不会自动做 camelCase 转换**（需显式 `rename_all`，官方文档与社区均如此要求）。因此：

1. **保存方向**：前端 `save_pdf_data` 传入 `{ annotations:[{sessionId, ...}], sessionIds:[...] }`，但 Rust 结构体只认 `session_id` / `session_ids`，未知字段被忽略 → `session_ids` 永远存空，`Annotation.session_id` 等全部丢失。
2. **加载方向**：`load_pdf_data` 返回 `session_ids` / `session_id` / `created_at` / `interpreted_group_size`，前端 `data.sessionIds`、`annotation.sessionId`、`annotation.interpretedGroupSize` 均为 `undefined`。
3. **连锁后果**：
   - `App.tsx` 加载时 `const sessionIds = data.sessionIds || []` 恒为空 → **会话（解读记录）重启后永远不会恢复**。
   - `annotations` 过滤条件 `a.interpretedGroupSize !== undefined` 在重载后恒为 `false` → **“已解读暂存”标记重载后全部消失**。
   - 解读标记无法与右侧会话联动（缺 `sessionId`），删除时也无法清理对应会话引用。

> 该 bug 在当前 E2E / 单测中未被发现，因为测试都在**单次会话内**验证，从不重启应用后检查磁盘往返；且 Rust 测试直接构造结构体而非走 `invoke` 序列化，绕过了问题。

### 修复（建议）

为所有跨端结构体统一加 `rename_all = "camelCase"`，并保留已有的 `rename = "type"`：

```rust
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Annotation {
    id: String,
    #[serde(rename = "type")]
    annotation_type: String,
    // ...其余字段自动映射为 camelCase
}
// AnnotationPosition / StashSource / InterpretationMessage /
// InterpretationSession / PdfAnnotationsFile 同样加 #[serde(rename_all = "camelCase")]
```

**验证方式**：在 `App.tsx` 临时 `console.log(await loadPdfData(path))`，确认返回对象的键是 `sessionIds/sessionId/...` 而非 snake_case 即可证实修复有效。建议补一条前端单测，断言 `invoke("load_pdf_data")` 的 mock 返回 camelCase 键能正确落到 `PdfData`。

---

## 三、🟠 架构问题

### 3.1 App.tsx 是 God Component（~790 行）

状态编排、Tab 管理、遗留数据迁移、防抖持久化、面板 resize 全部堆在一个组件里。建议拆分自定义 Hook：

- `useTabs()`：Tab 增删/切换/关闭后的激活态。
- `usePersistence()`：把“按文件加载 annotations/sessions”和“防抖保存”封装进去。
- `useRightPanelLayout()`：面板宽度/可见性持久化与 resize 逻辑。

### 3.2 持久化存在“双写 + 竞态”

- 自动路径：`App.tsx` 第 201–218 行 `useEffect`（依赖 `annotations/sessions/activeTab`）统一防抖写 `save_pdf_data`。
- 手动路径：`handleCustomInterpret`（第 442–458 行）与 `handleSelectionAction`（第 488–497 行）又**各自手动** `loadPdfData` + `savePdfData` 写入 `sessionIds`，且多文件时遍历所有 PDF。

两路并发写同一 JSON 文件，后写覆盖先写，且都重新读盘再写盘，存在 clobber 风险；同时 `handleCustomInterpret` 既手动 `saveSession` 又触发防抖再写，造成重复写盘。

**建议**：以自动防抖 effect 为唯一写入入口；多文件会话的 `sessionIds` 联动改为在 effect 内根据 `sessions` 中每条 session 的 `sources` 推导出“每个 PDF 应包含的 sessionId 集合”一次写回，删除手动写盘代码。

### 3.3 两套并行的流式实现

- **解读（explain / 自定义）**：走 `AiChatPanel` 的 `sessions` 流式消费（`streamChatCompletion` + `streamingIdsRef`）。
- **翻译（translate）**：走 `TranslatePopup` 自己的 `useEffect` 内联流式。

两者重复了“构造 messages（含 system prompt）+ 解析 SSE + 防抖更新”逻辑，system prompt 也是两处硬编码字符串。建议抽出一个 `useStreaming(config, messages, onChunk)` Hook 或 `runStream` 工具函数，统一流式消费；`TranslatePopup` 改为消费同一个机制。

---

## 四、🟠 逻辑 / Bug（非序列化类）

### 4.1 `read_pdf_bytes` 返回 `Vec<u8>` 被序列化为 JSON 数字数组

`lib.rs` 第 38 行返回 `Vec<u8>`，前端 `PdfViewer.tsx` 第 583 行 `const bytes: number[] = await invoke(...)`。Tauri 会把 `Vec<u8>` 作为**逐字节的数字数组** JSON 传输，对大 PDF 会产生 4~5 倍内存与解析开销，且 `new Uint8Array(bytes)` 再拷贝一次。

**建议**：使用 `tauri::ipc::Response::new(bytes)`（或 `tauri::ipc::Response::binary`）返回原始二进制，前端直接拿到 `ArrayBuffer` / `Uint8Array`，避免中间数字数组。

### 4.2 流式缺少 AbortController

`AiChatPanel` 与 `TranslatePopup` 的 `for await` 流在组件卸载/会话被删除后不会被取消。删除一个正在解读的会话时，流仍会继续 `onSessionUpdate`，只是更新落到已不存在于 state 的会话上（被 `handleSessionUpdate` 的 map 静默丢弃），属于资源泄漏 + 无效写入。**建议**：用 `AbortController` 在 cleanup 中 `abort()` 并让 `streamChatCompletion` 支持 `signal`。

### 4.3 `TranslatePopup` 捕获配置时机过旧

第 25 行 `const configRef = useRef(loadLlmConfig())` 只在挂载时读一次配置。若用户在设置里改了 API Key/Base URL，已打开的翻译浮层仍用旧配置，直到重新打开。轻微，但建议改为订阅配置变化或直接从 `localStorage` 实时读取。

### 4.4 关闭 Tab 未清理其 stashes / annotations

`handleCloseTab` 仅操作 `tabs` 与 `activeTabId`。被关 Tab 的 `stashes`（全局 state）和 `annotations` 仍驻留内存，直到下次切换时由新 Tab 的 `loadPdfData` 覆盖。当前因 `activeTabStashes` 按 `tabId` 过滤不会误显，但属于隐性泄漏，建议在关闭 Tab 时一并清理。

### 4.5 多文件会话删除单条标注时，未从“其它源 PDF”的 annotations 中移除该标注

`handleAnnotationDelete`（第 542–553 行）对会话涉及的每个 PDF 只 `filter` 了 `sessionIds`，未从 `data.annotations` 中删除该 annotation 本身。对“多 PDF 来源 + 已持久化”的场景，那条标注会残留在其它 PDF 的磁盘 annotations 中，直到该 PDF 被再次激活并由防抖 effect 用内存 state 覆盖。建议删除时同步从各源 PDF 的 `annotations` 中剔除。

---

## 五、🟡 冗余与可维护性

| 位置                                                                | 问题                                                                                    | 建议                                    |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------- |
| `src/services/stash.ts:39` `clearStashes`                           | 仅被测试引用，生产代码从未调用（App 用内联 `filter`）                                   | 删除或改用之                            |
| `src/services/sessions.ts:94` `saveSessionsToLegacyStorage`         | 仅被测试引用；遗留迁移只读取不写入，属纯死代码                                          | 删除函数及其测试引用                    |
| `AiChatPanel.tsx` 第 53–57 行 与 64–69 行                           | 两个 `useEffect` 都监听 `expandedSessionId`，第一个只 set `expandedId` 被第二个完全覆盖 | 删除第一个，合并逻辑                    |
| `handleCustomInterpret` / `handleSelectionAction`                   | “保存会话 + 写回各 PDF 的 sessionIds” 样板重复                                          | 抽 `persistSessionAndLinkPdfs(session)` |
| `PdfViewer.tsx` `computeContinuousScrollTop` 与 `goToPage` 内联回退 | 滚动定位逻辑分散在两处                                                                  | 统一走 `computeContinuousScrollTop`     |
| `PdfPage` 内 `lineThreshold` 常量 (4/8) 多次硬编码                  | 魔法数字                                                                                | 提取为命名常量                          |

---

## 六、🟡 安全与健壮性

1. **`tauri.conf.json` `security.csp: null`**：完全关闭 CSP。作为本地应用可接受，但若后续引入远程内容或第三方脚本，建议至少对 `asset:` / `http(s):` 设最小 CSP。
2. **API Key 存于 `localStorage`**：webview 内任何代码均可读取。本地单机应用风险低，但可改用系统钥匙串（`tauri-plugin-keyring` 或 Rust 侧 `keyring`）提升安全性。
3. **`read_pdf_bytes` / `open_path` 无路径校验**：均依赖前端 dialog 传入。本地工具风险有限，但建议对 `read_pdf_bytes` 的路径做基本白名单/越权检查，避免被任意路径读取利用。
4. **`streamChatCompletion`**：未校验 `data.choices` 存在性（部分厂商返回 `usage`-only chunk 时 `choices` 为 `undefined`，当前 `?.` 已兜底，OK）；建议补充对 `data.error` 结构体（OpenAI 错误体）的显式捕获。

---

## 七、功能建议（非缺陷）

- **翻译失败无重试**：`TranslatePopup` 显示错误但无“重试”按钮，需关闭重建。
- **“已解读暂存”与“解读会话”的可达性**：目前通过蓝色标记点击 → 右侧定位，路径合理；建议增加全局搜索/目录（已在 roadmap）。
- **选区坐标基准**：`handleSelection` 的 `pdfX/pdfY` 使用 `e.clientX - rect.left`，依赖当前 scale；persist 用 scale=1 原始坐标 — 当前渲染 `position.x * scale` 一致，逻辑自洽，无问题。
- **多语言/术语表**：已规划，建议复用 `buildSelectionPrompt` 的术语保留策略。

---

## 八、修复优先级清单

| 优先级 | 项                                                           | 文件                                        |
| ------ | ------------------------------------------------------------ | ------------------------------------------- |
| P0     | 结构体加 `#[serde(rename_all = "camelCase")]`（修复持久化）  | `src-tauri/src/lib.rs`                      |
| P1     | 统一持久化写入为单一防抖入口，移除手动双写                   | `src/App.tsx`                               |
| P1     | `read_pdf_bytes` 改用 `Response::new(bytes)` 原始二进制      | `src-tauri/src/lib.rs`                      |
| P2     | 流式加 `AbortController` 可取消                              | `llm.ts` / `AiChatPanel` / `TranslatePopup` |
| P2     | 抽取 `useStreaming` 统一翻译/解读流式逻辑                    | 新 Hook                                     |
| P2     | 拆分 `App.tsx`（useTabs/usePersistence/useRightPanelLayout） | `src/App.tsx`                               |
| P3     | 删除死代码 `clearStashes` / `saveSessionsToLegacyStorage`    | `stash.ts` / `sessions.ts`                  |
| P3     | 关闭 Tab 时清理其 stashes/annotations                        | `src/App.tsx`                               |
| P3     | CSP / Keyring 安全加固                                       | `tauri.conf.json` / Rust                    |
| P3     | 补充“序列化往返”单测，防止 P0 类问题回归                     | `services/*.test.ts`                        |

---

## 九、一句话总结

代码结构、测试意识、PDF 渲染与交互细节都做得相当专业；但 **Rust 端缺 `rename_all` 导致 camelCase 字段（sessionId/interpretedGroupSize/…）在磁盘往返中全部丢失** 是当前最该立刻修的硬伤，且因其被“单会话测试”掩盖而长期存在。修好它，并合并重复的持久化写入路径，项目就达到了可放心交付的质量水位。
