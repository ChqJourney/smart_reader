# 代码审查报告（2026-08-16）

范围：后端 Rust 代码逻辑漏洞 + 前端代码功能缺陷。不含代码风格问题。
每条发现附文件：行号、触发场景与修复建议。严重级别：高 / 中 / 低。

---

## 高严重级别

### H1. 流式中止发生在空闲期 → agent loop 永久挂起、PDF 文档句柄泄漏

- 位置：`src/services/llm.ts:132-178`、`src/hooks/useStreaming.ts:56-88`，挂起后果在 `src/hooks/usePersistence.ts:944-1123`
- 问题：`streamChatCompletion` 在事件队列空时阻塞在 `resolveWait`（llm.ts:174）。用户中止时 `onAbort`（llm.ts:143-148）只调 `markFinished()` 唤醒 generator，while 循环条件不再满足就直接 return，**不再 yield 任何事件**。而 `useStreaming.run` 里 `handlers.onAbort` 的调用点在 for-await 循环体内部（useStreaming.ts:60-63），只有收到事件才执行；generator 正常结束时只检查 `onDone`（:86-88，aborted 时跳过）。于是 abort 发生在「两次 chunk 之间」（流的绝大多数时间处于此状态）时，`onAbort`/`onDone` 都不触发。
- 后果链：`usePersistence.runOneRound` 的 Promise（:661）永不 settle → `runAgentLoop` 永远停在 `await runOneRound`（:959）→ `finally`（:1119-1122）不执行：`toolSession.dispose()` 不调用（tools 会话中已加载的 `PDFDocumentProxy` 常驻内存，反复中止反复泄漏）、`agentLoopAbortRef` 条目泄漏、累计 usage 不落状态。UI 上 `handleInterruptSession` 手动清了 `isStreaming` 所以用户无感知，纯粹是静默泄漏。
- 佐证：`usePersistence.test.tsx:226` 与 `:1883` 的 abort 测试 mock 的 generator 在 abort 后仍会 `yield` 一个事件，恰好掩盖了真实 generator 的空闲退出路径。
- 修复：`useStreaming.run` 在 for-await 结束后补 `else if (controller.signal.aborted) handlers.onAbort?.()`；或在 llm.ts 的 `onAbort` 里 enqueue 一个显式终止事件让消费者走循环体。

### H2. 工具执行中途 abort 留下悬空 toolCalls，该会话后续追问必然 400

- 位置：`src/hooks/usePersistence.ts:1058-1075`
- 问题：`for (const call of toolCalls)` 只在**每个 call 执行前**检查 `loopAborted`（:1059）。若一轮返回多个 toolCalls（c1, c2），abort 发生在 c1 的 `await executeToolCall` 期间：c1 完成后照常落 tool 结果，轮到 c2 时直接 `finishStreaming(); return`——c2 永不执行、**没有对应 tool 消息**。持久化的会话里 assistant 消息带 `toolCalls: [c1, c2]` 但只有 c1 的响应。
- 触发场景：追问时 `buildApiMessages`（:593-606）原样回放，assistant(toolCalls) 后缺 tool 响应，OpenAI 兼容 API 的消息序列校验直接拒绝（400），该会话此后所有追问都失败，且用户无从修复。
- 修复：abort 收尾时为未执行的 toolCalls 补写 "已取消" 的 tool 结果消息；另建议 `buildApiMessages` 做防御——剔除没有匹配 tool 响应的 toolCall（或合成占位 tool 消息），对历史已污染数据也能自愈。

### H3. 翻译浮层流式中卸载 → `isStreaming` 永久卡死，翻译残废

- 位置：`src/components/TranslatePopup.tsx:116-119`（unmount cleanup 只保存 `content`，不写 `isStreaming:false`）+ `src/components/PdfAnnotations.tsx:73-74`（translate marker 点击直接切 `hidden`，无流式守卫）
- 问题：流式翻译进行中浮层被卸载时，cleanup 调用 `abortStream` + 保存已累计的部分内容，但 annotation 上的 `isStreaming` 保持 `true` 并随后被防抖保存落盘。重新挂载时挂载 effect 的守卫 `if (!isStreaming || annotation.content) return`（第 77 行）因已有部分内容而拒绝重启流，同步 effect（128-131 行）又把 `isStreaming=true` 读回——浮层永远显示"翻译中"转圈，且防抖 effect 会持续把 `isStreaming:true` 写回，无任何自愈路径（仅"一个 chunk 都没收到过"的情况才因 content 为空而重启）。
- 触发场景：① 翻译流式中点击 marker 隐藏浮层；② 单页模式下翻页（PdfViewer 单页模式只挂一个 PdfPage，翻页即卸载旧页浮层）；③ 流式中 tab 被休眠顶掉（viewer 整体卸载）。
- 修复：cleanup 中改为 `onUpdateRef.current({ content: accumulatedRef.current, isStreaming: false })`；或 PdfAnnotations 在流式中禁止隐藏；加载端兜底：`loadPdfData` 后对 `type==="translate" && isStreaming` 的脏数据重置。

### H4. `planWake` 的 "secondary" 分支丢失对当前 active tab 的保护，可休眠正在显示的 tab

- 位置：`src/hooks/useTabs.ts:114-119`；放大因素：`src/App.tsx:1268-1297`（split 分支渲染不检查 `hibernated`）、`src/App.tsx:1434-1439`（keep-alive 树检查）
- 问题：`planWake(tabs, tabId, "secondary", ...)` 传给 `selectHibernateCandidates` 的 `activeTabId` 是 **`null`**（useTabs.ts:115），secondary 槽位给了被唤醒 tab。于是**当前正在主屏显示的 active tab 不受直接保护**，只剩 5 分钟窗口兜底。`wakeTab`（拖 tab 进分屏、App.tsx:557/596/807）和 `gotoTabPage(activate=false)`（分屏下跳副屏，App.tsx:1024/1064）都走这条路。
- 触发场景：macOS 上读一个 300MB 文档超过 5 分钟（`lastActivatedAt` 已出窗口），另有几个小文件隐藏 tab；此时把一个休眠 tab 拖入分屏 → 预算超限，LRU 休眠完小 tab 仍超限 → **active tab 被选中休眠**。后果链：tab 记录 `hibernated=true`，但 split 分支不检查该标记，viewer 仍挂载（内存账算错）；字节缓存被 App.tsx:157-166 的驱逐 effect 删除；**退出分屏后 keep-alive 树对 active tab 渲染 `HibernatedPlaceholder`，主阅读区空白**，需再点一次 tab 才冷启动恢复。
- 修复：`planWake` 增加「当前真实 activeTabId」参数并始终加入保护集（`protectedIds` = {真实 active, 真实 secondary, 被唤醒 tab}），而不是仅在 `protectAs==="active"` 时用目标 tab 顶替。

