# 阶段性 Review 2026-07-24（v0.9.5）

> 范围：前端架构与状态流、性能、LLM / Agent Tools 链路、数据持久化与迁移、UX / 交互一致性、i18n 就绪度、目标用户（检测认证 / 产品研发工程师）友好性，共 7 个维度。
> 方式：静态代码评审，未运行应用复现；所有问题均带 文件:行号 证据。严重程度：严重 / 中等 / 轻微。
> 仅记录问题与建议，本次未修改任何代码。

## 0. 上次评审（2026-07-23）问题闭环情况

- LLM 401 回显 API Key：**已修复**（`llm_proxy.rs:283-287` 用固定文案替代 provider 原始报文，并有测试守护，`llm_proxy.rs:919-930`）。
- Agent loop 轮次间隙无法中断：**已修复**（`usePersistence.ts:746-749, 854-857` 在每轮开始前和每个工具调用前检查 `loopAborted`）。
- ErrorBanner 死代码：组件已删除，但 AGENTS.md 仍列出（文档脱节，见 §1 轻微-12）。

## 1. 跨维度共识：最值得优先处理的 6 个问题

以下问题被多个维度独立发现或互相放大，建议作为本阶段 P0/P1：

1. **「加载失败 → 空数据 → 防抖覆盖写回」链路可静默清空批注（严重）**——`annotations.ts:38-41` 把任何加载失败降级为空数据，`usePersistence.ts:241-253` 照样标记已加载，500ms 防抖保存把空数据原子写覆盖原文件。修复成本低：加载失败不标记 loaded、不触发保存；后端解析失败时先把原文件备份为 `.corrupt-{ts}`。
2. **防抖保存的多个数据丢失窗口（严重）**——500ms 内切 tab / 关 tab / 退出应用，最后一段批注/会话修改不落盘；CommentPopup unmount 只 clearTimeout 不 flush；全项目无退出 flush 钩子；退出也不回写 lastPage。涉及 `usePersistence.ts:314-403`、`App.tsx:496-506`、`CommentPopup.tsx:73-78`。
3. **App 层回调身份不稳定击穿 PdfPage memo（严重）**——`useTabs`/`usePersistence`/`useRightPanelLayout` 每次返回新对象字面量 → App 回调每 render 重建 → 全部 PdfPage 的 memo 失效。与流式无合批叠加后，**每个 SSE chunk 重渲染全部可见 PdfPage + 全量 Markdown re-parse**，是日常流式卡顿主因。涉及 `App.tsx:526,652`、`useTabs.ts:296`、`usePersistence.ts:573-576`、`MarkdownRenderer.tsx:125-150`。
4. **LLM 取消/中断在流停滞时会话永久卡死（严重）**——`onAbort` 只发 cancel 不唤醒 generator 的等待（`llm.ts:126-131`），后端 cancel flag 只在 `stream.next()` 返回后检查（`llm_proxy.rs:653-665`）；SSE 挂起或后端命令 panic 时只能等 300s 总超时兜底，会话一直显示「解读中」。
5. **分屏模式键盘事件双响应（严重）**——每个 PdfViewer 都在 window 注册 keydown 且不判断焦点屏，分屏时 Ctrl+F 两屏同弹搜索条、方向键同滚两文档（`PdfViewer.tsx:452-543`）。直接破坏双屏对照卖点。
6. **未解读暂存片段完全不持久化，重启即丢且无任何提示（严重）**——`shouldSaveAnnotation`（`usePersistence.ts:318-320`）与加载过滤都显式排除未解读 stash。「摘录证据写报告」核心场景下这是无预警数据丢失。持久化与用户友好性两个维度都把它列为最严重问题。

## 2. 前端架构与状态流

总体：架构方向正确，hooks 拆分有纪律（useViewportManager 的 memo 纪律是全项目样板），但 usePersistence 已膨胀为上帝 hook，App 层重复 JSX 与回调稳定性是两个结构性短板。

### 严重

