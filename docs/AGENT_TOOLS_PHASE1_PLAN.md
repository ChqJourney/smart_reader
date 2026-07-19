# Agent Tools 第一期实施计划：解读时查阅 PDF 内容

> 状态：**已完成（v4，实现与单测已通过回归验证）**（2026-07-19）
> 分支：`feature/agent-tools`；当前已合并至工作目录。
> 验证结果：`npm run test` 407 绿 / `type-check` 通过 / `lint` 通过（4 个既有 warning）/ `cargo test` 59 绿。
> 目标架构见 `docs/AGENT_TOOLS_DESIGN.md`，本文只覆盖第一期：让 LLM 在解读 / 自定义解读 / 追问时，能通过 Function Calling 工具查阅已打开的 PDF 内容（典型场景：片段引用了另一个条款号，模型主动去查原文）。
> 不含：Clause 索引、术语表、表格多模态。
> v2 变更（审核意见）：工具中间消息改为**持久化到会话**并随追问回放；新增 §4.8 平台兼容性调查。
> v3 变更：回填 §4.8 调查结果（6 平台官方文档核实），据此修正 wire 细节——tool 消息不带 `name`、assistant(tool_calls) 消息 `content` 统一空串、`reasoning_content` 全平台「有就回传」、累积器改宽容模式、flush 不依赖 `finish_reason` 取值。
> v4 变更（审核确认）：工具侧 PDF 文档实例由「常驻」改为**瞬态**——随 agent loop 创建、loop 结束即销毁，常驻内存近零；注册表只保留轻量元数据。

---

## 1. 需求决策（两轮确认 + 审核意见）

| 决策点                    | 结论                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Agent loop 与工具执行位置 | **前端 TS**（复用 pdfjs，无新 Rust PDF 解析依赖）                                                                          |
| 本期工具集                | **3 个**：`list_open_pdfs`、`read_pdf_page`、`search_in_pdf`（schema 已在后端定义）                                        |
| 启用场景                  | **解读类三种**：选中解读、自定义解读、会话追问；**翻译不启用**                                                             |
| 工具可读范围              | **所有打开的 Tab**（按 fileHash 授权，支持分屏对照跨文档查阅）                                                             |
| PDF 文档实例              | **瞬态自建实例**（审核确认）：随 agent loop 创建、loop 结束即销毁；不与 viewer 共享（避免生命周期耦合），也不常驻          |
| 工具调用过程展示          | **实时状态提示**：流式区域显示「正在搜索…/正在读取第 N 页」，完成后可折叠查看调用记录                                      |
| 最大工具轮次              | **设置中可配**——`maxToolRounds` 设置与 UI 已存在（SettingsModal 模型设置 tab，0=默认 5），本期让它真正生效                 |
| 功能总开关                | **默认开启可关**：功能设置新增「智能查阅文档」开关                                                                         |
| 平台不支持 tools 时       | **静默降级**：按 `platformPresets.supportsTools` 判断，不支持则不带 tools 字段，行为同现状                                 |
| 达轮次上限                | **不报错**：强制一轮无 tools 的「用已有信息作答」收尾（审核确认）                                                          |
| 工具中间消息              | **持久化到会话**（审核确认，推翻 v1 的「不持久化」）：assistant(toolCalls) 与 tool 结果消息随 session 保存，追问时原样回放 |
| 工具执行错误              | **不中断流程**：错误文本作为 tool result 回给模型自行恢复（审核确认）                                                      |

---

## 2. 现状盘点

### 2.1 已就绪（不动或仅小改）

- 后端 `llm_proxy.rs`：`StreamParams.enable_tools` / `authorized_file_hashes` 参数（:101-113）；`builtin_tools()` 三个工具 schema（:164-209）；`enable_tools` 时注入请求体（:155-157）；`StreamEvent::ToolCall / ToolResult`、`LlmError::ToolError` 类型（:78-98）。
- 后端 `ChatMessage` 已有 `tool_call_id` / `tool_calls` / `reasoning_content` 可选字段（`llm_proxy.rs:32-44`）。
- 前端 `streamChatCompletion` 已接受 `enableTools` / `authorizedFileHashes` 并透传（`services/llm.ts:121-130`）。
- `AppSettings.maxToolRounds` 全链路已存在（TS `settings.ts`、Rust `lib.rs:524`、SettingsModal 数字输入 :680-706），只是没有消费方。
- `platformPresets.supportsTools` 字段已存在（8 个预设当前均为 true）。
- `types/llm.ts` 有完整的 `ChatMessage`（含 `tool` role）/ `ToolCall` / 含 tool 事件的 `StreamEvent` 类型定义。

### 2.2 缺口（本期要做）