### H5. 快速连续两次 `goToPage`：旧跳转的残留监听器上报过期页码，污染 tab 记录

- 位置：`src/components/PdfViewer.tsx:736-799`
- 问题：`goToPage` 每次都新建 `handleScroll` 监听 + 150ms/300ms 定时器，最后把 `cleanup` 写入 `jumpScrollCleanupRef.current`（798 行）——**覆盖前没有执行上一个 cleanup**。旧跳转的 `handleScroll` 仍挂在 container 上：
  - 第二次跳转（或用户滚动）触发的 scroll 事件会喂给旧 `handleScroll`，150ms 后旧闭包执行 `reportFinalState`，把**第一次跳转的目标页** `page`（闭包捕获）配上**当前的 scrollTop** 上报给 App（769-783 行）；
  - 旧闭包同时提前执行 `isJumpingRef.current = false`，削掉第二次跳转的保护窗口。
- 触发场景：300ms 内连续点两个批注/暂存/大纲跳转（或跳转后立刻滚动）。后果不止是记录错位——App 侧 tab 记录的 `pageNum` 被写成旧页，而激活 tab 时会把记录页作为 `pendingGotoPage` 带回；`useTabRestore` 的「同页 pending 直接清除」规则（`useTabRestore.ts:177`）因此对不上，**切回该 tab 时会被拉回旧页**。
- 修复：`goToPage` 开头先执行 `jumpScrollCleanupRef.current?.()` 再注册新监听；或在 `reportFinalState` 里读 `pageNumRef.current` 而非闭包里的 `page`。

---

## 中严重级别 — 后端

### M-B1. 旧目录迁移非事务性，部分失败后永不重试

- 位置：`src-tauri/src/paths.rs:57-68`（`copy_dir_all` 在 paths.rs:9-39）
- 问题：`app_data_dir` 只在 `!dir.exists()` 时迁移，而 `copy_dir_all` 第一步就 `create_dir_all(dst)`。一旦拷贝中途失败（`?` 直接传播）：新目录已被创建（部分文件已拷入）；下次启动 `dir.exists()` 为真 → **迁移分支永远不再进入**；用户的批注/会话/设置仍躺在旧目录里，表现为「数据静默丢失」。
- 一个具体的高概率失败源：`entry.file_type()` 对符号链接返回 symlink 类型，`ty.is_dir()` 为 false 走到 `std::fs::copy`（paths.rs:27-28），而 `fs::copy` **跟随符号链接**——若旧目录里存在指向目录的 symlink，`fs::copy` 报 "Is a directory"，整个迁移立即中止，落入上面的永久半迁移状态。
- 修复：迁移先拷到 `SpecReader.migrating-{ts}` 临时目录，全部成功后 rename 为正式目录；或迁移成功后写 marker 文件，以 marker 而非 `dir.exists()` 判定是否已迁移。对 symlink 条目显式跳过或按链接复制（`symlink_metadata` 判断）。

### M-B2. `atomic_write` 的 tmp 文件名存在跨文件碰撞

- 位置：`src-tauri/src/lib.rs:974`（`let tmp_path = path.with_extension("tmp");`）
- 问题：写锁按**目标路径**分键（lib.rs:951-960），但 tmp 名只按 stem。同目录下两个 stem 相同、扩展名不同的目标（例如用户先后导出 `报告.md` 与 `报告.pdf` 到同一文件夹，`export_text_file` / `export_binary_file` 都会走 `atomic_write`）会共享同一个 `报告.tmp`，两把不同的锁、并发执行时：A 写 `报告.tmp`（md 内容）→ B 写 `报告.tmp`（pdf 内容）→ A rename → `报告.md` **装进了 PDF 字节**。应用内建文件（hash 做文件名）stem 天然互不相同不会触发；仅用户自选导出路径可能踩中。
- 附带：① 崩溃残留 `.tmp` 文件无清理（低，仅堆积）；② tmp 写入后未 `sync_all()`，rename 保证原子性但不保证持久性——掉电后可能拿到旧内容甚至空文件，建议 rename 前对 tmp fsync。
- 修复：tmp 名加入目标扩展名与随机/进程唯一后缀，如 `{filename}.{ext}.{pid}-{counter}.tmp`。

### M-B3. PDF hash 缓存的 TOCTOU 与 mtime 粒度导致脏缓存

- 位置：`src-tauri/src/lib.rs:459-491, 497-518`
- 问题：
  - `warm_pdf_hash_cache`（lib.rs:504-518）在 `read_pdf_bytes` **读完字节之后**才 stat 元数据。若文件在读取期间被替换，缓存里存的是「旧字节的 hash + 新文件的 mtime/size」——之后 `get_pdf_hash` 元数据校验命中，永久返回与新内容不符的 hash。
  - `compute_pdf_hash_cached` 只靠 `mtime + size` 判脏（lib.rs:474）。FAT32/部分网络盘 mtime 粒度 2 秒，同尺寸快速改写（编辑器覆盖保存常见）会命中旧 hash；`metadata.modified()` 失败时回退 `UNIX_EPOCH`（lib.rs:466），等于对该文件永久信任缓存。
- 后果不是崩溃而是**批注键错位**：批注按 hash 持久化，脏 hash 会让批注写到错误的 `{hash}.json`，或加载到别的文件的批注。概率低但后果隐蔽。
- 修复：stat 应在读字节**之前**取，读后复核一次（不一致则放弃预热）；对 `modified()` 失败的文件不写入缓存。

### M-B4. LLM 300s 总超时覆盖整个流式 body，长输出会被腰斩