- **usePersistence 是 1351 行的上帝 hook**：annotations 分桶 + stash/sessions 状态 + 两条防抖持久化 effect + agent loop/工具编排 + i18n 工具摘要，至少五个职责（`usePersistence.ts`）。建议拆为 `useAnnotations` / `useStashes` / `useSessionStream`。
- 防抖保存数据丢失窗口、回调身份击穿 memo：见 §1-2、§1-3。

### 中等

- App.tsx 三段近重复 JSX：AiChatPanel（:872/:960/:1003）与 PdfViewer（:798/:838/:916）各复制三次，约 300 行，已出现 drift（主/副 viewer 的 `onStateChange` 不同）。建议提取 `PdfViewerPane` / `AiChatPanelPane`。
- 分屏逻辑下沉不彻底：useSplitView 仅 32 行，分屏 resize（App.tsx:173-276）、drag-over 计数（:278-313）约 140 行留在 App，且与 useRightPanelLayout 的 resize 模式平行重复。
- session 加载 effect 双份复制（`usePersistence.ts:235-272` vs :275-311，90% 相同），应合并为遍历 visible tabs 的单 effect。
- 流式期间 sessions 不落盘（防抖被每个 chunk 重置），进程崩溃丢失已生成内容；diff 用全量 `JSON.stringify` 逐 session 比对（:385），应改脏标记。
- `maxRounds` 兜底值与设置默认值矛盾：代码 `> 0 ? : 5`（`usePersistence.ts:456-457`），`DEFAULT_SETTINGS` 与文档均为 20。

### 轻微

- render 期写 ref（`App.tsx:347-350`），违反项目自己在 PdfViewer.tsx:698-704 注明的 concurrent-mode 规则。
- usePersistence 暴露仅测试消费的 API（`setAnnotations`、`focusedTabStashes`、`handleSessionUpdate` 等）；`abortSessionsForTab` 后两个参数从未使用。
- AGENTS.md 脱节：ErrorBanner 已删除仍列出；ContextWidget 实际已接入（`AiChatPanel.tsx:229`）但文档称半成品；`ToolCallsIndicator.css` 不存在。
- 右栏布局写 localStorage（`useRightPanelLayout.ts:7`），其余设置走后端 AppData，通道不一致。
- CSS 约定小偏离：StashInterpretedPopup 复用 ExplainPopup.css；SettingsModal 跨组件 import CustomInterpretModal.css。

## 3. 性能

总体：渲染管线骨架健康（渲染窗口 ±1 页、离屏位图释放、render task 取消、viewport 按 scale 线性重缩放），但 canvas 无尺寸上限、搜索无缓存、流式无合批是三个系统性短板。

### 严重

- **Canvas 位图无像素/DPR 上限**（`PdfPage.tsx:234-241`，`MAX_SCALE=5.0` 在 `PdfViewer.tsx:239`）：A4 页 @ scale 5 + DPR 2 ≈ 194MB/页，渲染窗口 3 页 ≈ 580MB GPU 位图。建议参照 pdf.js 官方 `maxCanvasPixels = 2^25` 加 outputScale 封顶（约 20 行改动）。
- **流式 chunk 无合批 + Markdown 未 memo**：每个 chunk `setSessions` → 全部历史消息重新跑 react-markdown（gfm/math/katex/sanitize）全管道。建议 onChunk 用 ref 累积 + rAF/50ms flush；`export default memo(MarkdownRenderer)`。预期流式期间主线程负载降 80–95%。
- **搜索无页面文本缓存**（`useSearchDomain.ts:201-254`）：250ms 防抖后对全部页重新 `getPage` + `getTextContent`，结果不缓存。200 页文档敲 10 个字符 ≈ 10 次全量扫描，worker 被独占期间渲染/缩放全部排队。`pdfTools.ts:64-93` 的 `pageTextCache` 是现成可参考模式。
- 回调身份击穿 memo：见 §1-3（修复后流式/滚动时 PdfViewer 子树重渲染从 200 组件降到 0）。

### 中等