1. **后端 SSE tool_calls 是逐 delta 转发的**：`parse_sse_line`（llm_proxy.rs:372-404）每个分片发一次 `ToolCall` 事件，arguments 被切碎、无名分片被丢弃——必须改为**按 index 累积，流结束时发完整 ToolCall**。
2. **后端消息回放的 wire 格式错误**：`ChatMessage` 是 `rename_all = "camelCase"`（给前端传参用），序列化进请求体时 `tool_call_id` 会变成 `toolCallId`，OpenAI 兼容 API 要求 snake_case——回放 tool 消息前必须修正序列化。
3. **前端通道不认识 tool 事件**：`services/llm.ts` 的 `StreamEvent`（:19-24）和 `channel.onmessage`（:78-109）没有 toolCall/toolResult 分支，事件会被静默丢弃。
4. **没有工具执行层**：三个工具只有 schema，无任何实现。
5. **没有 agent loop**：`runSessionStream`（usePersistence.ts:412-537）单次流式即结束。
6. **没有授权数据源**：工具需要「当前打开的 PDF 列表（fileHash/fileName/filePath/numPages）」，tabs 只存在于 App 组件内。
7. **UI 无工具状态展示**；**设置无总开关**；**prompt 无工具使用引导**。
8. ~~各平台工具调用的多轮对话格式差异未核对~~ **已调查**（2026-07-18，6 平台官方文档），结论见 §4.8。

---

## 3. 总体架构

```
用户发起 解读 / 自定义解读 / 追问
    │
    ▼
runSessionStream（usePersistence.ts，改造为 agent loop）
    │  计算 toolsEnabled = settings.agentToolsEnabled
    │                      && preset.supportsTools
    │                      && action ∈ {explain, custom}（含追问所在会话）
    │  authorizedFileHashes = pdfToolsRegistry 中所有打开 tab 的 hash
    │  toolsEnabled 时 beginToolSession()（瞬态，finally 中 dispose）
    ▼
streamChatCompletion(messages, { enableTools, authorizedFileHashes, thinking, signal })
    │  （第 N 轮，每轮都带 tools——百炼/OpenRouter 的硬性要求）
    ▼
后端 llm_proxy.rs ── OpenAI 兼容 SSE ──► LLM
    │
    ▼ 前端收到事件
   ┌─────────────────────────────────────────────┐
   │ chunk/reasoningChunk → 照常流式上屏          │
   │ toolCall（完整、累积后）→ 记录到 message.toolEvents │
   │   状态行：「正在搜索 "6.2.1"…」               │
   │ done 且本轮有 toolCalls 且轮次 < maxRounds:   │
   │   执行工具（toolSession.executeToolCall）      │
   │   → 追加 assistant(toolCalls+reasoningContent)│
   │   + tool 结果消息（同时落盘到 session）→ 第 N+1 轮│
   │ done 且无 toolCalls → 结束，onDone            │
   │ 轮次达上限仍有 toolCalls → 最后一轮强制       │
   │   enableTools=false，要求模型用已有信息作答    │
   │ finally: toolSession.dispose()（销毁文档实例） │
   └─────────────────────────────────────────────┘
    │
    ▼
pdfTools 执行器（新模块 src/services/pdfTools.ts）
    ├── list_open_pdfs     → 读 registry 元数据（内存，无需 pdfjs）
    ├── read_pdf_page      → 本 loop 内懒建 PDFDocumentProxy → getTextContent → 文本（截断）
    └── search_in_pdf      → 逐页文本（本 loop 内缓存）子串匹配 → [{page, snippet}]
```

关键架构决定：

- **文档实例瞬态自建，不与 viewer 共享**：`usePdfDocument.ts:42-44` 明确注释 pdf.js transport 不能跨实例共享（复用已 destroy 的 proxy 会渲染空白）——共享 viewer 实例会让工具调用在「切 tab → viewer 卸载」时半路失败。因此工具侧在每个 agent loop 内按需懒建自己的 `PDFDocumentProxy`（**只提取文本，不渲染**，比 viewer 实例轻得多），**loop 结束即 destroy**。常驻内存近零；连续两次解读间重新解析一次文档（典型标准 PDF 亚秒级，可接受，优化空间见 §9）。
- **授权即 registry**：注册表常驻的只有轻量元数据（fileHash/fileName/filePath/numPages），工具只服务登记在册（=当前打开）的 fileHash，天然最小权限；后端 `authorized_file_hashes` 白名单校验仍留作 Phase 6（维持 dead_code 注释）。tab 在 loop 中途被关闭时，后续对该 hash 的工具调用返回错误文本，已在执行的调用不受影响（实例随 loop 存活）。

---

## 4. 详细设计

### 4.1 后端改动（`src-tauri/src/llm_proxy.rs`）

**(a) tool_calls 累积（宽容模式）**——重写 `parse_sse_line` 的 tool_calls 处理：