- 位置：`src-tauri/src/llm_proxy.rs:607-609`
- 问题：`reqwest::Client::builder().timeout(300s)` 在 reqwest 中是**从发起到 response body 读完**的总超时，不是连接超时。思考型模型（DeepSeek thinking 开启 + `reasoning_effort: high`）一次长解读的流式生成很容易超过 5 分钟，超时后流被强制中断，用户只看到笼统的「网络/超时」错误，已生成的部分内容经 `Some(Err(e))` 路径（llm_proxy.rs:738）以 Network 错误收尾。
- 触发场景：thinking 模式下的长解读 / 自定义解读多片段，生成时间 > 300s。
- 修复：去掉总超时或大幅放宽（如 30 分钟），保留逐 chunk 的读超时思路（dictionary.rs 的 `CHUNK_READ_TIMEOUT` 模式）；连接建立可用 `connect_timeout` 单独限制。

### M-B5. 前端断开后 LLM 流仍跑到底，token/流量被浪费

- 位置：`src-tauri/src/llm_proxy.rs:362, 406, 434, 452, 460, 697, 734, 739, 756`（所有 `let _ = on_event.send(...)`）
- 问题：Channel `send` 的 `Err` 全部被吞掉。webview 刷新/关闭/前端主动放弃后，receiver 已 drop，`send` 会持续失败，但后端毫无感知，继续把整条流（含计费 token）跑完，`cancel_tokens` 条目也要等流自然结束才清。
- 触发场景：流式过程中 webview 崩溃重载、前端侧提前 drop channel。
- 修复：在 `parse_sse_line` / `pump_sse_stream` 中检测 `send` 返回 `Err`，直接终止循环并走 cleanup。

### M-B6. 钥匙串旧 key 迁移：先删旧条目但不确认新条目写入成功，可能永久丢 key

- 位置：`src-tauri/src/secure_storage.rs:55-58`
- 问题：迁移顺序为 `self.store(platform_id, &password)`（结果 `let _ =` 忽略）→ `legacy_entry.delete_credential()`（同样忽略）。若 `store` 失败（钥匙串瞬时不可用、写入被拒）而 `delete` 成功，旧条目已删、新条目没写入，**用户 API Key 静默丢失**。
- 附带：迁移白名单只覆盖 `deepseek` / `openai`（secure_storage.rs:51）。若旧版本用户配置的是 kimi/bailian 等平台，升级后 key 取不到（**需确认旧版本是否只允许这两个平台**——若是则非问题）。
- 修复：`store` 成功后才 `delete_credential`；`store` 失败则保留旧条目并照样返回 key（下次再迁移）。迁移逻辑可不区分 platform_id，任何平台 retrieve 未命中时都尝试迁移旧条目。

### M-B7. 防 zip 炸弹的大小校验在写盘完成之后；断点续传不校验 Content-Range

- 位置：`src-tauri/src/dictionary.rs:520-527`、`281-304`
- 问题：
  - `std::io::copy` 会把整条目全部写入磁盘后才比较 `copied > MAX_DICT_EXTRACT_BYTES`。恶意/损坏的 zip 若含 10GB 条目，会先真实写入 10GB（可能撑满磁盘）才被拒绝，上限校验形同虚设。
  - 断点续传只判断 `status == 206` 就 `seek(start_from)` 追加写，不解析 `Content-Range` 起点；中间盒重写时会错位拼接（后续 SQLite 校验兜底失败，用户要重下整包）。另：两个 sha256 校验常量目前都为空串（dictionary.rs:32, 37），完整性校验实际未启用。
- 修复：`std::io::copy(&mut file.take(MAX_DICT_EXTRACT_BYTES + 1), &mut out)` 在读取侧限量；206 时解析 `Content-Range: bytes {start}-...`，与 `start_from` 不符则回退从头下载（`set_len(0)`）；尽快填入 sha256 常量。

### M-B8. 打印临时文件的清理与打开存在竞态

- 位置：`src-tauri/src/lib.rs:402-421, 423-432`
- 问题：`write_print_temp_file` 先删除目录内全部 `*.pdf` 再写新文件，随后 `open -a Preview` 是**异步 spawn**（不等待）。用户快速连续打印两次时，第二次调用会删掉 Preview 尚未读完的第一个文件，第一次打印可能失败或打开空白。另外文件名只用毫秒时间戳，同毫秒内两次打印互相覆盖。
- 修复：清理策略改为「删除除本次目标外的旧文件」且延迟到下次启动时做，或文件名加纳秒/随机后缀并只清理 N 分钟前的文件。

### M-B9. `authorize_pdf_path` 对 webview 完全信任（威胁模型记录项）

- 位置：`src-tauri/src/lib.rs:326-335`
- 问题：该命令只做扩展名检查就把任意路径加入白名单。webview 内任何注入 JS 都可以先 `authorize_pdf_path` 再 `read_pdf_bytes` 读取全盘任意 `*.pdf`。威胁模型若只防「webview 误触任意文件读」则现状可接受，但白名单对恶意脚本零防御。**设计意图需确认。**
- 缓解方向：授权时要求路径存在于系统对话框插件最近返回值中，或后端自己弹确认框。

---

## 中严重级别 — 前端

### M-F1. `savePdfData`/`saveSession` 吞掉写盘错误，「失败保留脏标记重试」机制实为失效

- 位置：`src/services/annotations.ts:46-56`、`src/services/sessions.ts:240-248`，对照 `src/hooks/usePersistence.ts:319-331`、`:345-352`
- 问题：两个 service 都 catch 后只记日志不抛出。于是 `persistDirtyHashes` 里 `await savePdfData` 永不 reject，写盘失败照样执行 `dirtyHashesRef.current.delete`（:325，注释声称"保存成功才清脏标记"）；`persistChangedSessions` 里 `savedSessionsRef.current[session.id] = session`（:348）永远执行，外层 try/catch 是死代码。写盘失败（磁盘满、瞬时 IO 错误）后不再重试，静默丢数据。加载侧 `loadPdfData` 是抛出的（annotations.ts:38-43 注释还专门论证了为什么必须抛），保存侧不对称。
- 修复：service 层 rethrow（或返回 boolean 成功标志），让调用方重试语义真正生效；连续失败时给用户一条非阻断提示（toast）。

