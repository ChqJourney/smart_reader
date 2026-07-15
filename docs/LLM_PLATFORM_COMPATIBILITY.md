# LLM 平台兼容性调研报告

> 日期：2026-07-15
> 目的：为方案 B（Rust 后端代理 LLM 请求）的设计提供依据，评估主流 LLM 平台的兼容性，并给出 Settings Modal 的简化建议。
> 背景：dev 状态下 DeepSeek 调用正常，火山引擎 Coding Plan 报 `TypeError: Load failed`。根因是火山引擎 Coding Plan 端点 CORS 不允许 `authorization` 头。

---

## 一、主流 LLM 平台 OpenAI 兼容 API 对比

### 1.1 在线推理 API（按量计费，第三方应用合规使用）

| 平台 | Base URL | 认证 | 模型名示例 | OpenAI 兼容 | 备注 |
|---|---|---|---|---|---|
| DeepSeek | `https://api.deepseek.com` 或 `/v1` | `Bearer sk-...` | `deepseek-chat`、`deepseek-reasoner` | ✅ 完整 | 国内最便宜之一 |
| Kimi (Moonshot) | `https://api.moonshot.cn/v1`（国内）<br>`https://api.moonshot.ai/v1`（国际） | `Bearer sk-...` | `kimi-k2.6`、`moonshot-v1-8k` | ✅ 完整 | 长上下文优势 |
| 阿里云百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `Bearer sk-...` | `qwen-plus`、`qwen-max`、`deepseek-v3`、`kimi-k2` | ✅ 完整 | 聚合 Qwen/DeepSeek/Kimi/GLM/MiniMax 等多家模型 |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4/`（**末尾斜杠不能省**） | `Bearer xxxxxx.yyyyyyyy`（含点号） | `glm-5`、`glm-5.2`、`glm-4-flash` | ✅ 完整 | API Key 是两段式，含点号 |
| 火山引擎方舟 | `https://ark.cn-beijing.volces.com/api/v3` | `Bearer sk-...` | `doubao-seed-2-0-pro-260215`、`deepseek-v3-2-251201` | ✅ 完整 | 模型名是「Model ID」长串，不是模型品牌名 |
| OpenRouter | `https://openrouter.ai/api/v1` | `Bearer sk-or-...` | `openai/gpt-4o`、`anthropic/claude-sonnet-4` | ✅ 完整 | 聚合 300+ 模型，模型名是 `provider/model` 格式 |
| OpenAI 官方 | `https://api.openai.com/v1` | `Bearer sk-...` | `gpt-4o-mini`、`gpt-4o` | ✅ 完整 | 默认配置 |

### 1.2 订阅套餐 API（Coding Plan / Token Plan 等）

| 平台 | 套餐 | 专用 Base URL | 使用条款限制 |
|---|---|---|---|
| 火山引擎 | Coding Plan (Lite/Pro) | `https://ark.cn-beijing.volces.com/api/coding/v3` | **仅限交互式编程工具使用，禁止 API 调用或自动化任务** |
| 智谱 | GLM Coding 套餐 | `https://open.bigmodel.cn/api/coding/paas/v4` | **仅限 Coding 场景，不适用通用 API 场景** |
| 阿里云 | Token Plan 团队版 | `token-plan.cn-beijing.maas.aliyuncs.com` | **仅限兼容的 AI 工具交互式使用，不可用于自动化脚本或应用后端** |
| 阿里云 | Coding Plan | `coding.dashscope.aliyuncs.com` | 同上 |
| Kimi | Kimi Code（会员） | 无独立 API，会员权益在 Kimi 客户端内使用 | 会员仅限 Kimi 助手内使用，API 仍是按量计费 |

**关键结论**：所有「订阅套餐」类 API 在条款上都**禁止第三方桌面应用使用**，仅允许官方认可的编程工具（Claude Code、Cursor、Qwen Code、OpenClaw 等）。SpecReader AI 作为第三方桌面应用，**应当引导用户使用各平台的「在线推理 API」（按量计费）**，不应支持 Coding Plan / Token Plan 端点。