- `pdfCacheRef` 无容量上限（`App.tsx:61`），10 tab × 50–100MB PDF ≈ 0.5–1GB 常驻堆内存；叠加 `usePdfDocument.ts:91,101`、`pdfToolsRegistry.ts:79` 三处全量 `slice()` 拷贝。建议加 LRU/字节上限（如 256MB）。
- 大文档 mount 时 viewport 自加载风暴：`useViewportManager.ts:27` 设了 50 页懒加载阈值，但每个 offscreen PdfPage 仍自行 `getPage`（`PdfPage.tsx:172-195`），200 页即并发 200 个调用，无并发上限与优先级调度。
- 每页一个 IntersectionObserver（`PdfPage.tsx:365-378`），200 页 = 200 个 observer，应为滚动容器共享一个。
- 无代码分割，首屏 JS 1.37MB（gzip ~411KB）：pdfjs、react-markdown、KaTeX 全部进首屏。建议 manualChunks + AiChatPanel lazy。
- sessions 持久化深比较成本随会话增大（`usePersistence.ts:383-394`），改脏标记。
- 缩放每步重启 `getTextContent`/`getAnnotations`（`PdfPage.tsx:215-338`），文本 item 坐标与 scale 无关，可缓存 scale=1 的 items。

### 轻微

- 缩放时重建全部搜索高亮坐标（`useSearchDomain.ts:284-302`），O(总匹配数)/步，可接受。
- tab 切换整体卸载重建 viewer（`App.tsx:917` 的 `key={tab.id}`），位图零缓存，频繁切 tab 每页重 raster。
- 滚动防抖上报触发整个 App 重渲染（`useScrollPageSync.ts:170-182`），修好 memo 后影响显著下降。

## 4. LLM / Agent Tools 链路

总体：设计清晰——后端代理化彻底、错误转文本彻底、超限优雅收尾完整、授权在执行时校验、tool_call 累积健壮。薄弱点集中在流式生命周期异常路径与平台兼容性的无条件参数发送。

### 严重

- 取消/中断挂死：见 §1-4。修复方向：`onAbort` 里直接 enqueue done/error 事件唤醒 generator；后端 cancel 检查改为与 `stream.next()` 用 `tokio::select!` 竞争；`None` 分支补 `flush_tool_calls`（流正常结束但无 [DONE]/finish_reason 时，未 flush 的 tool_calls 会被静默丢弃，`llm_proxy.rs:702-710`）。

### 中等

- **ContextWidget 数据源口径错误**：`lastPromptTokens` 被赋值为所有轮次 promptTokens 的累加和（`usePersistence.ts:763-777, 816`），而语义是「最近一次调用」（`sessions.ts:45-46`）。多轮工具调用后上下文用量成倍高估，widget 提前爆红。
- **thinking 参数无条件发送**：`ThinkingMode::Enabled` 时无论平台都发 `thinking:{type:"enabled"}` + `reasoning_effort:"high"`（`llm_proxy.rs:209-217`），OpenAI 官方 API 对未知顶层参数会 400；切到 `supportsThinking=false` 的模型时 UI 只隐藏选择器，settings 残留旧值继续发送（`SettingsModal.tsx:719-724`）。
- **无上下文预算/截断机制**：长会话超 contextWindow 只能等平台 400，`ContextLengthExceeded` 的 limit/requested 硬编码 0，无自动压缩/截断/重试。追问多轮 + 工具结果累积的会话这是必然终局。
- **search_in_pdf 大文档开销无保护**：逐页串行解析（`pdfTools.ts:177-189`），500 页未命中时无进度无超时；`PAGE_TEXT_LIMIT=8000` 截断会漏掉页内 8000 字符后的匹配。
- 300s 总超时对长 reasoning 偏紧：reqwest `.timeout(300s)` 含流式 body 总时长（`llm_proxy.rs:607-610`），深度思考模型单轮超 5 分钟会被强制中断为 Network 错误。

### 轻微

