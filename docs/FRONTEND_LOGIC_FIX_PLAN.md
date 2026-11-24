# 前端逻辑问题修复计划

> 状态：**已实施并通过自动化验证**（2026-11-24）。
>
> 来源：2026-11-24 前端逻辑审查。共 10 个确认问题，其中 9 个曾通过一次性 Vitest 延迟 mock 复现，分屏会话展开问题由代码路径直接确认。一次性复现文件未保留在仓库中；实施时第一步必须把这些场景转化为正式回归测试，不以一次性测试记录代替验收。
>
> 审核补充已逐项对照源码并纳入：F5 冷启动并发入口、F2 精确失效时间线、F1 失败重试路径与优先级、flush 有界 best-effort、Tab 全写入路径的 ref 同步、F6/F7 实现约束、F8 钥匙串副作用，以及 F9 展示顺序和 updater 副作用。

## 1. 目标与范围

### 目标

1. 消除批注、会话在异步加载和保存过程中的数据丢失。
2. 保证“较新的用户操作不会被较旧的异步结果覆盖”。
3. 修复流中止、Tab 去重、分屏面板联动及输入边界问题。
4. 为每个问题补充稳定的回归测试，不改变现有产品交互和数据格式。

### 非目标

- 不调整后端 Tauri command、Rust 数据结构或磁盘 JSON schema。
- 不重构整个 `usePersistence` / `useTabs`，不引入新的状态管理库。
- 不顺带实现 Backlog 中的新功能，也不改变暂存、会话、休眠的既有产品语义。
- 不通过禁用编辑、关闭分屏或减少功能来规避问题。

## 2. 问题清单与实施批次

| 编号 | 问题                                       | 风险                       | 批次 |
| ---- | ------------------------------------------ | -------------------------- | ---- |
| F1   | 初始磁盘加载覆盖加载期间新建的批注         | 低频路径、可致数据丢失     | PR1  |
| F2   | 旧保存清掉新修改的脏标记，新修改不再落盘   | 数据丢失                   | PR1  |
| F3   | 会话旧保存晚于新保存完成，磁盘回退到旧内容 | 数据丢失                   | PR1  |
| F4   | 同 key 旧流误删新流控制器，新流无法中止    | 请求失控、额外 token 消耗  | PR2  |
| F5   | 并发打开不同路径的同内容 PDF，生成重复 Tab | 状态与内存重复；实现风险高 | PR2  |
| F6   | 分屏副屏解读标记不能展开右侧会话           | 功能失效                   | PR3  |
| F7   | 并发粘贴可突破 3 张图片上限                | 上下文和 token 超限        | PR3  |
| F8   | 向导迟到的旧连接测试重新启用“开始使用”     | 未验证配置被当成已验证     | PR3  |
| F9   | 固定条目降级后展示顺序及淘汰顺序均错误     | 最近文件错序、错误丢失     | PR3  |
| F10  | 中文输入法组词时 Enter 误发送追问          | 高频误操作                 | PR3  |

建议按 **PR1 → PR2 → PR3** 顺序实施。PR1 内部先处理确定性更高、时间线更直接的 **F2/F3，再处理 F1**；PR1 独立合入并验证后再开始后续批次，避免持久化改动与其他并发改动交织。F5 虽位于 PR2，但实现风险最高，需按第 5.2 节的全写入路径约束单独审查。

## 3. 统一设计约束

以下约束适用于全部批次：

1. **旧异步结果不能覆盖新状态**：加载、保存、流、连接测试均需能识别自己是否为最新操作。
2. **同一持久化实体的写入有序**：同一 fileHash 的 PDF 数据、同一 sessionId 的会话分别串行写入；不同 hash/session 可并行。
3. **脏标记按版本清理**：保存成功只清理该保存对应版本的脏状态，不能清理保存期间新增的修改。
4. **flush 包含在途任务但有界**：退出或备份前的 flush 必须等待之前已开始的写入，以调用时 revision 为边界，最多两轮 drain；它是受关窗 3 秒超时约束的 best-effort，不承诺持续流式写入或后端卡死时仍能保存绝对最新状态。
5. **副作用不放进 React state updater**：不在 updater 中激活 Tab、调用后端或释放 URL，避免 StrictMode 重复执行副作用。
6. **优先复用现有机制**：不新增平行状态流，优先使用现有 `expandSessionRequest`、refs、Promise 和测试 mock。
7. **前端有序即够，不扩大后端范围**：这些持久化文件仅由本进程写入，因此前端按实体串行即可保证写序，不引入后端锁或数据迁移。

