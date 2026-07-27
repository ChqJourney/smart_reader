# SpecReader AI · UI 交互语言对非程序员友好度审查

> 审查对象：面向检测认证工程师（懂 IEC/ISO/EN/GB 等标准，但**非程序员**）的桌面端标准阅读助手
> 审查范围：文案术语、i18n 覆盖、错误反馈、交互可发现性、UI 样式提示
> 审查日期：2026-07-27
> 方法：全量普查 `zh-CN.json` + 18 个核心组件用户可见文本，并核验关键渲染路径

## 总评

| 维度 | 评分 | 说明 |
|---|---|---|
| 领域术语（标准/条款/解读/翻译） | ✅ 优秀 | 完全贴合工程师语言，无 jargon |
| 日常操作文案（打开/搜索/暂存/批注） | ✅ 良好 | 中文清晰、有 placeholder 引导 |
| 配置环节术语 | ⚠️ 较差 | `Model`/`API Base URL`/`API Key` 三个英文裸标签 |
| 错误反馈 | ❌ 差 | 设置页把英文原始报错直接透传显示 |
| 交互可发现性（快捷键/窗口控制） | ⚠️ 一般 | 部分快捷键无 UI 提示 |

**一句话结论**：产品方向正确（首次配置向导体验很好），但「设置页」和「错误提示」两处没有复用向导的「友好中文 + 操作指引」风格，是当前最大的非程序员友好度短板。

---

## 一、文案术语问题（最核心）

### 🔴 P0 — 设置页三个英文裸标签（直接影响能否配通模型）

源码 `zh-CN.json` 实测值：

| Key | 当前显示 | 建议改为 | 理由 |
|---|---|---|---|
| `settings.apiBaseUrl` | `API Base URL` | `API 地址（接口地址）` | 工程师不知 "Base URL" 是何物 |
| `settings.model` | `Model` | `模型名称` | 纯英文单词最刺眼 |
| `settings.apiKey` | `API Key` | `API 密钥` | "Key" 程序员黑话 |
| `settings.llmApi` | `大模型API KEY` | `大模型 API 密钥` | 大小写混排不专业 |

> 对比：首次向导里 `wizard.apiKey` 同样显示 `API Key`，应一并统一。

### 🟡 P1 — 英文单位 / 枚举直接面对用户

- **`tokens`**：出现在「思考中…（约 N tokens）」「上下文已用 X%（N / M tokens）」。普通用户完全不懂。
  - 建议：上下文 Widget 只显示百分比 + 文案「上下文用量」，隐藏 tokens 字眼；思考指示器可改为「正在深度思考…」不暴露 token。
- **日志级别** `TRACE / DEBUG / INFO / WARN / ERROR`：`SettingsModal` 里 `level.toUpperCase()` 全大写英文，且提示「Release 默认 Warn」。
  - 建议：绝大多数用户不需要此功能，应折叠进「高级」并至少加一句中文说明「仅用于排查问题，一般无需修改」；枚举可保留英文但加括号说明（跟踪/调试/信息/警告/错误）。
- **`ECDICT` / `MB`**：词典说明里出现。属专有名词，可保留但加括号中文（ECDICT 英汉词典；MB 兆字节）。

### 🟢 可接受但可弱化

- 品牌标识 `SpecReader AI`、应用标识 `com.photonee.specreader` 属技术性字符串，可接受，但关于页建议弱化显示（小字/灰色），避免与功能文案争夺注意力。

---

## 二、i18n 覆盖缺口（影响术语统一与可维护性）

实测 `zh-CN.json` **不存在**以下 key，文字均写死在组件 `defaultValue` 里：

- **整个首次配置向导 `wizard.*`**：约 40 条用户可见文案全在 `SetupWizard.tsx` 内联。虽然当前是友好中文，但（a）无法统一术语、（b）`en.json` 已预埋却无向导英文对应、（c）未来切英文会遗漏。
- **思考指示器 `thinking.*` / 上下文 Widget `contextWidget.*`**：含 `tokens` 字眼，未进语言包。
- **设置页 `settings.thinkingMode` / `settings.maxToolRounds`** 等：仅在组件 defaultValue。