- SSE 只认 `data: ` 带空格前缀，`data:{...}` 被当 keep-alive 跳过（`llm_proxy.rs:385-391`）。
- RateLimit 不解析 Retry-After，整链路无重试。
- `reasoning_content` 全平台回放未做平台区分（`llm_proxy.rs:180-182`），对 OpenAI 系是多余字段。
- AGENTS.md 写 8 个平台，实际 9 个（新增 `xiaomimimo`，`platformPresets.ts:14-23,112-133`）。
- 无 id 的 tool_call 被静默丢弃（`llm_proxy.rs:359-361`）。
- `toolsSystemAddendum` 未引导先调 `list_open_pdfs` 获取 file_hash（`zh-CN.json:215`），弱模型可能编造 hash。
- `StreamParams.authorized_file_hashes` 为长期悬空的保留字段（`llm_proxy.rs:121-122`），要么启用要么删除。
- `maxToolRounds` 注释（0 = 默认 20）与代码 fallback（5）不一致。

## 5. 数据持久化与迁移

总体：后端工程质量高——原子写 + per-file 锁、serde 兼容策略执行一致、测试覆盖扎实、词典下载状态机完整（断点续传/防 zip 炸弹/zip-slip 免疫/魔数定位）。薄弱点集中在前端。

### 严重

- 「加载失败 → 空数据 → 覆盖写回」：见 §1-1。
- 退出无 flush、关 tab 丢最后 500ms 修改：见 §1-2。

### 中等

- **持久化的 `isStreaming: true` 陈旧状态重启后无法自愈**：流式中退出后，会话/批注的 streaming 标记落盘；重启加载后无任何代码复位，AI 面板输入框被 `disabled={activeSession.isStreaming}` 永久禁用（`AiChatPanel.tsx:298`）。加载时一律复位为 false 即可。
- **加载单会话失败 → 引用被静默丢弃**：`loadSession` 失败返回 null 被过滤（`usePersistence.ts:262-265`），下次保存时失败会话 id 从 annotations 文件消失，磁盘会话文件成永久孤儿。
- **钥匙串不可用导致全部设置「假重置」**：`storage.retrieve` 出错使整个 `load_settings` 失败（`lib.rs:880`），前端回落 DEFAULT_SETTINGS（`settings.ts:149-152`），用户此时点保存就真覆盖。检索 key 失败应与加载设置解耦。
- **旧目录迁移无部分失败恢复**：`copy_dir_all` 中途失败则新目录部分拷贝且永不重试（`paths.rs:50-69`）；迁移成功后旧 `photonee/SpecReader` 不删除，`ecdict.sqlite`（~700MB）双份占盘。建议先拷到 `.migrating` 临时目录再 rename。
- 后端无词典并发下载保护（`dictionary.rs:182-491` 无 in-flight 锁），两次并发调用会交错写同一 `.tmp`。
- macOS 无单实例插件（`lib.rs:159` 仅 windows/linux），双实例打开同一 PDF 时 `save_pdf_data` 整文件 last-write-wins 互相覆盖。

### 轻微

- TS `Annotation.fileHash` 在 Rust 端无对应字段，保存时被静默丢弃；TS `InterpretationSession` 缺 Rust 已有的 `frozen`/`frozenReason`——两端类型不同步，违反 AGENTS.md §10.2 约定。
- 原子写无 fsync，崩溃后 `.tmp` 残留不清理。
- PDF 打开期间被外部修改会导致批注「换家」（保存时按当前磁盘文件实时算 hash），无检测/提示。
- 旧单条目 keyring 迁移只覆盖 deepseek/openai（`secure_storage.rs:51`），其他平台旧条目成孤儿。
- 脱敏覆盖面有限：`redactSensitiveInfo` 只匹配 `sk-` 前缀；JWT、`gsk_`/`xai-` 等格式、URL query token 不脱敏；后端 Rust 日志不经前端脱敏。
- 无会话文件 GC：sessionId 从 annotations 移除后磁盘会话文件永久残留。

## 6. UX / 交互一致性

总体：底层机制扎实（clamp 定位、useDrag、最近文件键盘导航是范本级实现），但 Esc/关闭/删除三套语义在各浮层间互不统一，属于「机制好、规范散」。

### 严重