- 函数签名改为接收一个可变的累积器 `&mut Vec<ToolCallAcc>`，按 `index` 归并分片。
- **宽容规则**（§4.8 调查结论：官方均未承诺「id/name 仅在首分片」）：任何分片出现 `id` / `type` / `function.name` 就更新对应字段，`function.arguments` 一律按 index 追加拼接。此写法同时兼容官方 API 与各种上游归一化差异。
- **flush 时机**：收到非空 `finish_reason` 或 `[DONE]` 时，把累积器中所有完整调用逐个发 `StreamEvent::ToolCall { name, args, call_id }`（args 为完整 JSON 字符串）。**不以 `finish_reason == "tool_calls"` 作为判据**（Kimi 官方建议看 `delta.tool_calls` 是否存在；百炼兼容模式未文档化该取值）——累积器非空即 flush。
- 非 `data:` 行（如 OpenRouter 心跳注释 `: OPENROUTER PROCESSING`）与流中顶层 `error` 事件（OpenRouter 中途错误）：现有解析已正确处理，不动。
- `reasoning_content` 的累积保持现状（逐 delta 转发 ReasoningChunk，前端自行拼接）。

**(b) 请求体消息 wire 序列化修正（WireMessage 定型）**：

- 新增 `WireMessage`（serde `rename_all = "snake_case"`），`build_request_body` 把 `ChatMessage` 转成 `WireMessage` 再放进 `messages`。
- **assistant(tool_calls) 消息**：`content` 统一发空字符串 `""`（调查结论：Ark 官方最安全、百炼官方 None→"" 归一、DeepSeek/Kimi/GLM 样例兼容、OpenAI 接受空串）；`tool_calls` 元素带全 `id` / `type:"function"` / `function.name` / `function.arguments`（全平台必填交集）。
- **tool 消息**：只发 `role` / `tool_call_id` / `content`（字符串），**不带 `name`**（GLM/DeepSeek/OpenAI 新 schema 无此字段；Kimi/Ark 容忍但非必需——取最小交集。持久化层保留 name 供 UI/审计，wire 上剔除）。
- **reasoning_content 一律随 assistant 消息回放**（有就回传）：DeepSeek/Kimi 硬性要求，GLM/方舟/Qwen/OpenAI 忽略不报错——全平台唯一安全策略，见 §4.8.1。
- 不发送 `tool_choice` / `parallel_tool_calls` / `tool_stream` 等任何平台特定参数（GLM 仅支持 auto；parallel 开关各家默认值不一——接受平台默认，loop 对串行/并行都兼容）。
- role/content 现有纯文本流程行为不变。

**(c) `AppSettings` 新增 `agent_tools_enabled: bool`**（lib.rs:516-537）：

- `#[serde(default = "default_agent_tools_enabled")]`，`fn default_agent_tools_enabled() -> bool { true }`（旧 settings.json 缺字段时默认开）。
- `AppSettings::default()` impl 同步加 `agent_tools_enabled: true`。

**(d) 测试**：tool_calls 跨分片累积（arguments 切碎、id/name 出现在非首分片、多个并行调用按 index 归并、finish_reason 与 [DONE] 两种 flush 路径）；wire 序列化（snake_case、tool 消息无 name、assistant content=""）；`agent_tools_enabled` 缺字段反序列化为 true。

### 4.2 前端 LLM 通道层

**`src/services/llm.ts`**：

- `StreamEvent` 增加 `{ type: "toolCall"; name: string; args: string; callId: string }` 分支；`channel.onmessage` 增加 `"toolCall"` case 入队。（`toolResult` 事件后端不会发——工具在前端执行，结果不走后端通道——前端类型可不接。）
- `ChatMessage` 改用/对齐 `types/llm.ts` 的完整定义（`role` 含 `"tool"`，可选 `toolCallId` / `toolCalls` / `reasoningContent`），消除两处重复类型；保持 `services/llm.ts` 现有 re-export 兼容现有 import。

**`src/hooks/useStreaming.ts`**：`StreamingHandlers` 增加可选回调 `onToolCall?: (name: string, args: string, callId: string) => void`，在事件 switch 中分发。纯增量，TranslatePopup 现有调用不受影响。

### 4.3 PDF 工具执行层（新文件）

**`src/services/pdfToolsRegistry.ts`**（打开 PDF 的唯一事实源 + 授权白名单；**常驻的只有轻量元数据，不持有 pdfjs 实例**）：

```ts
interface OpenPdfMeta {
  fileHash: string;
  fileName: string;
  filePath: string;
  numPages?: number; // 某次工具会话加载后回填并长期保留（纯数字，无内存负担）
}

// App.tsx 一个 effect 把 tabs 同步进来；可同时传一个 getCachedBytes(filePath)
// 复用 App 的 bytes 缓存（App.tsx:50），取不到时工具回退 invoke("read_pdf_bytes")
export function syncOpenPdfs(
  tabs: { fileHash; fileName; filePath }[],
  getCachedBytes?: (filePath: string) => Uint8Array | undefined
): void;
export function getOpenFileHashes(): string[];
export function isAuthorized(fileHash: string): boolean;
```