### M-F2. `handleAnnotationDelete` 删除进行中会话但不中止其流

- 位置：`src/hooks/usePersistence.ts:1463-1499`（对照 `handleDeleteSession` :1514-1516 是有 interrupt 的）
- 问题：删除 explain/已解读暂存标记时连带删会话，但不调用 `handleInterruptSession`。解读生成中删标记 → 会话从 state 与磁盘删除，LLM 流继续在后台跑完（白烧 token），收尾还会触发 `maybeGenerateSummary` 再发一次无用请求。
- 修复：删除前若 `session.streamingMessageId` 存在则先 `handleInterruptSession(sessionId)`。

### M-F3. `agentLoopAbortRef` 按 `session.id` 注册，旧 loop 收尾会误伤新 loop；hook 层无防并发

- 位置：`src/hooks/usePersistence.ts:567-569`（set）、`:888-901`（finishStreaming 无条件清 streamingMessageId）、`:1120`（finally delete）；`handleFollowUp` :1399-1421 无 `isStreaming` 防御
- 问题：H1 修复后此竞态会显现——同一 session 中止后立即追问，旧 loop 迟到的 `finishStreaming()` 会把新一轮（不同 messageId）的 `isStreaming/streamingMessageId` 抹掉，旧 loop 的 `finally` 还会 `delete(session.id)` 删掉新 loop 的 abort 回调。当前靠 UI 的 `sendDisabled`（AiChatPanel.tsx:593）挡正常路径，hook 层裸调用可绕过。
- 修复：abort 回调改按 messageId 作 key；`finishStreaming` 仅在 `streamingMessageId === messageId` 时清除。

### M-F4. 批量拖放打开时并发 `addTab` 各自持过期 `tabs` 快照，预算整体超支且不触发休眠

- 位置：`src/hooks/useFileDrop.ts:91-97`（`for` 循环内 `void openPdfByPathRef.current(path)`，不 await）；`src/hooks/useTabs.ts:240-351`（`addTab` 闭包捕获 `tabs`）
- 问题：一次拖入 N 个 PDF 时 N 个 `addTab` 并发执行，每个都用**同一渲染拍的 `tabs`** 做预算预测（useTabs.ts:291）和 hash 去重（useTabs.ts:282）：彼此看不见对方即将新增的文件 → 每个都认为预算够用 → 不休眠任何人；`setTabs` 是函数式更新所以 tab 都能落下，但**超预算状态此后无任何机制纠正**（addTab 是唯一预算触发点）。同内容不同路径的文件并发打开时 hash 去重也会双双落空，开出重复内容的两个 tab。
- 触发场景：从文件管理器框选多个大 PDF 一次拖入。
- 修复：useFileDrop 的 drop 分支改为 `for...of await` 串行打开（每轮拿到最新闭包）；或在 addTab 内部把预算决策改为基于 `tabsRef` + 在飞文件清单。

### M-F5. useRecentFiles 加载竞态：启动后立即打开文件，新增条目被异步 load 覆盖丢失

- 位置：`src/hooks/useRecentFiles.ts:62-78`
- 问题：`loadRecentFiles()` 异步进行期间，`addRecentFile` 的 `update` 基于 `prev=[]` 写入新条目并持久化；随后 load resolve，`setRecentFiles(normalizeRecentFiles(files))` **整体覆盖**，刚加的条目从内存态消失（磁盘上的 save 顺序还取决于两次 invoke 的先后，可能连盘上也丢）。`loaded` 标志存在但突变路径完全没用它。
- 触发场景：冷启动 + 双击 .pdf（open-pdf 路径，App.tsx:621-626 立即打开），或启动后秒开文件。
- 修复：`loaded` 前把突变排队到 load 完成后重放；或 load resolve 时与当前 state 按 path merge 而不是直接覆盖。

### M-F6. 点击当前已激活 tab 会静默取消在飞的 pendingGotoPage

- 位置：`src/App.tsx:814-828`（非分屏路径无 `tabId === activeTabId` 早退）→ `src/hooks/useTabs.ts:186-194`（activateTab 无条件重写 `pendingGotoPage: tab.pageNum ?? 1`）
- 问题：大文档连续模式下点暂存/解读记录跳页后，若目标页 viewport 尚未齐（useTabRestore.ts:187-193 挂起等待），`pendingGotoPage` 仍在记录里；此时用户点一下当前 tab（很自然的动作），`activateTab` 把 `pendingGotoPage` 覆盖成当前页码，**跳转被无声取消**。分屏路径有 active 早退（App.tsx:817），非分屏没有。
- 修复：`activateTab` 内对「已激活且未休眠」的 tab 直接早退，或 App 层对齐分屏的早退判断。

### M-F7. 单页 → 连续模式切换后 scrollTop 被浏览器 clamp，视图与页码脱节

- 位置：`src/components/PdfViewer.tsx:1324-1392`（同一 container DOM 节点，仅切 ref 与 className）
- 问题：单页模式只渲染 1 个 PdfPage，容器 `scrollHeight` 骤降，浏览器把 `scrollTop` clamp 到 ≈0。切回连续模式后全部页重新挂载但 `scrollTop` 仍是 0——**视图停在第 1 页，`pageNum` 状态却还显示切换前的页码**，且 `useScrollPageSync` 只监听事件、挂载时不主动重算，错位持续到用户第一次滚动（滚动后页码突然跳回 1）。全仓确认没有任何 viewMode 切换的滚动恢复逻辑。
- 修复：viewMode 切到 continuous 的 effect 里用 `computeContinuousScrollTop(pageNum, ...)` 恢复一次滚动位置（走 `isJumpingRef` 锁）。建议跑 `pdf-page-jump.spec.ts` 加一条切换用例确认。

### M-F8. canvas 位图无尺寸上限：深度缩放 + 高 DPR 屏单页可达数百 MB