## 4. PR1：修复批注与会话持久化竞态（F1–F3）

### 4.1 初始加载合并（F1）

涉及：

- `src/hooks/usePersistence.ts` 主屏加载 effect（约 414–460 行）。
- 同文件副屏加载 effect（约 463–506 行）。
- `src/hooks/usePersistence.test.tsx`。

触发频率与优先级：常规 `loadPdfData` 读取 AppData 小 JSON，首次加载窗口通常只有毫秒级，人工新建批注撞上该窗口并非高频。仍存在确定的第二条路径：**首次加载失败 → 用户先添加批注 → 切走再切回触发重试 → 重试成功的旧快照覆盖新批注**。因此该问题必须修，但排在 F2/F3 之后，不按最高频问题处理。

实施：

1. 抽出主屏/副屏共用的按 hash 加载 helper，消除两份加载逻辑 drift。
2. 对同一 fileHash 的初始加载做 single-flight，避免主屏和副屏同时加载同一份磁盘数据并互相覆盖。
3. 加载开始时记录该 hash 的本地 revision；加载返回后：
   - 若本地无变化，沿用当前磁盘加载路径。
   - 若期间已有本地修改，按 annotation `id` 合并：磁盘旧数据作为基底，当前内存中的同 id 项优先，加载期间新建项必须保留。
4. 只有加载成功才设置 `loadedFileHashesRef`；保留现有“加载失败不得写空桶覆盖磁盘”的防线。
5. 加载合并不再把用户已修改的桶静默替换成旧快照，也不额外把纯磁盘读取标脏。

选择合并而不是“加载完成前禁止批注”，原因是 PDF 渲染与批注加载本来就可并行，不应让用户操作无响应。

### 4.2 PDF 数据按 hash 串行保存并带 revision（F2）

涉及：

- `setAnnotationsByHash` 的标脏逻辑。
- `persistDirtyHashes`、两个保存防抖 effect、`flushPendingSaves`。

精确失效时间线：**A 保存中 → 用户添加 B，dirty 重建且防抖排到 +500ms → A 完成并无条件清 dirty → B 的定时器空转**。此后切 Tab 的定向 flush 同样因脏集合为空而无效，关窗 flush 也救不回来；B 要等下一次编辑产生新脏标记后才可能落盘。回归测试必须覆盖“定时器空转后切 Tab/关窗”的后续路径，而不只检查第一次保存内容。

实施：

1. 为每个 fileHash 维护单调递增的本地 revision；只有真实本地批注变化才递增，磁盘加载和单纯重渲染不递增。
2. 每次保存捕获 `{revision, annotations, sessionIds}` 快照。
3. 同一 hash 的保存进入独立 Promise 队列；后到的保存读取届时最新快照，不与旧保存并发写盘。
4. 保存成功后，仅当当前 revision 仍等于捕获 revision 时清除 dirty；否则保留 dirty 并继续安排最新快照保存。
5. 保存失败仍保留 dirty 和重试能力，沿用现有错误处理，不向用户伪装成功。
6. `flushPendingSaves`：
   - 清除尚未触发的防抖 timer，并记录调用时的目标 revisions。
   - 等待此前已登记的在途保存及本次排队保存。
   - 最多执行 **2 轮 drain**，只保证调用时已存在的目标 revisions，不持续追逐流式期间产生的新 revisions。
   - 明确为 **best-effort**：`App.tsx:817–819` 的关窗 `Promise.race` 只有 3 秒，后端卡死或持续流式写入时，不宣称返回后磁盘必为绝对最新；超时沿用现有退出兜底，并保留错误日志。
7. 保留不同 hash 之间的并行能力，避免一个慢网络文件阻塞全部 PDF。