> 建议：把所有用户可见文本收编进 `zh-CN.json`，统一术语与汉化入口。

---

## 三、错误 / 失败反馈（对非程序员最伤害信任感）

### 🔴 P0 — 原始报错透传（设置页比向导更不友好）

`zh-CN.json` 中 6 个错误 key 的值**就是** `{{defaultValue}}`：

```
"errorNetwork": "{{defaultValue}}",
"errorAuth": "{{defaultValue}}",
"errorModelNotFound": "{{defaultValue}}",
"errorRateLimit": "{{defaultValue}}",
"errorContextLength": "{{defaultValue}}",
"errorServer": "{{defaultValue}}",
```

而 `SettingsModal.formatLlmError()` 用 `t("settings.errorAuth", { defaultValue: err.detail })` —— 即 **`err.detail`（后端原始报错，常是英文，如 "Incorrect API key provided"）原样显示给用户**。

矛盾点：同名错误在 `SetupWizard.describeError()` 里**已写成友好中文**（"密钥无效或未授权…" / "网络无法连接…"）。同一类错误，向导友好、设置页却抛英文原始信息，**两处不一致，且设置页反而更糟**。

其他透传点：
- `SettingsModal` 兜底 `JSON.stringify(err)` 可能把整段 JSON 抛给用户。
- `TranslatePopup` 直接 `setError(message)` 显示上游错误字符串。

> 建议：统一复用 `SetupWizard` 的「友好中文 + 可执行操作指引」文案；原始报错**仅写入日志，UI 不显示**。

### 🟡 P1 — 失败无反馈 / 反馈弱

- 软件更新检查失败：仅记日志，用户无感知。
- 离线词典下载失败：仅「词典下载失败」一句话，无下一步指引。
- 退出落盘 3 秒超时：仅日志，无提示。

> 建议：关键失败给出明确「下一步做什么」（如"检查网络后重试""存储空间不足，请清理"）。

---

## 四、交互方式与可发现性

### 🟡 P1 — 快捷键不可见

| 快捷键 | 功能 | UI 是否告知 |
|---|---|---|
| Ctrl/Cmd+G | 跳页 | ✅ 有提示（好） |
| Alt+Enter | 最近文件并排打开 | ✅ 有提示（好） |
| Ctrl/Cmd+F | 搜索 | ❌ 搜索框仅占位符"搜索 PDF 内容" |
| Ctrl/Cmd+Shift+O | 最近文件面板 | ❌ 触发按钮无标注 |
| Ctrl+滚轮 | 缩放 | ❌ 无提示 |
| PageUp/PageDown | 翻页 | ❌ 无提示 |

> 建议：搜索框 placeholder 加「（Ctrl/Cmd+F）」；缩放、翻页等在首次使用或帮助里说明；保持"hover tooltip 告知"的现有好做法推广到所有入口。

### 🟡 P2 — 拖拽 / 并排交互门槛高

- 拖 tab 到阅读区并排、Alt+Enter 较隐晦；`splitHint` 文案只在最近文件面板出现。
- 建议：用户首次打开第二个 PDF 时给一次轻量引导气泡；确认工具栏「并排对照」按钮常驻可见（已有 `enterSplitView`，需确认可见性）。

### ✅ 做得好的微交互

- 选区浮动工具条（暂存/解读/翻译/复制/批注）直观清晰。
- 缩放输入框提示「输入百分比（如 150）或比例值（如 1.5）」——这种**带示例的 placeholder** 应作为范式推广到所有输入框（如 API 地址、模型名）。

---

## 五、UI 样式提示 / 可发现性（affordance）