---

## 二、CORS 实测对比（决定方案 B 必要性的关键证据）

实测方法：用 curl 模拟 webview 发起的 CORS 预检（OPTIONS）和实际 POST（带 fake key 看 CORS 响应头）。

| 平台 | 端点 | 预检 allow-headers 是否含 `authorization` | 实际响应是否带 `Access-Control-Allow-Origin` | webview 能否直接调用 |
|---|---|---|---|---|
| DeepSeek | `api.deepseek.com` | ✅ `authorization,content-type` | ✅ 401 也带 | ✅ 能 |
| Kimi | `api.moonshot.cn` | ✅ `authorization,content-type` | （预检已通过） | ✅ 能 |
| 阿里云百炼 | `dashscope.aliyuncs.com/compatible-mode/v1` | ✅ `authorization, content-type` | （预检已通过） | ✅ 能 |
| 智谱 GLM 通用 | `open.bigmodel.cn/api/paas/v4` | ✅ `authorization, content-type` | （预检已通过） | ✅ 能 |
| 智谱 GLM Coding | `open.bigmodel.cn/api/coding/paas/v4` | ✅ `authorization, content-type` | （预检已通过） | ✅ 能（但条款禁止） |
| 火山引擎 ARK 在线推理 | `ark.cn-beijing.volces.com/api/v3` | ⚠️ 预检回显，但实际响应不带 CORS 头 | ❌ 不带 | ❌ 不能 |
| 火山引擎 Coding Plan | `ark.cn-beijing.volces.com/api/coding/v3` | ❌ 仅 `Origin,Content-Length,Content-Type` | ❌ 不带 | ❌ 不能 |
| OpenRouter | `openrouter.ai/api/v1` | ✅ 含 `Authorization` | （预检已通过） | ✅ 能 |

**结论**：
- 火山引擎方舟是**唯一**一家 CORS 支持不完整的在线推理平台。其 Coding Plan 端点预检阶段就拒绝 `authorization` 头，在线推理端点预检通过但实际响应不带 CORS 头。
- 其他主流平台 webview 都能直接调用，但**这并不意味着不需要方案 B**——见下文。

---

## 三、方案 B 必要性再论证

### 3.1 即使 CORS 支持，方案 B 仍有以下不可替代的价值

| 价值点 | 说明 |
|---|---|
| **API Key 不再暴露给 webview** | 当前 webview 内存里持有 API Key，devtools 可见，键盘记录器可窃取。方案 B 让 Key 只在 Rust 后端（从 keyring 读取）短驻内存，彻底解决项目记忆 W-4 的安全顾虑。 |
| **绕过所有 CORS 限制** | 当前火山引擎方舟不可用。未来任何新平台若 CORS 策略变化，方案 B 都不受影响。 |
| **统一请求行为** | Rust `reqwest` 的 TLS、HTTP/2、超时、重试、代理设置与系统一致，避免 webview 在不同平台（macOS WKWebView / Windows WebView2）行为差异。 |
| **支持企业内网代理** | 企业用户常走 HTTP 代理，Rust 后端可读取系统代理设置（reqwest 默认支持），webview fetch 对系统代理支持差。 |
| **请求日志与诊断** | 后端可统一记录请求/响应（脱敏），便于排查"为什么这次翻译失败"。 |
| **为未来功能铺路** | 后续要做「术语表」「引用追踪」「多模态读表」时，需要在后端拼装复杂 prompt，方案 B 是基础设施。 |

### 3.2 方案 B 的设计要点

#### 命令签名（建议）

```rust
#[tauri::command]
async fn chat_completions_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, LlmState>,
    messages: Vec<ChatMessage>,
    on_event: tauri::ipc::Channel<StreamEvent>,
) -> Result<StreamHandle, String>
```