### 4.3 会话按 sessionId 串行保存（F3）

涉及：

- `persistChangedSessions`。
- `savedSessionsRef`。
- 会话删除、重新解读与退出 flush 的相邻路径。

实施：

1. 为每个 sessionId 建立独立写入队列，防抖、流式强制保存和手动 flush 都进入同一队列。
2. 每次任务保存不可变快照；成功后再更新 `savedSessionsRef`，旧任务不得越过新任务完成写盘。
3. 队列中的后续任务重新比较最新 `sessionsRef` 与已保存快照，避免保存已经被取代的内容。
4. 删除会话、重新解读时，让 delete 与 save 使用同一顺序约束，防止旧保存在删除后重新生成会话文件。
5. `flushPendingSaves` 等待所有相关 session 队列及此前在途写入，不再只等待本次循环创建的 Promise；同样遵守“调用时目标 revisions + 最多 2 轮 + best-effort”边界，不做无限 drain。

### 4.4 PR1 回归测试

在 `src/hooks/usePersistence.test.tsx` 使用 deferred `invoke`，至少覆盖：

1. 初始加载 pending 时添加批注，加载完成后新批注仍存在。
2. 首次加载失败后先添加批注，切走再切回重试成功，新批注仍不被旧快照覆盖。
3. 主屏/副屏同 hash 同时加载只读取一次，且不覆盖本地编辑。
4. 保存 A pending 时添加批注 B，A 完成后 B 仍 dirty；继续经过防抖、切 Tab 定向 flush 和关窗 flush，最终磁盘仍包含 A+B。
5. 连续修改同一 hash 时写盘顺序与 revision 顺序一致；不同 hash 不被无意义地全局串行。
6. 旧 session 保存慢、新 session 保存快时，最终磁盘仍为最新内容。
7. flush 在已有在途保存时调用，调用时目标 revisions 能落盘；持续产生新 revisions 时最多两轮退出，不发生无限 drain。
8. 删除/重新解读与在途保存交错时，不出现已删除会话文件复活。
9. 既有“保存失败后恢复重试”“加载失败不写盘”测试继续通过。

### 4.5 PR1 验收

- 上述竞态测试全部通过，现有 `usePersistence` 测试不回退。
- 在后端保存正常完成且调用后 revision 稳定的前提下，人为控制 Promise 完成顺序，最终磁盘内容均由最新用户操作决定。
- 持续流式写入或后端超时时，只验收 drain 有界、退出不卡死和 best-effort 日志，不承诺关窗 3 秒外的绝对最新落盘。
- 无数据格式迁移，无后端改动。

## 5. PR2：修复流控制器与 Tab 打开竞态（F4–F5）

### 5.1 同 key 流控制器身份保护（F4）

涉及：`src/hooks/useStreaming.ts`、`src/hooks/useStreaming.test.tsx`。

实施：

1. `run` 的 `finally` 仅在 `controllersRef.current.get(key) === controller` 时删除。
2. 保持现有 abort 空闲唤醒、错误与 onAbort 行为，不改变事件顺序。
3. 检查 `abort` / `abortPrefix` / `abortAll` 与 `run` 的 Map 操作，确保旧流收尾不会影响新流。

测试：

1. A 启动后以同 key 启动 B，A 收尾后再 abort，B 必须收到 abort。
2. 旧流正常结束、错误结束、主动中止三条路径均不能删除新控制器。
3. 现有“空闲期中止仍 settle”和“不重复 onAbort”测试继续通过。

### 5.2 Tab 最终提交去重（F5）

涉及：`src/hooks/useTabs.ts`、`src/hooks/useTabs.test.ts`，并增加 `src/App.tsx` 冷启动入口的集成覆盖。

真实入口比单纯拖放更直接：`App.tsx:762–766` 的冷启动 `take_pending_open_pdfs` 在 `for` 循环中不 `await`，会对多个路径并发调用 `openPdfByPath`；`open-pdf` listener 同样不串行。一次“打开方式”选择多个文件即可同时进入 `addTab`，同名不同目录的标准副本会显著提高同 hash 命中率。