**`src/services/pdfTools.ts`**（瞬态工具会话，纯逻辑、可单测）：

```ts
export interface ToolSession {
  executeToolCall(
    name: string,
    argsJson: string
  ): Promise<{ summary: string; result: string }>;
  dispose(): Promise<void>; // destroy 本 session 创建的所有 PDFDocumentProxy
}
export function beginToolSession(): ToolSession;
```

- 每个 agent loop 开始（toolsEnabled 时）创建一个 ToolSession，**`finally` 中 dispose**；session 内部持有 `docs: Map<fileHash, Promise<PDFDocumentProxy>>` 与 `pageTextCache: Map<fileHash, Map<page, string>>`，随 dispose 一并销毁/清空。
- `executeToolCall`：
  - `summary`：给 UI 状态行/调用记录用的简短描述（如 `搜索 "6.2.1"`、`读取第 23 页`）。
  - `result`：写回 tool 消息 content 的完整文本。
  - **任何错误都捕获并转为 result 文本**（如 `Error: PDF not open: <hash>`、`Error: invalid arguments`），让模型自行恢复，绝不向 loop 抛异常；未知工具名同样返回错误文本。
  - `argsJson` 的 `JSON.parse` 失败也走错误文本路径（官方一致警告：模型可能输出非法 JSON / 幻觉参数）。
- `list_open_pdfs`：返回 JSON 数组 `[{fileHash, fileName, numPages}]`（读 registry 元数据，不触发文档加载；numPages 未知时省略）。
- `read_pdf_page({file_hash, page_number})`：
  - 校验白名单 → 本 session 内懒加载文档（优先 registry 的 getCachedBytes，否则 `invoke("read_pdf_bytes")`；bytes `.slice()` 副本后 `getDocument`，同 usePdfDocument 做法）→ 回填 registry 的 numPages。
  - 页码越界返回错误文本（附 numPages）。
  - 页文本 = `getTextContent()` items 的 `str` 拼接（保留 `hasEOL` 换行），单页上限 **8000 字符**，超出截断并注明 `... [truncated, page has N chars total]`。
- `search_in_pdf({file_hash, query, max_results = 5})`：
  - 逐页取文本（走本 session 的 pageTextCache）→ 大小写不敏感子串匹配 → 每页取首个命中，snippet 为命中处前后各约 100 字符。
  - 返回 `[{page, snippet}]`；无命中返回空数组文本说明；`max_results` clamp 1..10。
- 页文本提取是 Promise 缓存（并发去重），避免同一轮里 search+read 重复提取。

### 4.4 Agent loop（改造 `runSessionStream`，usePersistence.ts:412-537）

保持现有三流程（选中解读 / 自定义解读 / 追问）入口不变，只把「单次 streaming.run」换成「最多 N+1 轮的循环」：

```ts
const toolsEnabled =
  currentSettings.agentToolsEnabled &&
  (findPreset(currentSettings.platformId)?.supportsTools ?? false);
const maxRounds = currentSettings.maxToolRounds > 0 ? currentSettings.maxToolRounds : 5;
const toolSession = toolsEnabled ? beginToolSession() : null;

try {
  // 现有构建逻辑改为「原样回放」：session.messages 里的
  // toolCalls / toolCallId / reasoningContent 全部带上，
  // 不再只 map { role, content }
  let messages = messagesForApi;
  let seenCalls = new Map<string, string>();          // `${name}:${args}` → 缓存结果（本次响应内）
  for (let round = 0; ; round++) {
    const isLastChance = round >= maxRounds;          // 达上限：强制无 tools 最终轮
    const { toolCalls, content, reasoning, usage, error } =
      await runOneRound(messages, {
        enableTools: toolsEnabled && !isLastChance,   // 每个工具轮都带 tools（百炼/OpenRouter 要求）
        authorizedFileHashes: getOpenFileHashes(),
        thinking, signal,
        onToolCall: (name, args, callId) => /* 更新 message.toolEvents（in-progress） */,
        /* onChunk/onReasoning/onUsage 照旧透传 */
      });
    if (error || aborted) return;                     // 现有错误/中止路径不变
    if (toolCalls.length === 0) break;                // 正常结束
    // 追加 assistant 轮消息（含 toolCalls + reasoningContent 回放——DeepSeek/Kimi 硬约束），
    // 并落盘到 session.messages（插在最终 assistant 占位消息之前）
    messages = [...messages, { role: "assistant", content, toolCalls, reasoningContent: reasoning }];
    for (const call of toolCalls) {
      const cached = seenCalls.get(key(call));        // 同参重复调用：直接返回缓存结果（必需，见下）
      const { summary, result } = cached !== undefined
        ? { summary: summaryOf(call), result: cached }
        : await toolSession.executeToolCall(call.name, call.arguments);
      /* 更新 message.toolEvents 为 done + summary */
      messages.push({ role: "tool", toolCallId: call.id, content: result });
      // tool 消息同样落盘
    }
  }
} finally {
  await toolSession?.dispose();   // 销毁本 loop 创建的所有文档实例
}
```