- `LlmConfig`（baseUrl/model）从前端传入或从 settings 读取
- `apiKey` 从 keyring 读取，**不从前端传入**
- 流式回传用 Tauri 2 的 `Channel` API（比 event 更高效，单向）
- 中止用返回的 `StreamHandle`（内部 cancel token）

#### StreamEvent 类型

```rust
#[serde(rename_all = "camelCase")]
enum StreamEvent {
    Chunk { content: String },
    Error { message: String },
    Done,
}
```

#### 前端改造

`src/services/llm.ts` 的 `streamChatCompletion` 改造：
- 不再 `fetch`，改为 `invoke('chat_completions_stream', { messages, onEvent })`
- 通过 channel 回调 yield chunk
- AbortSignal 改为 invoke 一个 `cancel_chat_completions` 命令

---

## 四、Settings Modal 简化建议（面向非程序员）

### 4.1 当前 UI 的问题

当前 SettingsModal 模型设置页（`src/components/SettingsModal.tsx:335-373`）是三个文本框：
1. API Base URL（placeholder: `https://api.openai.com/v1`）
2. Model（placeholder: `gpt-4o-mini`）
3. API Key（placeholder: `sk-...`）

**对非程序员的问题**：
- 不知道 Base URL 是什么、去哪查、填错一个字符就不工作（如末尾斜杠、大小写）
- 不知道 Model 名怎么填，各家命名规则不同（火山引擎是 `doubao-seed-2-0-pro-260215` 长串，智谱要大写，OpenRouter 是 `provider/model`）
- 不知道去哪申请 API Key
- 填错后报错信息晦涩（`TypeError: Load failed`、`401 AuthenticationError`），用户无法定位是哪一项错

### 4.2 推荐改进：平台预设 + 模型下拉 + 连接测试

#### 新增「平台」下拉选择（一级选项）

```
平台: [ DeepSeek ▾ ]
       ├─ DeepSeek
       ├─ Kimi（月之暗面）
       ├─ 阿里云百炼（通义千问等）
       ├─ 智谱 GLM
       ├─ 火山引擎方舟（豆包等）
       ├─ OpenRouter（聚合多家模型）
       ├─ OpenAI 官方
       └─ 自定义（高级）
```

#### 选定平台后的行为

| 字段 | 行为 |
|---|---|
| Base URL | 自动填入预设值，默认只读（点击"高级"可编辑，给特殊需求） |
| 模型 | 变成下拉选择，列出该平台常用模型（含简短说明，如"qwen-plus — 性能均衡，推荐"） |
| API Key | 仍是文本框，旁边显示「如何获取 API Key?」链接，跳转该平台控制台 |
| 连接测试 | 新增「测试连接」按钮，发送最小请求验证三项配置是否正确 |

#### 预设配置表（建议内置）