- 位置：`src/components/PdfPage.tsx:242-244`
- 问题：`canvas.width = floor(viewport.width * dpr)`，无任何上限。`MAX_SCALE = 5.0` × DPR 3（高分屏）时一页 A4 ≈ 8900×12600 像素 ≈ **450MB** 单页位图；连续模式渲染窗口是可见页 ±1，可同时存在数张。pdf.js 官方 viewer 有 `maxCanvasPixels` 上限，这里完全裸奔。
- 修复：渲染前按 `width*height*dpr²` 超阈值（如 16M~32M 像素）时降 DPR 渲染，CSS 尺寸不变。

### M-F9. `useViewportManager`：整批 `getPage` 失败仍翻转 ready 标志，导致缩放锁永久卡死

- 位置：`src/hooks/useViewportManager.ts:219-222` + `src/hooks/useZoomAnchor.ts:247-251`
- 问题：`loadPages` 在 `newEntries.length === 0`（整批失败，如损坏页/加密内容）时跳过 map 写入，但 `setViewportsForScale(batchScale)` 无条件执行。后果连锁：`isReady` 误翻转为 true；更糟的是 `useZoomAnchor` 恢复 effect gate 在 `viewportsForScale === scale`——若新 scale 的批次持续失败，该条件永不再次成立（值已被前一次失败批次翻成当前 scale，后续同值 setState 被 bail out），`isZoomingRef` **永不释放**，滚动页码同步从此冻结。
- 修复：仅在 `newEntries.length > 0` 时翻转 `viewportsForScale`；并给 `useZoomAnchor` 的恢复 effect 加超时兜底释放锁。

### M-F10. `useLinkPreviews.showPreview`：`resolveLinkDest` 异步完成后无条件弹窗

- 位置：`src/hooks/useLinkPreviews.ts:170-204`
- 问题：2 秒悬停计时到点后 `showPreview` 进入 async resolve。若用户在此期间移开链接，`handleLinkHover(null)` 启动的 400ms 宽限关闭**先于** resolve 完成触发——此刻列表里还没有这条预览，`filter(p => p.pinned)` 空跑；随后 resolve 返回，transient 预览被加入列表且**没有任何关闭计时在跑**，除非用户再去悬停/离开其他链接，否则常驻。另外弹窗锚点用的是 2 秒前的 `clientX/Y`，鼠标早已移走。
- 修复：resolve 完成后校验「hover 仍然有效 / 当前无进行中的关闭计时」再入列，或在入列同时补一次 `scheduleCloseTransient`。

### M-F11. SettingsModal 测试连接竞态 + 过期成功状态

- 位置：`src/components/SettingsModal.tsx:365-400`（`handleTestConnection` 无取消/快照校验），`319-346`（`handlePlatformChange`/`updateLlm` 均不重置 `testState`）
- 问题：两个叠加缺陷。① 测试进行中切换平台：旧平台的请求 resolve 后把 success/error 写到新选中的平台上，结果张冠李戴；② 测试成功后修改 model/baseUrl/apiKey（甚至切平台后再切回），`testState` 仍是 `success`，UI 显示"连接成功，模型：X"但指向的是已失效的配置，误导用户直接保存不可用配置。
- 修复：平台/模型/baseUrl/key 任一变化时 `setTestState("idle")`；测试开始时快照参数，resolve 时与当前表单比对，不一致则丢弃结果。

### M-F12. SetupWizard 测试通过后回退改 Key，可用未测试的 Key 完成向导

- 位置：`src/components/SetupWizard.tsx:296-306`（apiKey 输入框 `onChange` 不重置 `testState`）+ `446`（「开始使用」仅 `disabled={testState !== "success"}`）
- 问题：`selectPlatform` 会重置 testState，但编辑 apiKey 不会。用户在第 3 步测试成功 → 上一步 → 把 Key 改成别的（可能输错）→ 下一步 → testState 仍为 `success`，「开始使用」可点，`handleStart` 直接用未验证的 Key 保存并完成向导。
- 修复：`setApiKey` 的 onChange 里同步 `setTestState("idle")`（或记忆"已测试通过的 key 值"，不一致则要求重测）。

### M-F13. 打印导出：系统保存对话框点「取消」会连带关闭打印弹窗

- 位置：`src/services/print.ts:110-124`（`exportPrintPdf` 用户取消返回 `false`）、`src/components/PdfViewer.tsx:905-920`（`handlePrintExport` 丢弃返回值）、`src/components/PrintModal.tsx:63-69`（`run` 不抛错就 `onClose()`）
- 触发场景：打印弹窗里选好页码范围和勾选 → 点「导出」→ 系统保存对话框里反悔点取消 → 打印弹窗也被关闭，所有选择丢失。
- 修复：`handlePrintExport` 透传 boolean，PrintModal 仅在返回 `true` 时 `onClose()`。

### M-F14. `export_binary_file` 的 `Array.from(pdfBytes)` 大文件性能炸弹

- 位置：`src/services/print.ts:121`
- 问题：栅格化路径下 60 页 PDF 轻松 20–50MB，`Array.from` 生成数千万元素的 number 数组再 serde_json 序列化，内存峰值达原文件数倍、主线程长时间卡顿（导出期间 UI 冻结）。注释已知此限制但未防护。
- 修复：复用 `open_print_file` 的 raw bytes IPC 模式（`InvokeBody::Raw`，后端已有先例 `lib.rs:383`），或在弹保存对话框前先落临时文件再 move。

### M-F15. MarkdownRenderer sanitize schema 对全部元素放行 `style` / `className`——提示注入可 UI redress

- 位置：`src/components/MarkdownRenderer.tsx:78`
- 问题：`rehypeRaw` + 自定义 schema 允许任意 `style` 和 `className`。渲染内容来自 LLM 输出，而 LLM 输入含 PDF 选中文本——恶意 PDF 可通过提示注入让模型输出 `<div style="position:fixed;inset:0;…">伪造界面</div>` 之类的 payload，在 webview 内做覆盖钓鱼（如伪造"请输入 API Key"弹窗）；`className` 还可套用应用内既有样式类放大欺骗性。Tauri CSP 通常不拦 inline style。
- 修复：把 sanitize 挪到 rehype-katex 之后（或仅对 KaTeX 产物的 `span` 白名单化 style 值），并去掉 `"*"` 上的 `className`。需进一步确认 KaTeX 输出对 style 的真实依赖面。