规则与边界：

- **enableTools 只对解读类会话开启**：`session.action ∈ {explain, custom}`（追问沿用所在会话的 action）；翻译调用点（TranslatePopup）完全不动。
- **工具消息持久化**（审核确认）：中间的 assistant(toolCalls) 消息与 tool 结果消息随 `session.messages` 保存，追问时**原样回放**（含 `toolCalls` / `toolCallId` / `reasoningContent`），模型可复用已查到的条款内容，避免重复查阅。代价：session JSON 变大、回放增加 token——本期不做截断，超出上下文走现有 `contextLengthExceeded` + frozen 会话路径（见 §8 风险表）。
- **reasoningContent 必须随 assistant(toolCalls) 消息一起持久化**：DeepSeek 思考模式/Kimi thinking 在后续请求中缺它会直接 400（§4.8.1），不是可选项。
- **同参去重是必需而非优化**：百炼服务端对同名同参连续重复调用直接 400；Kimi 官方亦建议客户端去重。去重命中时仍追加 tool 消息（用缓存结果），保证消息序列完整。
- **usage 跨轮累加**后写入 `message.usage` / `session.lastPromptTokens`（ContextWidget 继续准确）。
- **取消**：现有 abort 机制不变；轮次间检查 `signal.aborted`；`finally` 保证中止/报错路径同样 dispose。
- **token 膨胀保护**：工具结果文本本身已有截断（4.3），不再额外限制轮次内消息总长；超上下文由后端 `contextLengthExceeded` 错误路径兜底（已有）。

**`InterpretationMessage` 扩展**（TS `services/sessions.ts:9-20` + Rust `lib.rs:450-490` 镜像）：

```ts
interface InterpretationMessage {
  // ...现有字段（含 reasoningContent?）
  role: "user" | "assistant" | "tool"; // 增加 "tool"
  toolCallId?: string; // role=tool 时
  name?: string; // role=tool 时的工具名（仅持久化展示用，wire 上剔除）
  toolCalls?: ToolCall[]; // role=assistant 发起工具调用时
  toolEvents?: { name: string; summary: string; status: "running" | "done" }[]; // UI 用，最终 assistant 消息上
}
```

Rust 侧：所有新增字段 `#[serde(default, skip_serializing_if = "Option::is_none")]`，与现有可选字段同风格；`role` 本来就是 String，无需改。

**持久化消息与 UI 的关系**：tool role 消息不渲染为气泡；UI 仍由最终 assistant 消息上的 `toolEvents` 摘要驱动（ToolCallsIndicator）。回放数据（完整 tool 消息）与展示数据（toolEvents 摘要）分离，互不影响。

### 4.5 设置与降级

- **总开关**：`AppSettings.agentToolsEnabled: boolean`（TS 默认 true，`normalizeSettings` 归一）。SettingsModal「功能设置」tab 加开关行（参照 hoverTranslate 现有开关样式），i18n key：`settings.agentTools` / `settings.agentToolsHint`（zh-CN / en 两份）。
- **轮次**：`maxToolRounds` 已有 UI，本期接上消费方（4.4）；不改 UI。
- **降级**：`supportsTools === false` 或总开关关闭 → `enableTools=false`，不显示任何提示，行为与现状一致。（8 个预设当前均 true，custom 平台亦 true。）

### 4.6 UI 状态展示

- 新组件 `src/components/ToolCallsIndicator.tsx`（参照 `ThinkingIndicator` 的样式与折叠交互）：
  - 流式中：逐条显示 `🔄 正在{summary}…`（running）→ 完成后变 `✓ {summary}`。
  - 全部完成且正文开始输出后：折叠为一行「查阅了 N 处文档内容」，点击展开明细。
- 插入点：`AiChatPanel.tsx` 消息气泡 `.ai-chat-content` 内、`ThinkingIndicator` 之后、`MarkdownRenderer` 之前（:257-272，与思考指示器同级的元信息位）。
- i18n key（zh-CN / en）：`tools.status.searching`（正在搜索 "{{query}}"…）、`tools.status.readingPage`（正在读取第 {{page}} 页…）、`tools.status.listing`（正在查看打开的文档…）、`tools.callsSummary`（查阅了 {{count}} 处文档内容）等。
- 错误路径（工具执行失败文本返回给模型）不在 UI 单独标红——最终答案由模型给出，保持简单。

### 4.7 Prompt 调整