- 无边框自定义标题栏的窗口控制按钮（最小化/最大化/关闭）仅图标，需确认有 `aria-label`/tooltip；非程序员可能找不到关闭。对应 key（`app.minimize`/`app.close` 等）已存在，需确认渲染到按钮。
- 设置页「更多设置」折叠了思考模式 / 最大工具调用次数 —— 把高级项藏起来是对的，普通用户不该看到。
- 建议给专业术语加「?」帮助气泡，例如 API 地址旁「去哪里复制这个地址？」。

---

## 六、整改优先级（给开发者）

**P0（立即改，影响核心可用性）**
1. 设置页 `Model` / `API Base URL` / `API Key` 三标签汉化（及 `大模型API KEY` 大小写统一）。
2. 错误透传改为友好中文（复用 `SetupWizard.describeError` 文案，原始报错入日志不显示）。

**P1**
3. `tokens` / 日志级别 汉化或隐藏到高级区。
4. 把 `SetupWizard` 等缺失文本收编进 `zh-CN.json`。
5. 关键失败（更新 / 词典下载）给明确下一步反馈。

**P2**
6. 快捷键在 UI 可见化（搜索框、缩放、翻页）。
7. 窗口控制按钮加 tooltip。
8. 复杂交互（并排对照）首次轻引导。

---

## 附：值得保留的优秀实践（勿动）

- 首次配置向导整体体验（推荐 DeepSeek、按难易度排序、友好错误、操作指引）—— 是当前最贴合非程序员的范式，应把这套风格**复刻到设置页与所有错误提示**。
- 词典下载「约 200 MB / 解压后约 700 MB」的明确体积提示。
- 带示例的输入框 placeholder。
- 最近文件失效「文件已移动或删除」置灰提示。

---

## 七、复核核实结果（2026-07-27，对照源码逐条验证）

| 报告论断 | 结论 | 证据 |
|---|---|---|
| 设置页 `API Base URL` / `Model` / `API Key` / `大模型API KEY` 裸标签 | ✅ 属实 | `src/locales/zh-CN.json:142-144,137` |
| 向导 `wizard.apiKey` 同样显示 `API Key` | ⚠️ 部分属实 | `wizard.apiKey` 仅作输入框 aria-label（`SetupWizard.tsx:376`）；用户可见的 `API Key` 出现在第 2 步标题「填入 {{platform}} 的 API Key」（`SetupWizard.tsx:351`）。结论不变，应一并汉化 |
| 思考指示器暴露 `tokens` | ✅ 属实 | `ThinkingIndicator.tsx:26-31`，defaultValue 内联，locale 无 `thinking.*` |
| 上下文 Widget 暴露 `tokens` | ⚠️ 需补充 | `ContextWidget.tsx:52` 屏幕上只显示 `NN%`；`tokens` 字眼仅在悬停 tooltip（`ContextWidget.tsx:37-42`）。危害比报告描述的略小 |
| 日志级别全大写英文 + 「Release 默认 Warn」 | ✅ 属实 | `SettingsModal.tsx:980`、`zh-CN.json:187` |
| 6 个错误 key 值为 `{{defaultValue}}`，设置页透传原始报错 | ✅ 属实 | `zh-CN.json:153-158`、`SettingsModal.tsx:387-414`（i18next 会把 `err.detail` 插值进 `{{defaultValue}}` 原样返回） |
| `SettingsModal` 兜底 `JSON.stringify(err)` | ✅ 属实 | `SettingsModal.tsx:408-412` |
| 向导 `describeError` 已是友好中文，两处不一致 | ✅ 属实 | `SetupWizard.tsx:135-178` |
| `TranslatePopup` 直接显示上游错误字符串 | ✅ 属实 | `TranslatePopup.tsx:106,173` |
| `wizard.*` / `thinking.*` / `contextWidget.*` 未进语言包 | ✅ 属实 | `zh-CN.json` 全文无这些前缀 |
| `settings.thinkingMode` / `maxToolRounds` 仅在组件 defaultValue | ✅ 属实 | `SettingsModal.tsx:729-755,869-891`，locale 中确无这些 key |
| 启动自动更新检查失败仅记日志 | ✅ 属实 | `App.tsx:144-149`（但见八-2：手动检查路径不同） |
| 词典下载失败仅一句话 | ✅ 属实 | `zh-CN.json:212`「词典下载失败」 |
| 退出落盘 3 秒超时仅日志 | ✅ 属实 | `App.tsx:477`（3000ms race 超时后放弃等待） |
| 快捷键提示：跳页 ✅ / Alt+Enter ✅ / 搜索框 ❌ / 最近文件触发钮 ❌ / Ctrl+滚轮 ❌ / PageUp·Down ❌ | ✅ 属实 | `zh-CN.json:27,114,40`；`RecentFilesBar.tsx:296-297`（title 仅「最近打开的文件」）；缩放按钮 title 仅「缩小/放大」 |
| 窗口控制按钮 aria-label / tooltip「需确认」 | ✅ 已确认，无需整改 | `TitleBar.tsx:119-136` 三个按钮均有 `aria-label` + `title`，且文案已中文化（`zh-CN.json:11-13`） |
| 「更多设置」折叠思考模式 / 最大工具调用次数 | ⚠️ 需修正 | 「更多设置」内只有思考模式（`SettingsModal.tsx:711-761`）；最大工具调用次数在「智能查阅文档」开启后常驻显示（`SettingsModal.tsx:867-893`），不在折叠区内 |
| 带示例的缩放 placeholder 范式 | ✅ 属实 | `zh-CN.json:32` |