- 分屏键盘双响应：见 §1-5。顺带修 Ctrl+F 劫持：`isTyping` 判断在修饰键拦截之后（`PdfViewer.tsx:456-462`），模态框内按 Ctrl+F 会被底层搜索条偷走焦点。
- **删除保护因入口不同而不一致，「X」图标语义欺骗**：`handleAnnotationDelete` 只对 explain/已解读暂存弹确认（`usePersistence.ts:1266-1271`）；翻译、批注、普通暂存零确认直接永久删除。TranslatePopup 的 X 按钮 aria-label 是「删除」但图标是通用 close（`TranslatePopup.tsx:161-168`），用户按「关闭浮层」心智点 X 直接丢整段译文。CommentPopup 同理。
- **SelectionToolbar 无边界 clamp**：`position:fixed` + `translate(-50%,-100%)` 定位（`SelectionToolbar.tsx:84-94`），选区贴顶/贴边时工具条飞出视口——而它是暂存/解读/翻译的唯一入口，核心闭环在常见场景下不可达。也不响应 Esc、不跟随滚动/缩放。

### 中等

- Esc/点击外部关闭矩阵混乱：四类批注浮层既无 Esc 也无点击外部关闭；SetupWizard 完全没用 `useModal`；词典下载确认弹窗没用 `useModal`，按 Esc 会把父级 SettingsModal 一起关掉（`SettingsModal.tsx:1130-1157` + `useModal.ts:29-35`）。
- 设置弹窗未保存修改静默丢弃：Esc/X/取消直接丢，无 dirty 检查；「重置全部」无确认（`SettingsModal.tsx:287,483-487,1115-1117`）。
- 浮层能力不统一：Translate/Comment 可拖动，Explain/StashInterpreted 不可拖却同样遮挡原文；「隐藏」语义分裂（翻译写 `hidden:true` 可 toggle，批注只关 React 状态）。
- 暂存区单条删除/清空零确认（`AiChatPanel.tsx:383-390,456`），与最近文件的两段式形成鲜明不一致，且级联删 PDF 标记。
- 解读记录列表无删除入口：自定义解读产生的会话只能从 PDF 星标浮层删除，PDF 未打开时永久滞留。
- 失败态缺恢复路径：PDF 加载失败只显示硬编码英文 `Failed to load PDF: ${err}`（`usePdfDocument.ts:118`），无重试无中文；翻译流失败无重试按钮。
- 键盘覆盖硬伤：tab 栏 `div onClick` 不可聚焦、无 Ctrl+Tab/Ctrl+W；两个 Indicator 用 `span role="button"` 无 keydown；无 Ctrl+=/Ctrl+- 缩放快捷键；**流式时 Enter = 中止生成**（`AiChatPanel.tsx:558-567`），用户起草下一条追问时极易误杀生成。

### 轻微

- 搜索条 Esc（保留 query）与 X（清空）行为不一致。
- 大纲空标题硬编码英文 `(Untitled)`（`PdfViewer.tsx:1306`）；SetupWizard 大量硬编码中文不走 i18n。
- 按钮样式四套并行（icon-btn / translate-popup-actions / explain-popup-footer / modal-actions / selection-toolbar）。
- 「复制」无成功反馈；drop-zone 遮罩对任意 dragenter（含 OS 拖文件）都显示但 drop 只认 tab id；快捷键不可发现（title 未标注）。
- 深度缩小时浮层宽于页面（clamp 退化区间放弃，`popupPosition.ts:23-27`）；批注 marker 键盘不可达；星形「已解读暂存」图标无语义图例。

## 7. i18n 就绪度

总体：骨架好——211 个 key 在 zh-CN/en 完全一致、占位符零偏差、en.json 人工翻译水准、主阅读界面 100% 走 t()。但约 60 个 key 只存在于代码 defaultValue 里，后端直接向 UI 输送硬编码中文，零复数形式。切英文 UI 会有大面积中文残留。

### 严重