- `services/llm.ts` 的 `buildSystemPrompt` 不动；在 `runSessionStream` 构建 system 消息时，若 `toolsEnabled` 则**追加工具使用引导段**（来自 locale，不与用户可编辑的 systemPrompts 耦合，避免用户改提示词破坏工具引导）：
  - zh-CN `llm.toolsSystemAddendum`：大意——你可以使用工具查阅当前打开的 PDF 原文；当片段提及其他条款号、表格或定义且对准确解读有必要时，先用 search_in_pdf / read_pdf_page 查阅再回答；回答中引用来源格式为（第 N 页）；不要编造未查阅到的条款内容。
  - en.json 同步。

### 4.8 平台工具调用格式兼容性

> 调查方法：2026-07-18 六路并行查阅官方文档（DeepSeek / Kimi / GLM / 火山方舟 / 阿里百炼 / OpenAI+OpenRouter），逐平台核对 7 个 wire 格式问题（schema、流式分片、回放结构、tool 消息字段、reasoning 回放、并行调用、已知怪癖）。
> **总结论：按「宽容累积 + 保守回放 + 最小字段交集」一套逻辑即可覆盖全部预设平台，无需平台分支代码。**

#### 4.8.1 统一 wire 契约（本期采用）

**流式累积（后端）**：

- 按 `index` 归并；id/type/name 任一出现即更新，arguments 一律追加（OpenAI chunk schema 中 index 恒在、其余 optional；其余平台官方示例语义一致）。
- flush 以「finish_reason 非空 或 [DONE]」为准，不依赖 `finish_reason == "tool_calls"` 取值。
- OpenRouter 心跳注释行 / 流中 error 事件：现有解析已兼容。

**消息回放（前端构建 + 后端 WireMessage）**：