实施：

1. 保留按 filePath 的 `pendingOpens`，继续避免同路径重复 I/O；文件读取和 hash 计算仍可并行。
2. 将 hash 计算后的“检查路径/hash → 内存预算 → 硬上限 → 插入 → 激活”移动到一个串行的**同步 commit 临界区，内部禁止 `await`**，防止检查与插入之间再次让出执行权。
3. 新增统一的 Tab 写入 helper，**在同一 tick 内紧邻完成 `tabsRef.current = next` 与 `setTabs(next)`**。不仅新 commit 使用，`activateTab` / `gotoTabPage` / `handleCloseTab` / `handleViewerStateChange` 以及 selection、highlight、pending 清理等所有 `setTabs` 路径都必须改用该 helper；否则 commit 仍可能读到旧集合。
4. commit 从最新 `tabsRef` 读取并再次检查路径/hash。若已存在，激活已有 Tab 并返回已有对象，不再插入；缓存字节的保留策略维持现状。
5. 休眠候选计算也基于 commit 时的最新 Tab 集合，避免并发打开时使用旧预算快照；激活相关路径同步维护 `activeTabIdRef`，避免同一 tick 内保护错 Tab。
6. 不在 `setTabs` updater 中执行 `activateTab` 等副作用。React 状态仍按正常声明式更新，同步 ref 仅作为同 tick 的操作协调镜像。

测试：

1. 不同路径、相同 hash 并发打开，最终只有一个 Tab，两个调用都解析到该 Tab。
2. 冷启动一次补取多个 pending 路径时不 `await` 的原始入口也能去重，不只验证串行调用 hook 的理想路径。
3. 同路径并发仍只做一次 I/O；不同文件正常生成两个 Tab。
4. 并发打开与激活、关闭、viewer 状态上报同 tick 交错时，commit 不读取旧集合；硬上限和休眠预算按最新集合计算。
5. 重复打开、最近文件恢复页码、休眠唤醒等既有测试不回退。

## 6. PR3：修复分屏与交互边界（F6–F10）

### 6.1 分屏副屏会话展开（F6）

涉及：`src/App.tsx`。本批次保留 `AiChatPanel` 的 `expandedSessionId` 旧入口及既有测试，不做无关 API 清理。

现有 `expandedSessionId` 还有第二个问题：它只在值变化时触发。用户返回列表后，若在 2 秒高亮清除前再次点击**同一个标记**，值没有先变回 `null`，effect 不会再次执行，会话仍不展开。改用 nonce 同时解决副屏接线和重复点击问题。

实施：

1. `handleExplainClick` 已拿到真实 `tabId` 和 annotationId，继续用它控制对应 PDF 的高亮。
2. 通过 `findSessionIdByAnnotationId` 找到 sessionId，复用现有 `requestExpandSession(sessionId)` 驱动右侧 chatbox，不再依赖主屏 `highlightedAnnotationId` 推导。
3. 若旧数据未回填 `sessionId`、查找结果为 `undefined`，明确降级为**只高亮、不展开**，不得伪造空 id 请求。
4. 保留高亮 2 秒清除逻辑；会话展开请求与高亮视觉状态解耦。
5. App 不再向面板传 `expandedSessionId`，但保留该 prop 和 `AiChatPanel.test.tsx` 中约 8 个相关用例，避免本批次扩大到面板 API 重构；过时注释按实际行为更新。

测试：

- `App.test.tsx` 或分屏集成测试覆盖主屏、副屏标记都能展开正确会话。
- 用户返回列表后，在 2 秒内再次点击同一标记仍展开；同一 session 的其他标记也可重复展开，直接验证 nonce 的收益。
- annotation 无 `sessionId` 时只高亮，不产生展开请求。
- 运行 `e2e/pdf-split-view.spec.ts` 确认分屏主流程无回归。

### 6.2 图片附件原子限额（F7）

涉及：`src/hooks/useImageAttachments.ts`、`src/components/AiChatPanel.tsx`。

实施：