- **约 60 个 key 未落 locale 文件**：`wizard.*` 整族约 40 个（`SetupWizard.tsx:81-82` 的 `w()` helper 内联 defaultValue）；`settings.*` 约 22 个（platform/testConnection*/error*/thinkingMode/maxToolRounds/runWizard 等）；`llm.error.*` 8 个（`llm.ts:177-219`）；`thinking.*` 4 个；`contextWidget.tooltip`。
- **SetupWizard 11 条文案完全没走 t()**：`PLATFORM_BLURB`（:27-36）、`platformTag`（:40-46）、`placeholder="中文"`（:442）。
- **Rust 后端直供硬编码中文**：`llm_proxy.rs:286/290/306/327/585/594/624-628/697/802-804` 的错误 detail、`dictionary.rs:172-451` 共 12+ 条进度/错误文案，前端原样展示（`SettingsModal.tsx:451-453` 优先显示后端 message）。

### 中等

- 启动自动更新弹窗硬编码中文（`updater.ts:22-23`），而设置页手动检查走了 i18n，两条路径不一致。
- 默认 system prompt 三处重复（`settings.ts:48-53`、`lib.rs:557-558`、locale 的 `settings.defaultPrompts.*` 死 key），已出现漂移风险；`lib.rs:614` 硬编码默认 `target_language: "中文"`。
- 缺语言切换基础设施：无 `uiLanguage` 设置字段、无语言检测、无 missing-key 处理（缺失 key 静默回落中文，问题不可见）。
- 后端错误策略不统一：`lib.rs` 命令错误全英文、`llm_proxy.rs`/`dictionary.rs` 中文，前端有的映射 key 有的原样显示，无 error-code → i18n-key 契约。

### 轻微

- 零复数形式：`en.json` 的 "1 min ago"、"1 document locations" 语法错误。
- `toLocaleDateString()` 未传 locale，跟随系统而非 i18n lng。
- 约 10 个死 key（`tools.status.*`、`stash.expand/collapse`、`settings.defaultPrompts.*` 等）；`ToolCallsIndicator.tsx:47-48` 的 defaultValue 与 locale 值漂移。
- UI 语言文本被持久化进会话 JSON（工具摘要、`[错误]` 前缀），追问时原样回放；`usePersistence.ts:883` 用「重新生成的 summary 字符串相等」做匹配，语言切换后会失效。

### 开放英文 UI 的最短路径

补齐 60 个 defaultValue key 到两份 locale（删除代码内 defaultValue）→ SetupWizard 硬编码迁入 locale → 后端错误改「代码 + 前端映射」（`LlmError.kind` 枚举已现成）→ `AppSettings` 加 `uiLanguage` + 设置页语言下拉 → 补复数。约 80 处编辑，无架构改动。

## 8. 目标用户友好性（检测认证 / 产品研发工程师）

总体：开箱引导和数据架构超出预期（向导接近消费级软件水平、错误已结构化分类、hash 持久化 + 原子写），但「摘录证据写报告」核心工作流有两处硬伤，部分高频异常提示仍是开发者视角。「demo 很顺滑，深水区会踩坑」。

### 严重

- 未解读暂存不持久化：见 §1-6。
- **保存设置失败完全静默**：`handleSaveSettings` 的 catch 只写日志（`App.tsx:402-410`），而后端钥匙串不可用时明确拒绝保存——用户点「保存」无报错无提示，重启后配置丢失。Linux 无 Secret Service / macOS Keychain 锁定场景必现。
- **PDF 打开失败提示为原始英文异常**（`usePdfDocument.ts:118` → `PdfViewer.tsx:904-907`）：加密 PDF 得到 `PasswordException`、损坏文件得到内部解析错误，用户无法区分「加密了/坏了/不在那了」，加密 PDF 完全无引导。

### 中等