- assistant(tool_calls)：`content` 统一 `""`；tool_calls 元素带全 id/type/function.name/function.arguments。
- tool 消息：仅 `role` / `tool_call_id` / `content`（字符串），不带 `name`。
- **每个工具轮请求都带 tools 参数**（百炼兼容模式、OpenRouter 硬性要求；本 loop 天然满足。刻意不带 tools 的只有达上限的强制收尾轮）。
- 不传 `tool_choice` / `parallel_tool_calls` / 平台私有参数。
- **reasoning_content 全平台「有就回传」**：
  - DeepSeek 思考模式：工具调用轮**必须**回传，否则 400（[Thinking Mode 指南](https://api-docs.deepseek.com/guides/thinking_mode)）。
  - Kimi thinking（k2.6/k2.7-code/k3）：工具调用链内必须保留，否则报错（[k2.6 quickstart](https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart)）。
  - GLM：默认 `clear_thinking=true` 忽略（传不传均可）；`clear_thinking=false` 时必须原样回传（[思考模式](https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode)）。
  - 火山方舟：可选，不回传不报错（[深度思考](https://www.volcengine.com/docs/82379/1449737)）。
  - Qwen/百炼：官方建议不加、默认被忽略不报错；但百炼上第三方模型（DeepSeek 等）必须回传（[深度思考](https://help.aliyun.com/zh/model-studio/deep-thinking)）。
  - OpenAI Chat Completions：无此字段（被忽略）；OpenRouter：`reasoning_content` 是 `reasoning` 别名，工具调用场景要求保留（Gemini 上游不回传会 400）（[Reasoning Tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)）。
  - → 「有就回传」是唯一全平台安全策略；持久化的 assistant(toolCalls) 消息必须带 reasoningContent。

**其他**：

- arguments 不保证合法 JSON（OpenAI/DeepSeek/Ark/百炼官方一致警告）→ 执行器 parse 失败按工具错误文本回给模型（§4.3 已覆盖）。
- 服务端重复调用检测：百炼同名同参连续重复会 400；Kimi 官方建议客户端去重 → §4.4 同参去重正好满足。
- 工具名合规：三个工具名均满足 Kimi 最严正则 `^[a-zA-Z_][a-zA-Z0-9-_]{2,63}$`，且不碰百炼保留字 `search`。

#### 4.8.2 分平台差异速查（均来自官方文档）

| 平台       | 流式分片                                                                | tool 消息                              | reasoning_content 回放                            | 并行调用                                    | 备注                                                                              |
| ---------- | ----------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| DeepSeek   | 官方无文档，社区验证按 index 归并                                       | tool_call_id 必填，无 name             | 工具调用轮**必须**，否则 400                      | 支持（无开关参数）                          | deepseek-chat/reasoner 2026-07-24 停售，指向 v4-flash                             |
| Kimi       | index 归并；官方建议以 delta.tool_calls 判断而非 finish_reason          | tool_call_id 必填；name 可选           | thinking 链内必须；k2.7/k3 恒必须                 | 支持；必须返回全部结果                      | function.name 正则最严；usage 在 choices[0].usage（我们已发 include_usage，兼容） |
| 智谱 GLM   | index 归并；**arguments 分片需 tool_stream=true（4.6+），默认缓冲返回** | tool_call_id 示例均带；schema 无 name  | 默认忽略（clear_thinking=true）；false 时必须     | 官方 FAQ：每次调用只能命中一个              | tool_choice 仅 auto；finish_reason 有扩展取值（sensitive 等）                     |
| 火山方舟   | index 归并（index 未文档化但存在）                                      | tool_call_id 必填；name 未文档化但容忍 | 可选，不回传不报错                                | 支持，parallel_tool_calls 默认 true（1.6+） | assistant content/tool_calls 至少其一；encrypted_content 可忽略                   |
| 阿里百炼   | index 归并；name/id 首分片                                              | tool_call_id 示例均带                  | Qwen：不回传（被忽略）；第三方模型（DS 等）：必须 | parallel_tool_calls **默认 false**          | 每轮必须带 tools；同名同参重复会 400；tool 名不能叫 `search`                      |
| OpenAI     | index 恒在，其余 optional（权威 chunk schema）                          | tool_call_id 必填；无 name             | 无此字段                                          | 支持，parallel_tool_calls 可关              | content 带 tool_calls 时可省略                                                    |
| OpenRouter | 与 OpenAI 对齐（归一化），但上游差异需防御                              | tool_call_id 必填；name 容忍           | 工具调用场景必须保留（Gemini 400）                | 支持，默认 true                             | 心跳注释行；流中 error 事件；native_finish_reason                                 |

关键来源：DeepSeek [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) / [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)；Kimi [tool calls 指南](https://platform.kimi.ai/docs/guide/use-kimi-api-to-complete-tool-calls)；GLM [工具流式输出](https://docs.bigmodel.cn/cn/guide/capabilities/stream-tool) / [思考模式](https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode)；火山 [Function Calling](https://www.volcengine.com/docs/82379/1262342)；百炼 [qwen-function-calling](https://help.aliyun.com/zh/model-studio/qwen-function-calling)；OpenAI [API Reference](https://platform.openai.com/docs/api-reference/chat/create)；OpenRouter [Tool Calling](https://openrouter.ai/docs/features/tool-calling) / [Reasoning Tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)。

#### 4.8.3 调查对设计的修正（相对 v2）

1. **§4.1(a) 累积器改为宽容模式**：不假设「id/name 仅在首分片」；flush 以 finish_reason 非空或 [DONE] 为准，不依赖 `finish_reason == "tool_calls"` 取值。
2. **§4.1(b) WireMessage 定型**：tool 消息剔除 `name`；assistant(tool_calls) 消息 content 统一 `""`。
3. **§4.4 持久化补充**：assistant(toolCalls) 消息必须同时持久化 `reasoningContent`（DeepSeek/Kimi 续轮 400 硬约束），回放时带上。
4. **确认无需平台分支**：不发送 `tool_choice` / `parallel_tool_calls` / `tool_stream` 等平台特定参数；GLM 无 tool_stream 时 tool_calls 缓冲返回，宽容累积器天然兼容（仅状态行出现稍晚，见 §9）。
5. **同参去重从「优化」升级为「必需」**：百炼服务端对同名同参连续重复调用直接 400。

---

## 5. 安全与授权

- 工具只读 registry 登记的 fileHash（= 当前打开的 tab）；`read_pdf_bytes` 本身走后端路径白名单（`authorize_pdf_path`），打开的 tab 均已授权。
- 工具结果只含 PDF 文本，不含路径以外的任何本地信息；filePath 不暴露给模型（list_open_pdfs 只给 fileHash + fileName）。
- API Key 维持现状（后端 keyring，不经过前端）。
- 后端 `authorized_file_hashes` 强制白名单校验维持 Phase 6 预留，本期前端 registry 即授权边界。

## 6. 测试计划

**前端单元测试（Vitest）**：

- `services/pdfTools.test.ts`：三工具正常路径 + 白名单拒绝 + 页码越界 + 截断 + 搜索无命中 + 未知工具名 + argsJson 非法 JSON + 执行异常转错误文本（mock registry 与 pdfjs）；**session 生命周期**：dispose 后文档实例被 destroy、页文本缓存清空、dispose 幂等。
- `services/pdfToolsRegistry.test.ts`：sync 增删、关闭 tab 后 isAuthorized=false、numPages 回填保留、getCachedBytes 命中与回退。
- `hooks/usePersistence.test.tsx` 新增 agent loop 用例（mock `streamChatCompletion` scripted 事件流 + mock `beginToolSession`）：
  - 一轮 toolCall → 执行 → 二轮正文，最终内容正确；中间 assistant(toolCalls+reasoningContent) 与 tool 消息**已落盘**且 toolEvents 持久化；
  - 追问时消息构建**原样回放**持久化的工具消息（断言 invoke 收到的 messages 含 toolCalls/toolCallId/reasoningContent）；
  - 同参重复调用去重（不重复执行，但 tool 消息仍补齐）；
  - 达 maxRounds 后强制无 tools 最终轮；
  - 总开关关闭 / supportsTools=false → enableTools=false（断言 invoke 参数）；
  - **正常结束 / 报错 / 中止三条路径都调用了 dispose**；
  - 追问会话沿用 action 开启工具；翻译路径不传 enableTools。
- `services/sessions.test.ts`：tool 消息与扩展字段的 CRUD 往返。
- `services/llm.test.ts`：toolCall 事件解析入队；ChatMessage 类型统一后现有断言回归。
- `components/ToolCallsIndicator.test.tsx`：running/done/折叠渲染。
- `components/SettingsModal.test.tsx`：新开关渲染与保存。
- `services/settings.test.ts`：`agentToolsEnabled` 默认 true 与旧数据归一。

**后端 `cargo test`**：

- tool_calls 分片累积（切碎 arguments、id/name 出现在非首分片、多调用按 index 归并、finish_reason 触发 flush、无 finish_reason 时 [DONE] 兜底）。
- wire 序列化 snake_case（`tool_call_id` / `tool_calls` / `reasoning_content`）、tool 消息无 `name`、assistant(tool_calls) content=""。
- `agent_tools_enabled` serde 默认值。
- session 持久化：含 tool 消息的会话保存/加载往返。

**手工验证**（E2E 不覆盖，需真实 LLM）：用 sample PDF 选一段含条款引用的文本做解读，观察状态行→调用记录→最终答案引用来源；追问验证已查内容无需重新调用工具；关闭开关后回归纯解读；maxToolRounds=1 观察强制收尾。

## 7. 实施步骤（全部完成）

- [x] 1. **后端**：tool_calls 宽容累积 + WireMessage + `agent_tools_enabled` 字段 + cargo 测试。
- [x] 2. **通道层**：llm.ts 事件/类型统一、useStreaming 增加 onToolCall。
- [x] 3. **工具层**：pdfToolsRegistry + pdfTools（ToolSession）+ 单测。
- [x] 4. **agent loop**：runSessionStream 改造 + InterpretationMessage 扩展（TS+Rust 镜像）+ 工具消息落盘与回放 + usePersistence/sessions 测试。
- [x] 5. **UI 与设置**：ToolCallsIndicator、AiChatPanel 接入、功能设置开关、i18n（zh-CN/en）、prompt addendum。
- [x] 6. **回归**：`npm run test`、`type-check`、`lint`、`cargo test`、既有 E2E 全绿；更新 AGENTS.md（新模块与命令说明）。

## 8. 风险与缓解

| 风险                                         | 缓解                                                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 模型乱调工具导致 token 膨胀                  | 轮次上限 + 同参去重 + 页文本截断；用户可关总开关                                                                                   |
| 工具消息持久化回放推高追问 token             | 页文本截断（8000 字符）控制单条上限；超上下文走 contextLengthExceeded + frozen 会话；后续可按「旧轮次 tool 结果截断」优化（见 §9） |
| 平台 wire 格式差异导致工具调用失败           | §4.8 已逐平台核实：宽容累积 + 最小字段交集 + reasoning_content 有就回传，一套逻辑全覆盖；toolError 有结构化错误路径                |
| 工具侧文档实例占内存                         | 瞬态方案：仅 loop 存活期间存在，finally dispose；只提取文本不渲染；bytes 优先复用 App 缓存                                         |
| 连续解读重复解析文档                         | 典型 PDF 亚秒级，bytes 有缓存无磁盘 IO；如后续成为瓶颈可加短时空闲缓存（见 §9）                                                    |
| 平台 tools 兼容性参差（尤其 custom baseUrl） | 静默降级；custom 平台用户自行承担兼容性                                                                                            |
| 多轮调用流式中断在半轮                       | 每轮独立 cancel 注册；轮次间检查 abort；finally 保证 dispose；中断按现有 StreamInterrupted 错误展示                                |
| 用户改过 system prompt 导致不引用来源        | 工具引导段独立于用户 prompt 追加，不被覆盖                                                                                         |

## 9. 开放问题

- `list_open_pdfs` 的 numPages 在文档未加载时省略——模型可能先调 read 再 list，可接受，不优化。
- 追问回放时是否对**较早轮次**的 tool 结果做截断（如只保留最近一轮完整结果）：本期原样回放，观察实际 token 消耗后再定。
- GLM 的 arguments 流式分片需 `tool_stream=true`（4.6+）：本期不发平台特定参数，GLM 工具调用为缓冲返回（状态行出现较晚但功能正常）。后续如需更快反馈可加平台参数映射。
- 瞬态文档实例在连续多次解读间会重复解析（亚秒级）：如成为可感知瓶颈，可加「loop 结束后保留 N 分钟空闲缓存再销毁」的优化，本期不做。
- 工具结果是否做跨会话页文本磁盘缓存：本期不做（内存缓存足够）。