---

## 八、复核新发现问题（追加）

### 🔴 P0-补 1 — 错误透传的根因在 `services/llm.ts`，波及面比报告更大

报告只点名了设置页与翻译浮层，实际根因是 `errorToMessage()`（`src/services/llm.ts:203-245`）：它引用的 `llm.error.network` / `auth` / `modelNotFound` / `rateLimit` / `contextLengthExceeded` / `serverError` / `streamInterrupted` / `invalidConfig` / `toolError` **这 9 个 key 在 `zh-CN.json` 中根本不存在**（`zh-CN.json:220-227` 只有 `apiKeyMissing` / `apiError` / `streamReadError` / `llmApiError` / `requestFailed`），全部回落到 `defaultValue: error.detail` —— 即**所有**运行时 LLM 错误（解读记录、追问、翻译浮层，经 `usePersistence.ts:765` 加 `[错误]` 前缀展示）都会把后端英文原文抛给用户，不止设置页一处。

另外三个已存在的 key 本身也内嵌原始报文：

- `llm.error.apiError`：`LLM API 错误 ({{status}}): {{detail}}`（detail 是上游响应 body）
- `llm.error.llmApiError`：`LLM API 错误: {{detail}}`
- `llm.error.requestFailed`：`请求失败: {{message}}`（`message` 为 `String(err)`，`llm.ts:195`）

> 建议：补齐 `llm.error.*` 全部 key 为友好中文（可直接复用 `SetupWizard.describeError` 文案，两处文案本就应统一）；`{{detail}}` 一律只进日志不进 UI。修复为纯语言包数据改动 + 删除 `errorToMessage` 里的 `defaultValue` 回落。

### 🔴 P0-补 2 — 设置页另有两处原始报错透传（报告未覆盖）

- **保存失败**：`settings.saveFailed` = `保存失败：{{error}}`（`zh-CN.json:159`，`SettingsModal.tsx:1122-1128`）。钥匙串不可用时后端返回的英文 OS 错误会直接显示。
- **手动检查更新失败**：`settings.updateError` = `检查更新失败：{{error}}`（`zh-CN.json:200`，`SettingsModal.tsx:1094-1097`）。报告说「更新失败仅记日志」只对**启动自动检查**成立；「关于」页手动点「检查更新」失败时会把 updater 插件的英文原始错误显示给用户。
- 另：`SettingsModal.tsx:383` 的 catch 兜底 `setTestResult(String(err))` 同为原始透传。