1. 删除 `useImageAttachments.ts:38` 的 render 期 `imagesRef.current = images`。该赋值在并发渲染下本身不安全；改为所有写操作同步维护 ref 后，不再需要 render 镜像。
2. `append` 基于最新 `imagesRef` 同步计算 accepted/rejected，并同步写入 ref 后再 `setImages`，使同一批异步回调也能看到最新数量。
3. `remove` / `clear` 同样同步维护 ref，避免紧接着的 append 读到旧值。
4. 增加 `limitNotifiedRef` latch：达到上限后重复添加只提示一次；remove/clear 使数量低于上限时复位，避免持续粘贴反复弹窗。保持一次系统对话框多选的截断行为。
5. 只对 rejected/removed 的 object URL 做 revoke，且不在 React updater 中执行 revoke。

测试：

- 4 张图片并发归一化完成，最终最多 3 张，多余 URL 被释放；继续在上限状态粘贴只提示一次，remove/clear 后提示资格复位。
- remove/clear 后立即完成另一项异步添加，不错误复活或超限。
- 既有对话框选择、删除、清空测试继续通过。

### 6.3 向导连接测试序号（F8）

涉及：`src/components/SetupWizard.tsx`、`src/components/SetupWizard.test.tsx`。

实施：

1. `handleTest` 不再先 `saveSettings`。改为复用现有 `testConnection(params)`，直接传当前 `{platformId, baseUrl, model, apiKey}` 快照；空 Key 仍沿用后端 keyring fallback，与设置页的未保存测试方式一致。
2. **`handleStart` 成为唯一保存设置/写入钥匙串的路径**。这样即使用户在测试期间改配置或关闭向导，也不会出现界面为 B、钥匙串已被旧 A 覆盖的残留。
3. 增加与 `SettingsModal` 相同的 `testSeqRef`；修改平台、API Key，以及重新发起测试时递增序号。
4. `handleTest` 捕获序号和配置快照，`testConnection` 返回后确认仍为最新；迟到的 UI 结果直接丢弃。只有当前配置对应的最新测试成功，才允许“开始使用”。

测试：

- 旧 Key 测试 pending 时改成新 Key，旧测试成功后按钮仍 disabled；随后新测试成功才 enabled。
- `handleTest` 全程不调用 `save_settings`，只有“开始使用”保存；测试期间关闭向导不会写入旧 Key。
- 已有 Key 留空测试仍通过 fallback 使用当前平台钥匙串，不被空字符串覆盖。

### 6.4 最近文件降级后重新排序（F9）

涉及：`src/hooks/useRecentFiles.ts`、`src/hooks/useRecentFiles.test.ts`。

当前不仅淘汰错，展示也错：降级项在结果数组中位于保留固定项之后、普通未固定项之前；`RecentFilesBar` 分组渲染后，它出现在未固定区顶部，因此可能把 2020 年降级项排在 2025 年普通条目上方。

实施：

1. 先按 recency 保留前 10 个固定项。
2. 将超额固定项改为未固定，与普通未固定项合并。
3. 对合并后的未固定池重新按 `openedAt` 降序排序，再保留前 20 条。
4. 返回顺序仍为固定区在前、未固定区在后，未固定区内部严格按时间倒序。
5. 顺手消除同文件的约束冲突：`useRecentFiles.ts:94` 目前在 `setRecentFiles` updater 内调用 `saveRecentFiles`。改为用同步 ref 计算 next，在同一 tick 更新 ref/state，再在 updater 外保存；`clearRecentFiles` 同样维护 ref。本项只做副作用归位，不扩展成 recentFiles 写入队列重构。

测试：

- 11 个固定项 + 20 个普通项时，最旧的降级项先被淘汰，更新的普通项保留；未淘汰的降级项也按时间插回未固定区，而不是固定区末尾。
- StrictMode 下 add/remove/pin/updateLastPage 不重复执行保存副作用，既有纯固定、纯普通配额测试不回退。

### 6.5 追问输入框 IME 防护（F10）

涉及：`src/components/AiChatPanel.tsx`、`src/components/AiChatPanel.test.tsx`。

实施：在 `FollowUpInput` 的 Enter 分支增加 `!e.nativeEvent.isComposing`，与 `AskInput` 和 `CustomInterpretModal` 保持一致。