### M-F16. AiChatPanel 自动 tab 切换与 tabRequest/标记点击互相打架

- 位置：`src/components/AiChatPanel.tsx:176-189`
- 问题：自动切换 effect 只看 `stashes.length` 且被 `hasUserManuallySwitchedTabRef` 门控，但两条"非手动"入口都不置该标记：marker 点击展开会话（`expandedSessionId` 路径）和 `tabRequest` nonce 路径。后果：用户通过 marker 点开解读会话后，另一屏（分屏合并显示）任何暂存增删都会把面板拽回「暂存」tab；同理 `requestPanelTab("sessions")` 生效后若 stash 数量随后变化，tab 被悄悄换掉。
- 修复：`tabRequest` effect 与 `expandedSessionId` effect 内同时置 `hasUserManuallySwitchedTabRef.current = true`，或把自动切换进一步收窄为"仅 0↔非 0 跳变时触发"。

### M-F17. 流式期间防抖保存被无限推迟，崩溃丢失整段进行中的回答

- 位置：`src/hooks/usePersistence.ts:473-520`
- 问题：50ms 合批 flush 持续重置 500ms 防抖，长流式期间零增量落盘；仅正常关窗（App.tsx:686 `onCloseRequested` → `flushPendingSaves`）兜底，崩溃/断电丢失整段进行中的回答。
- 修复：流式期间每 N 秒强制落盘一次。

---

## 低严重级别

### 后端

- **L-B1** 锁中毒 panic：`allowed_paths`/`pending_open_paths`/`pdf_hash_cache` 全部 `.lock().unwrap()`（lib.rs:66-83, 470, 481, 510）；`validate_pdf_access` 的 unwrap 跑在 async runtime 线程，panic 可能带垮任务。建议统一换 `map_err`。
- **L-B2** `settings.json` 损坏无兜底（lib.rs:1078-1088）：解析失败直接报错，不像 annotations 有 corrupt 备份机制（lib.rs:1007-1027）。建议对齐：备份后回退默认值。
- **L-B3** 白名单 fail-closed 误判（UX 缺陷）：白名单是 `HashSet<PathBuf>` 字节级相等（lib.rs:71-73），不做 canonicalize。macOS `/tmp`→`/private/tmp`、Windows 盘符大小写差异会导致「同一文件、不同字符串」被拒绝打开。
- **L-B4** `read_pdf_bytes` / `open_print_file` 无大小上限（lib.rs:520-537, 383-399）：超大 PDF 全量读入内存再经 IPC 复制一份，数 GB 文件有 OOM 风险。建议加软上限提示。
- **L-B5** 文件被移动后批注保存持续失败（lib.rs:905-914）：`save_pdf_data` 必须重新 stat/计算 hash，PDF 被移动/删除后所有批注保存报「Failed to read PDF metadata」；前端是否暴露该错误需确认，否则用户继续批注但全部不落盘。
- **L-B6** macOS `RunEvent::Opened` 只处理第一个 PDF（lib.rs:259-277，`break` 于 275 行）：Finder 多选打开只进一个。若属有意设计可忽略。
- **L-B7** `request_id` 冲突时新旧流互相破坏取消语义（llm_proxy.rs:534, 540-544）：后注册者覆盖前者 flag，旧流不可取消；旧流 cleanup 还会删新流 flag。前端用 `crypto.randomUUID()`，实际碰撞概率极低，属防御性缺陷。建议 cleanup 时用 `Arc::ptr_eq` 校验再 remove。
- **L-B8** 早期错误路径泄漏 cancel map 条目（llm_proxy.rs:547, 552, 610）：注册 flag 后 `?` 直接返回，map 残留。建议 guard 结构（Drop 时 remove）。
- **L-B9** SSE 行解析不容忍 `data:` 无空格形式（llm_proxy.rs:385, 389）：SSE 规范中空格可选，无空格的平台实现会被静默跳过整行。有流结束兜底不挂死，但中间内容全丢。建议 `strip_prefix("data:")` 后再 strip 可选空格。
- **L-B10** tool_call 片段缺 `index` 时全部并入 index 0（llm_proxy.rs:474-477，`unwrap_or(0)`）：某平台省略 index 时多个 toolCall 的 arguments 串接成乱码 JSON。建议缺失 index 记日志告警或按 id 变化兜底。
- **L-B11** `RateLimit.retry_after` 与 `ContextLengthExceeded.limit/requested` 恒为占位值（llm_proxy.rs:303-316）：429 的 `Retry-After` 头未解析，context length 数值未从消息提取。前端若依赖这两个字段永远拿到空值。
- **L-B12** 流内 error 事件后紧跟 Done，前端可能重复收尾（llm_proxy.rs:400-413 → 734）：前端先收 `Error` 再收 `Done`，需确认前端 `services/llm.ts` 对该序列有幂等保护。
- **L-B13** 词典无并发下载防护（dictionary.rs:182+）：两个并发 `download_dictionary` 交错写同一 tmp 文件必然损坏（SQLite 校验兜底）。前端有 `downloading` 状态防重入，后端无防御。建议加 `AtomicBool` 下载锁。
- **L-B14** 词典 HEAD 探测失败不重试（dictionary.rs:208-220）：弱网下首次点击易失败。建议降级 `total_size = 0` 直接进 GET 重试循环。
- **L-B15** 词典文件被外部删除/替换后缓存连接持旧句柄（dictionary.rs:615-623 + lib.rs:1338-1343）：macOS/Linux 读旧 inode 返回旧数据；Windows 上句柄占用导致用户删不掉文件。建议 `path.exists()` 为 false 时清空缓存连接。
- **L-B16** `pending_open_paths` 热启动重复入队（lib.rs:143-150）：webview 中途刷新/崩溃重载会把历史 open 路径再回放一遍，表现为旧文件被重新激活。影响轻微。
- **L-B7'**（记账）无界增长（极慢）：`pdf_hash_cache`、`allowed_paths`、`ATOMIC_WRITE_LOCKS`、未 drain 的 `pending_open_paths` 都只增不减，单会话内可忽略。

### 前端