### 🟡 P1-补 3 — 与 `大模型API KEY` 同款的 casing 问题还有一处

`settings.description` = `配置大模型 API KEY、功能选项与系统信息。`（`zh-CN.json:130`）显示在设置弹窗标题下方，应与 `settings.llmApi` 一起统一为「大模型 API 密钥」。此外 `howToGetApiKey` = `如何获取 API Key?` 用了半角问号，与全角标点风格不一致（`zh-CN.json:148`）。

### 🟡 P1-补 4 — 「占位符」程序员术语 + 大括号格式误导

`settings.systemPromptsHint` = `…支持 {targetLanguage} 占位符。`（`zh-CN.json:174`）：

- 「占位符」对非程序员是黑话，建议改为「系统会自动把 {targetLanguage} 替换为上面设置的目标语言」这类行为描述；
- 单大括号 `{targetLanguage}` 与 i18next 的 `{{ }}` 插值格式外观相近，用户容易误写成 `{{targetLanguage}}` 导致替换失效，提示文案应明确区分。

### 🟡 P1-补 5 — 用户可见错误文案中残留 `LLM API` 术语

`llm.error.apiKeyMissing` = `API Key 未配置，请先在设置中配置 LLM API。`（`zh-CN.json:222`）会直接显示在右侧面板对话区。「LLM API」对目标用户是陌生缩写，建议改为「请先在 设置 → 模型设置 中配置 API 密钥」并给出入口指引。

### 🟢 P2-补 6 — 思考 tokens 估算对中文严重失真

`ThinkingIndicator.tsx:23` 用 `reasoningContent.length / 4` 估算 token 数，该系数按英文校准；推理模型的思考内容常含大量中文（中文约 1.5–2 字符/token），显示值可偏差 2 倍以上。既然面向非程序员本就不该暴露 token（报告 P1 已述），若保留则至少不应显示一个看似精确的错误数字。

### 🟢 P2-补 7 — `llmApiHint` 与 label 术语不自洽

`settings.llmApiHint` = `用于翻译、解读与自定义问答的模型接入信息。`（`zh-CN.json:138`）用了「模型接入信息」这种较抽象的说法，而下方字段却是 `API Base URL` / `Model` / `API Key` 英文标签——hint 与字段互相对不上，用户难以建立「接入信息 = 下面三项」的映射。汉化标签后此问题自然消解，可与 P0 一并处理。

---

## 九、复核后修正的整改优先级

**P0（在报告原 P0 基础上扩展）**

1. （原）设置页三标签汉化 + `大模型API KEY` 大小写统一 → 追加 `settings.description`、`wizard` 第 2 步标题一并改。
2. （扩展）错误透传治理分两层：
   - 数据层：补全 `llm.error.*` 9 个缺失 key + 改写 6 个 `{{defaultValue}}` 设置页 key + 去除 `apiError` / `llmApiError` / `requestFailed` / `saveFailed` / `updateError` 中的原始报文插值；
   - 代码层：删除 `errorToMessage`（`llm.ts:203-245`）与 `formatLlmError`（`SettingsModal.tsx:387-414`）的 `defaultValue: err.detail` 回落，原始报错统一 `logger.error` 落日志；两处错误文案合并为一个共享实现（消除向导/设置页不一致的结构性根因）。

**P1**

3. （原）tokens / 日志级别汉化或隐藏 → 追加修正 `ThinkingIndicator` 的中文 token 估算（八-补 6）。
4. （原）缺失文本收编 `zh-CN.json`。
5. （原）关键失败给下一步指引 → 追加「手动检查更新失败」「保存失败」两个场景（八-补 2）。
6. （新）`systemPromptsHint` 占位符文案改写（八-补 4）；`apiKeyMissing` 去 `LLM API` 术语（八-补 5）。