测试：组词中的 Enter 不发送、不清空；普通 Enter 发送，Shift+Enter 换行，流式期间 Enter 不触发发送或中止。

## 7. 验证方案

### 每个 PR 必跑

```bash
npm run type-check
npm run lint
npm run test
npm run format:check
```

PR2、PR3 另跑相关 E2E：

```bash
npx playwright test \
  e2e/multi-tab-state.spec.ts \
  e2e/pdf-split-view.spec.ts \
  e2e/pdf-interpret-stream.spec.ts \
  e2e/pdf-selection-translate.spec.ts
```

全部合入前运行：

```bash
npm run build
npm run test:all
```

### 手工验收场景

1. 连续编辑批注并立即关窗，重开后最后一条编辑存在。
2. 流式回答中快速追问/中止/重新解读，最新请求可中止，旧请求不修改新会话状态。
3. 同时通过系统事件打开两个指向同内容的不同路径，只出现一个 Tab。
4. 分屏点击左右两份 PDF 的解读标记，右侧都进入对应会话。
5. 中文输入法在追问框确认候选词，不发送消息。
6. 向导测试期间更改 Key，不会被旧结果放行。

## 8. 提交与回退策略

- PR1：持久化加载合并 + 按实体有序写入 + flush drain。
- PR2：流控制器身份保护 + Tab 串行提交去重。
- PR3：五项独立交互修复，可按文件拆 commit，但作为一个验证批次合入。
- 每个 PR 都可独立 revert；无 schema 迁移，无需数据回滚脚本。
- 任一既有持久化、Tab 休眠、分屏或流式测试出现回退，停止合入，先定位竞态是否由新队列引入，不用跳过测试方式通过门禁。

## 9. 审核时需要确认的决策

1. **初始加载采用合并而非禁用编辑**：推荐合并，保持 PDF 可读即可批注的现有体验；实施顺序在 F2/F3 之后。
2. **持久化采用按 hash/session 的细粒度队列**：推荐此方案，不做全局单队列，避免慢文件阻塞所有保存。
3. **flush 采用有界 best-effort**：以调用时 revisions 为目标，最多 2 轮 drain，接受关窗 3 秒上限，不设置无限等待的“绝对最新”验收口径。
4. **Tab 在 hash 计算后串行同步 commit**：推荐只在最终短临界区串行，内部禁止 `await`，且所有 Tab 写入路径同步维护 `tabsRef`，保留并发 I/O 性能。
5. **分屏会话展开复用 `expandSessionRequest`**：推荐复用现有 nonce 请求，移除 App 对主屏高亮状态的依赖，但保留 `AiChatPanel` 旧 prop，避免无关测试和 API 重构。
6. **向导测试不写设置**：推荐直接测试未保存参数，`handleStart` 唯一保存，不接受旧 Key 残留钥匙串的副作用。

若以上默认方案无异议，即可按 PR1 的 F2/F3 开始实施。

## 10. 实施结果

F1–F10 均已完成，正式回归测试已留存到 `usePersistence.test.tsx`、`useTabs.test.ts`、`App.test.tsx`、`useStreaming.test.tsx`、`useImageAttachments.test.tsx`、`useRecentFiles.test.ts`、`SetupWizard.test.tsx` 和 `AiChatPanel.test.tsx`。会话显式删除成功后也会清理 `savedSessionsRef` 中对应 id，避免旧快照驻留。

验证结果：

- 单元/集成测试：**69 个文件、812 个测试全部通过**。
- 完整 E2E：全部 spec 在 Chromium 与 WebKit 下共 **90 个测试全部通过**。
- `npm run type-check`、`npm run lint`、`npm run build` 通过；lint 保留 2 个与本次无关的既有 Hook 依赖警告。
- `npm run format:check` 仅被未改动的 `src-tauri/tauri.conf.json` 既有格式问题阻断；本次修改文件均通过 Prettier 和 `git diff --check`。
- 未执行需要真实桌面窗口和人工操作的手工验收场景，不以自动化测试替代打包后冒烟测试。