- **L-F1** Channel 桥接残余事件无界入队（llm.ts:65-71）：generator 退出后残余事件仍 `queue.push` 无消费者，量小。另 llm.ts:110-119 `case "error"` 无条件 `finished=true`，后端恒带 error 字段暂无实害，属脆性。
- **L-F2** `useStreaming.run` 同 key 重跑时旧 finally 误删新 controller（useStreaming.ts:44, 93-95）：finally 无条件 `delete(key)`。当前 key 基本唯一，latent。建议先比对引用再删。
- **L-F3** abort 后 toolEvents 滞留 "running"：placeholder 上 running 态的 toolEvents 永不清理，`ToolCallsIndicator.tsx:58` 明细行恒渲染 spinner。纯展示问题。
- **L-F4** 追问回放携带 `reasoningContent` 的跨平台兼容性（usePersistence.ts:593-606，**需确认**）：DeepSeek 官方建议非工具轮次不回传 `reasoning_content`，8 个平台预设未逐一验证，存在某些平台 400 的风险。
- **L-F5** `buildFinalNoToolsMessages` 在消息末尾追加第二条 system 消息（usePersistence.ts:641-644，**需确认**）：非常规顺序，个别严格校验的平台可能拒绝。
- **L-F6** addTab 在飞期间的字节缓存驱逐竞争（App.tsx:157-166）：`cachePdfBytes` 写入后、新 tab 落进 `tabs` 前，任何 tabs 变化都会让驱逐 effect 删掉字节 → viewer 二次读盘。仅效率损失。
- **L-F7** `openingPaths` / `pendingOpens` 无超时兜底（useTabs.ts:240-349）：`read_pdf_bytes` 在死网盘/SMB 上永久挂起时，「正在打开」toast 常驻且同路径永远无法重试。需确认后端该命令是否有超时。建议加超时并清理 in-flight 记录。
- **L-F8** `handleCloseTab` 顶替激活时 `pendingGotoPage: tab.pageNum` 无 `?? 1` 兜底（useTabs.ts:417，对比 activateTab :191）：pageNum 缺失时两条路径行为分叉，建议统一。
- **L-F9** `normalizeRecentFiles` 降级置顶条目破坏未置顶组时间序（useRecentFiles.ts:38-55）：纯展示问题。
- **L-F10** `projectUsage` 对同路径 newFile 漏计 aliveViewers（memoryBudget.ts:90-93）：当前路径去重使该分支不可达，潜伏记账错误。建议 aliveViewers 自增移出 `if`。
- **L-F11** 大文档唤醒/首挂载的 scrollTop 恢复等待全量 viewport（useTabRestore.ts:230-238 + useViewportManager.ts:232-254）：N 页文档唤醒即 N 次 `getPage` 风暴，恢复延迟随页数线性增长。不会死锁（已核实），500+ 页文件体验迟滞。可先用均高估算落位再收敛。
- **L-F12** useFileDrop 看门狗可能在「静止悬停」时误隐藏遮罩（useFileDrop.ts:66-71, 98-103）：指针静止时平台是否持续发 `over` 需实测确认；若不持续，遮罩闪烁。
- **L-F13** `PdfPage` 错误路径位图滞留（PdfPage.tsx:288, 356-367）：canvas 已绘制但 `getTextContent` 抛错时 `hasRenderedRef` 未置位，位图清零逻辑早退，位图滞留到卸载。
- **L-F14** 大文档 self-load storm 无页数上限（PdfPage.tsx:180-203 + useTabRestore.ts:88-96）：1000 页文档打开即 1000 次 getPage + setState，pending goto / scrollTop 恢复依赖这场 storm 完成。
- **L-F15** `PdfViewer` 的 `onStateChange` 上报 effect 无 `isActive` 门控（PdfViewer.tsx:509-523，**需确认**是否有实际触发路径）：IO 上报和滚动同步都有冻结，唯独此 effect 没有，防御缺口。
- **L-F16** `fitToWidth` 对 0 宽容器无防御（PdfViewer.tsx:1033-1050 + fitToWidth.ts:36-39）：容器塌缩时返回负值被 clamp 到 `MIN_SCALE = 0.1`，文档意外缩到 10%。
- **L-F17** 搜索查询串未做空白归一化（useSearchDomain.ts:205）：索引侧压缩 `\s+`，查询侧只 `trim()`，粘贴含双空格/换行的短语永不命中。
- **L-F18** 搜索在 tab 休眠 / pdf destroy 时按页刷错误日志（useSearchDomain.ts:207-238）：catch 不检查 `cancelled`，N 页刷 N 条日志。
- **L-F19** `PageRail` 连续模式 effect 依赖 `pageNum`，每翻一页重绑 scroll 监听（PageRail.tsx:124-154）：功能正确，纯 churn。
- **L-F20** 跳页闪卡同页连跳不重放（PdfViewer.tsx:820-824, 1488-1492）：600ms 内再跳同一页 `setFlashPage(page)` 同值 bail out，闪卡提前消失且动画不重放。
- **L-F21** `useWordLookup` 卸载时在飞查询仍回写 state（useWordLookup.ts:62-72）：React 18 静默无害，属泄漏模式。
- **L-F22** 搜索匹配的 `slice` 用查询长度切原文（useSearchDomain.ts:229）：`toLowerCase` 改变字符串长度的字符（`İ`、`ß`）会切错。纯英文/中文场景无影响。
- **L-F23** `useDrag` 窗口外松开鼠标拖拽状态残留（useDrag.ts:82-106）：无 pointer capture、无 blur 兜底，鼠标移回窗口会继续拖动浮层。建议 window blur 强制收尾或 `setPointerCapture`。
- **L-F24** `redactSensitiveInfo` 脱敏模式遗漏（logs.ts:18-31）：只覆盖 `sk-*`（≥20 字符）、`Bearer `、主目录路径。遗漏智谱 GLM 的 `xxxxxxxx.yyyyyyyy` 格式、`api_key=`/`access_token=` query 参数形态、短于 20 字符的非标 Key。
- **L-F25** 栅格兜底路径页码清单被 pdf-lib 页数静默裁剪（printPdf.ts:290-295, 318-321，需实际文件样本确认）：损坏 xref 的文件 pdf-lib 页数可能少于 pdfjs 页数，用户选中的尾部页被静默丢弃。建议兜底分支改用 `rasterize.numPages` 重建 wanted。
- **L-F26** SettingsModal 打开期间 `initialSettings` 引用变化会清空未保存编辑（SettingsModal.tsx:124-142）：App 侧任何 `setSettings` 产生新对象 → 弹窗内未保存输入被重置。当前遮罩挡住大部分入口，潜伏 bug。建议仅在 `open` 由 false→true 时重置。
- **L-F27** AiChatPanel「全部文档」范围下 tab 徽标计数仍显示当前文档会话数（AiChatPanel.tsx:629）：UI 不一致。
- **L-F28** useDictionaryStatus listener 泄漏竞态（useDictionaryStatus.tsx:58-85）：`onDownloadProgress()` 的 promise 在 cleanup 之后才 resolve 时 unlisten 永远不再调用。建议加 `cancelled` 标记。
- **L-F29** 批注贴图内容超长静默截断（printBoxRenderer.ts:33, 116-119）：`MAX_BODY_HEIGHT=254` 封顶，长翻译上纸尾部被裁且无省略提示。建议截断时追加"…（内容过长已截断）"行。
- **L-F30** UserMessageContent 折叠可能截断 markdown 结构（AiChatPanel.tsx:902-905）：`content.slice(0, 120)` 可能切断代码块/公式定界符，折叠态降级为纯文本（有 ErrorBoundary 兜底）。低概率。
- **L-F31** print.ts 注释与实现不符（print.ts:15-17）：注释称"休眠 tab 也能打印"，但 `PrintModal` 挂在 `PdfViewer` 内，休眠 tab 无打印入口。纯注释误导。
- **L-F32** settings.ts 迁移保存条件只比较 model（settings.ts:262-266，极边角需确认）：`migrateModelForPlatform` 还可能改 `platformId` 与 `baseUrl`，这两类变更不进保存条件。