**P2**（维持报告原 6–8 项；窗口控制按钮 tooltip 经核实已存在，从清单移除）

---

## 十、实施状态（2026-07-27，已按第九节完成）

**P0**

1. ✅ 标签汉化：`settings.apiBaseUrl`→「API 地址（接口地址）」、`settings.model`→「模型名称」、`settings.apiKey`→「API 密钥」、`settings.llmApi`/`description`→「大模型 API 密钥」、向导第 2 步标题与 aria-label 同步改为「API 密钥」；`howToGetApiKey` 全角问号。
2. ✅ 错误透传治理：
   - 新建 `src/services/llmError.ts` 的 `llmErrorToMessage()` 作为唯一错误文案入口，`SetupWizard` / `SettingsModal` / `llm.ts` 三处原实现（`describeError` / `formatLlmError` / `errorToMessage`）全部删除并复用；原始报错统一 `warn` 进日志。
   - `llm.error.*` 补全 10 个缺失 key 并全部改为友好中文（不含 `{{detail}}`）；删除 6 个 `{{defaultValue}}` 设置页 key 及死 key `llmApiError` / `apiError`；`requestFailed` / `saveFailed` / `updateError` 去除原始报文插值，`SettingsModal` 的 `String(err)` / `JSON.stringify` 兜底一并移除。
   - 新增 `src/services/llmError.test.ts`（友好文案、不泄漏原文、原文进日志三类断言）。

**P1**

3. ✅ `ThinkingIndicator` 移除 token 估算，只显示「正在深度思考…/思考完成」；`ContextWidget` tooltip 改为「上下文用量：已用 N%」，不再出现 tokens；日志级别选项加中文标注（如 `WARN（警告）`），hint 改为「仅用于排查问题，一般无需修改」。
4. ✅ 缺失文本收编：`wizard.*`（约 30 条 + 平台 tag/blurb）、`thinking.*`、`contextWidget.*`、`settings.thinkingMode/maxToolRounds/runWizard` 等全部进入 `zh-CN.json` / `en.json`，组件内联 defaultValue 相应移除。
5. ✅ 失败指引：手动检查更新失败→「请检查网络连接后重试」（检查/安装分两 key）；保存失败→「请重试，若反复出现请打开日志目录排查」；词典下载失败→「请检查网络连接后重试」（`useDictionaryStatus` 两条原始错误路径均改为友好文案 + 原文进日志）。
6. ✅ `systemPromptsHint` 改写为行为描述并强调单大括号；`apiKeyMissing` 改为「请先前往『设置 → 模型设置』填写」。

**P2**

7. ✅ 快捷键可见化：搜索按钮「搜索（Ctrl/Cmd+F）」、最近文件触发按钮 tooltip 加「（Ctrl/Cmd+Shift+O）」（新 key `recentFiles.triggerHint`）、翻页按钮「上一页（PageUp）/下一页（PageDown）」、缩放 hint 追加「也可 Ctrl+滚轮缩放」。
8. ✅ 并排对照首次轻引导：`App.tsx` 在首次同时打开 ≥2 个 PDF 时显示 `.split-coachmark` 气泡，点「知道了」或 12 秒超时写入 localStorage 不再复现；气泡 `pointer-events:none`，不遮挡 tab 栏与工具栏操作。

**验证**：`type-check` / `lint`（0 error）/ 单元测试 487 全过 / 改动文件 Prettier 全过；E2E 42/44 过，剩余 2 个失败均与本次改动无关（`multi-tab-state` webkit 用例在 HEAD 上同样失败；`pdf-page-jump` 滑轨拖动为既有抖动，重跑 2/3 通过）。`AGENTS.md` 已同步（新增 `llmError.ts` 条目、6.3 错误文案约定、引导气泡说明）。