- **AI 产出没有复制/导出口，报告工作流断在最后一步**：解读消息、翻译浮层、暂存片段均无复制按钮；无批量复制；会话无导出 Markdown。PRD 7.3 的「来源 pill 可点击」也未实现。
- **LLM 错误文案 i18n 缺失导致中英文混杂**：`llm.error.*` 8 个 key 缺失（见 §7），rateLimit/serverError 的 detail 是 provider 原始英文报文，`unknown` 类把原始响应 body 拼进 UI。向导里的错误文案反而最完善——三处实现不统一，应收敛为单一错误格式化函数。
- 翻译失败无重试路径（`TranslatePopup.tsx:105-108`），唯一出路是删掉重选；`[错误]` 文本写进 `message.content` 会随历史回传污染上下文（`usePersistence.ts:603-614`）。
- **AI 引用页码不可点击**：工具引导要求模型以「（第 N 页）」引用来源，但输出纯文本无法点击核对，「来源可追溯」只有一半实现。对需要向审核员负责的工程师，可信度闭环未成立。
- 文件移动后缺「重新定位」引导：数据按 hash 存储（移动后批注仍在，很好的设计）但用户无从知道，置灰条目无重新定位入口。
- 批注/解读数据无用户可见的备份/导出：换机重装即丢，annotations 目录无打开入口。
- 首启无隐私告知：PRD 9.3 明确要求「首次启动明确告知数据处理方式」，向导只字未提「选中文本会发送给第三方 LLM」——标准文件常涉客户保密项目，敏感度高。

### 轻微

- 工具调用明细展示英文工具名 `read_pdf_page`；向导第 3 步测试失败则「开始使用」禁用（其实 Key 已保存，可允许稍后排查）；词典下载失败直接显示后端原始错误；`SettingsModal.tsx:353,381` 保存失败直接 `String(err)` 展示。

### PRD 未实现项优先级建议（站在目标用户角度）

1. **引用追踪（Clause 跳转）最高**：标准里 "see Clause 5.2.3" 每页数次，手动翻页是心流第一杀手；可大幅复用 `useSearchDomain` 的跨 text item 匹配 + 跳页，识别引用文本 + 全文搜索跳转即可拿 80% 收益。
2. **术语表第二**：悬停取词覆盖单词级，但领域术语/缩写（EUT、EMC）通用 ECDICT 给不出。
3. **表格截图多模态第三**：限值表是精确数据场景，但需要视觉模型配置，受众收窄。
4. **测试清单生成第四（战略价值最高）**：离最终交付物最近，但正确性依赖 Clause 索引，漏一条 shall 就是漏一个测试项，建议引用追踪落地后再启动。

## 9. 建议的修复批次

**P0（数据安全 + 核心闭环，均低成本）**
1. 阻断「加载失败覆盖写回」（§1-1）+ 后端损坏文件备份。
2. 退出/关 tab flush + CommentPopup unmount 提交 + 退出回写 lastPage（§1-2）。
3. LLM 取消挂死修复 + `None` 分支补 flush_tool_calls（§1-4）。
4. 暂存片段持久化（或至少 UI 明示不持久）（§1-6）。
5. 保存设置失败弹提示（§8）。

**P1（日常体验）**
6. useTabs/usePersistence/useRightPanelLayout 返回值 useMemo + App 回调依赖稳定字段（§1-3）；流式合批 + MarkdownRenderer memo（§3）。
7. canvas outputScale 上限（§3）。
8. 分屏键盘双响应 + Ctrl+F 劫持（§1-5）。
9. 删除规范统一（X=关闭、trash=删除、translate/comment 接确认流）；SelectionToolbar clamp + Esc（§6）。
10. 搜索文本缓存（§3）；isStreaming 陈旧状态自愈（§5）；ContextWidget 口径修正 + thinking 参数门控（§4）。

**P2（规范与收口）**
11. i18n：60 个 defaultValue 落盘、SetupWizard 硬编码清零、后端错误改代码+前端映射（§7）。
12. AI 结果复制/批量复制/导出 Markdown；错误文案收敛为单一格式化函数；翻译重试；引用页码可点击（§8）。
13. usePersistence 拆分、App 三段 JSX 提取、分屏逻辑下沉（§2）。
14. 设置加载与钥匙串解耦、旧目录迁移加固、词典并发保护（§5）。
15. pdfCacheRef LRU、共享 IntersectionObserver、Vite 分包（§3）。
16. AGENTS.md 同步（ErrorBanner/ContextWidget/平台数/ToolCallsIndicator.css）（§2/§4）。