```typescript
const PLATFORM_PRESETS = {
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    models: [
      { id: "deepseek-chat", label: "DeepSeek Chat（日常对话，便宜）" },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner（带思考链，慢但准）" },
    ],
    apiKeyHelpUrl: "https://platform.deepseek.com/api_keys",
  },
  kimi: {
    label: "Kimi（月之暗面）",
    baseUrl: "https://api.moonshot.cn/v1",
    models: [
      { id: "kimi-k2.6", label: "Kimi K2.6（最新，最强）" },
      { id: "moonshot-v1-8k", label: "Moonshot V1 8K（短上下文，便宜）" },
      { id: "moonshot-v1-32k", label: "Moonshot V1 32K（中等上下文）" },
      { id: "moonshot-v1-128k", label: "Moonshot V1 128K（超长上下文）" },
    ],
    apiKeyHelpUrl: "https://platform.moonshot.cn/console/api-keys",
  },
  bailian: {
    label: "阿里云百炼（通义千问等）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: [
      { id: "qwen-plus", label: "Qwen Plus（性能均衡，推荐）" },
      { id: "qwen-max", label: "Qwen Max（旗舰，最强）" },
      { id: "qwen-turbo", label: "Qwen Turbo（最快，最便宜）" },
      { id: "deepseek-v3", label: "DeepSeek V3（百炼直供）" },
      { id: "kimi-k2", label: "Kimi K2（百炼直供）" },
    ],
    apiKeyHelpUrl: "https://bailian.console.aliyun.com/?apiKey=1",
  },
  glm: {
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4/",
    models: [
      { id: "glm-5.2", label: "GLM-5.2（最新旗舰）" },
      { id: "glm-4-flash", label: "GLM-4 Flash（轻量，免费）" },
    ],
    apiKeyHelpUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    apiKeyHint: "API Key 是两段式（含点号），请完整复制",
  },
  volcengine: {
    label: "火山引擎方舟（豆包等）",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: [
      { id: "doubao-seed-2-0-pro-260215", label: "Doubao Seed 2.0 Pro（旗舰）" },
      { id: "doubao-seed-2-0-lite-260215", label: "Doubao Seed 2.0 Lite（轻量）" },
      { id: "deepseek-v3-2-251201", label: "DeepSeek V3.2（方舟直供）" },
    ],
    apiKeyHelpUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apikey",
    modelIdHint: "火山引擎的模型名是「Model ID」长串，请从方舟控制台「在线推理」页复制",
  },
  openrouter: {
    label: "OpenRouter（聚合多家模型）",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      { id: "openai/gpt-4o-mini", label: "GPT-4o mini（便宜）" },
      { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4（强）" },
      { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
    ],
    apiKeyHelpUrl: "https://openrouter.ai/keys",
    apiKeyHint: "OpenRouter 的 Key 以 sk-or- 开头",
  },
  openai: {
    label: "OpenAI 官方",
    baseUrl: "https://api.openai.com/v1",
    models: [
      { id: "gpt-4o-mini", label: "GPT-4o mini（便宜，推荐）" },
      { id: "gpt-4o", label: "GPT-4o（旗舰）" },
    ],
    apiKeyHelpUrl: "https://platform.openai.com/api-keys",
  },
  custom: {
    label: "自定义（高级）",
    baseUrl: "",
    models: [],
    // 回退到当前的三文本框模式
  },
};
```

#### 「测试连接」按钮的设计

- 点击后用当前配置发送一个最小请求：`messages: [{role:"user", content:"hi"}]`，`stream:false`
- 成功 → 绿色提示"连接正常，模型：XXX"
- 失败 → 红色提示 + 错误分类：
  - `401 AuthenticationError` → "API Key 不正确，请检查"
  - `404 model not found` → "模型名错误，请从下拉框选择或检查控制台"
  - `Load failed / 网络错误` → "无法连接到 Base URL，请检查网络或代理"
  - 其他 → 显示原始错误信息

### 4.3 关于 Coding Plan / Token Plan 的处理

**建议不主动支持，但在帮助文档中说明**：

在 SettingsModal 底部加一行小字提示：
> 💡 请使用各平台的「在线推理 API」（按量计费）。Coding Plan / Token Plan 等订阅套餐仅限官方编程工具使用，第三方应用不可用，且端点不同。详见 [帮助文档]。

如果用户在"自定义"模式填了已知的 Coding Plan 端点（如 `ark.cn-beijing.volces.com/api/coding/v3` 或 `open.bigmodel.cn/api/coding/paas/v4`），可以给出警告 toast：
> ⚠️ 检测到 Coding Plan 端点。该端点仅限官方编程工具使用，SpecReader AI 不保证可用性，且可能违反平台使用条款。

---

## 五、方案 B 实现的工作量评估

### 5.1 后端（Rust）改动

| 改动 | 文件 | 工作量 |
|---|---|---|
| 新增 `llm_proxy.rs` 模块 | `src-tauri/src/llm_proxy.rs` | 中 |
| 用 reqwest 实现 SSE 流式转发 | 同上 | 中 |
| 从 keyring 读取 API Key | 复用现有 `keyring` crate | 小 |
| 注册 `chat_completions_stream` / `cancel_chat_completions` 命令 | `src-tauri/src/lib.rs` | 小 |
| 定义 `StreamEvent` serde 结构 | `src-tauri/src/llm_proxy.rs` | 小 |
| 单元测试（mock SSE 响应） | `src-tauri/src/llm_proxy.rs` | 中 |