---

## 已确认安全的关键路径

### 后端

- **session id 路径穿越**：`validate_session_id`（lib.rs:922-933）白名单字符集不含 `.` 和 `/`，load/save/delete 三条路径都过校验，测试齐全。
- **annotations 文件名**：hex SHA-256 拼接，无注入可能。
- **原子写入本身**：tmp 与目标同目录 rename 不跨设备；同目标并发由 per-path 锁串行化；Windows rename 带 REPLACE_EXISTING 语义。
- **API Key 安全模型**：`load_settings` 返回前强制清空、钥匙串失败即拒绝保存、明文迁移后即清盘，测试覆盖。
- **损坏批注文件处理**：解析失败先 rename 备份再报错，绝不返回空数据防前端覆盖。
- **API Key 不泄漏**：401 body 不回显（有专项测试）；reqwest 错误对象不含请求 header；日志只记 model/url。
- **SSE UTF-8 跨 chunk 切断**：字节缓冲 + 完整行才解码，有专项回归测试。
- **取消语义**：`select!` 让停滞连接 ≤50ms 内响应取消；tool_calls 兜底 flush 有测试。
- **无 zip slip**：解压输出文件名固定 `entry_{i}`，不使用归档内文件名。
- **无 SQL 注入**：`lookup_word` 参数绑定。
- **服务器忽略 Range 的回退正确**：200 + `start_from > 0` 时从头下，无死循环（重试计数单调递增）。
- **单实例 / open-pdf**：插件注册顺序、冷启动补 emit、记录先于 emit，4 个专项测试。
- **serde 兼容性**：新增字段均有 `#[serde(default)]` / `skip_serializing_if`，旧版纯数组格式有回退分支。

### 前端

- **Agent Tools 授权白名单无法被模型绕过**：工具参数只接 `file_hash`，`filePath` 由 registry 内部查表，`isAuthorized` 仅限当前打开 tab；`getPdfBytes` 的 `cached.slice()` 防 pdfjs detach 污染 App 级缓存。
- **同参去重**：`seenCalls` 以原始字符串为 key，JSON 键序不同只退化为重复执行，无错误判定。
- **工具结果消息插入顺序正确**；`collectTurnProcess` 归组逻辑与 UI 消费一致。
- **fire-and-forget summary**：会话被删/重解读后 onDone 对 state 为 no-op，不覆盖正文。
- **pdfCacheRef 生命周期**：关 tab 清缓存、休眠驱逐、唤醒回退 `read_pdf_bytes` 重填链路完整；缓存规模被存活 tab 文件集天然约束。
- **关 tab 清理**：`abortSessionsForTab` 中止流式、暂存按 tabId 过滤、脏批注由全局 dirty 集合 + `flushPendingSaves` 覆盖。
- **useTabRestore 时序**：didInit/hasRestored 单次门控、恢复窗口跳锁持有、同页 pending 清除设计自洽。
- **pdf.js render task 生命周期**：PdfPage cleanup 正确 cancel，`isCancelled` 闸门覆盖所有 await 点；`RenderingCancelledException` 静默吞掉。
- **self-load 重复渲染陷阱**：`pageViewport === selfViewport` 引用相等不触发二次渲染。
- **keep-alive 冻结**：IO 上报经 `isActiveRef` 拦截、滚动同步忽略隐藏态、PdfPage 卸载补发 link hover null。
- **useFileDrop 看门狗清理**：定时器在 drop/leave/blur/unmount 四条路径均清理。
- `pageRail.ts` / `fitToWidth.ts` / `zoomAnchor.ts` / `popupPosition.ts` 的数学边界（除已列条目）均有 clamp/除零防护。

---

## 优先修复建议

1. **第一梯队**（单行级修复、后果严重）：H1（abort 挂起）、H2（悬空 toolCalls）、H5（goToPage 残留监听）。
2. **第二梯队**（用户数据受损类）：M-B1（迁移半完成永久化）、M-F1（保存失败静默）、H3（翻译卡死）、H4（休眠 active tab）。
3. **第三梯队**（可用性/成本）：M-B4（300s 超时腰斩长解读）、M-B6（丢 key）、M-F4（批量拖放超支）、M-F7（viewMode 切换脱节）。
4. 低危项按迭代顺路处理。