### 5.2 前端改动

| 改动 | 文件 | 工作量 |
|---|---|---|
| `streamChatCompletion` 改用 invoke + Channel | `src/services/llm.ts` | 中 |
| 中止逻辑改为 invoke `cancel_chat_completions` | `src/services/llm.ts` + 调用方 | 小 |
| 删除 webview fetch 相关代码 | `src/services/llm.ts` | 小 |
| SettingsModal 加平台预设下拉 | `src/components/SettingsModal.tsx` | 中 |
| 加模型下拉（依赖平台选择） | 同上 | 中 |
| 加「测试连接」按钮 | 同上 + 新 service | 中 |
| 单测调整（mock invoke 替代 mock fetch） | `src/services/__tests__/` | 中 |

### 5.3 配置/权限改动

| 改动 | 文件 | 说明 |
|---|---|---|
| `reqwest` 已在 Cargo.toml | 无需新增 | 已有 `features = ["stream"]` |
| `tauri-plugin-shell` 可移除（W-2） | `Cargo.toml` + `capabilities/default.json` | 顺手清理 |
| CSP 可收紧 | `tauri.conf.json` | 方案 B 后 webview 不再发 https，CSP 的 `connect-src https:` 可收紧为 `connect-src 'self'`（更安全） |

---

## 六、总结与建议

### 6.1 兼容性结论

- **OpenAI 兼容协议是事实标准**，所有主流平台的在线推理 API 都兼容，方案 B 用一套 `reqwest` 转发即可覆盖全部。
- **Coding Plan / Token Plan 不应支持**：条款禁止第三方应用使用，且端点与在线推理不同。引导用户用在线推理 API。
- **火山引擎方舟是唯一 CORS 受限的平台**，方案 B 是唯一彻底解法（即使其他平台 CORS 支持，方案 B 仍有安全/代理/诊断价值）。

### 6.2 Settings Modal 改进建议（按优先级）

| 优先级 | 改进 | 价值 |
|---|---|---|
| P0 | 平台预设下拉 + Base URL 自动填充 | 解决"不知道填什么" |
| P0 | 模型下拉选择（含说明） | 解决"模型名怎么填" |
| P0 | 「测试连接」按钮 + 错误分类提示 | 解决"填的对不对" |
| P1 | 「如何获取 API Key」链接 | 解决"去哪申请" |
| P1 | Coding Plan 端点检测警告 | 避免用户误用 |
| P2 | CSP 收紧 | 安全加固 |
| P2 | 移除未用的 `tauri-plugin-shell` | 清理攻击面（W-2） |

### 6.3 实施顺序建议

1. **先做方案 B 的后端代理**（解决火山引擎 + 安全 + 代理）→ 跑通端到端流式
2. **再做 Settings Modal 的平台预设 + 测试连接**（提升易用性）
3. **最后做 CSP 收紧 + shell 插件移除**（安全加固，顺手清账）

每一步独立可测、可回滚。

### 6.4 风险提示

- **流式中止**：Tauri 2 的 Channel 是单向回传，中止需要前端 invoke 一个 cancel 命令，后端用 cancel token 中止 reqwest future。需要测好「正在流式时切换 tab / 关闭 PDF」的中止时机。
- **超时**：长解读可能 30s+，reqwest 默认超时要调大或关闭，改为前端通过 abort 控制。
- **错误透传**：后端要把上游 4xx/5xx 的 JSON body 透传给前端，否则用户看不到"模型名错误"等关键信息。
- **API Key 迁移**：当前 Key 存 keyring，方案 B 后前端不再读 Key，需要确认 keyring 读取逻辑能平滑迁移（已有 H-10 修复，应无问题）。
