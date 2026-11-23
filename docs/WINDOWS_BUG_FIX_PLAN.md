# Windows 版已确认问题修复计划

> 范围：SpecReader AI v1.5.3，仅考虑 Windows 10/11 桌面版。本文只收录复核后仍有明确代码触发链的问题，不包含仅凭可能性推测的项。
>
> 验证边界：问题由源码与依赖实现复核确认；尚未在 Windows 实机上复现。第 W4、W5 项是特定退出时序下的数据丢失风险，并非每次操作必现。

## 1. 复核结论与优先级

| 编号 | 严重度 | 已确认问题                                     | 主要影响                         |
| ---- | ------ | ---------------------------------------------- | -------------------------------- |
| W1   | 高     | 会话读取失败后，后续保存会删除其 session id    | 会话文件仍在，但应用永久失去入口 |
| W2   | 高     | 栅格化打印遇到单页失败会静默跳过该页           | 输出 PDF 缺页且 UI 显示成功      |
| W3   | 中     | 矢量打印不补偿旋转页面坐标                     | 旋转页上的翻译/批注位置错误      |
| W4   | 中     | 更新重启不经过退出保存流程                     | 更新时可能丢失尚未落盘的数据     |
| W5   | 中     | 关窗不等待最近文件页码保存，且整表写入未串行化 | 最后阅读页码可能丢失或回退       |
| W6   | 中     | Windows 凭据删除失败被吞，UI 仍显示已清除      | API Key 实际保留，用户状态被误报 |
| W7   | 中     | 前端 Channel 断开后仍继续读取 LLM 流           | 异常断连后继续消耗计费和网络资源 |

实施顺序：**W1 → W2 → W5 → W4 → W3 → W6 → W7**。先阻止数据丢失和错误打印，再统一退出链路，最后处理平台错误与后端资源释放。

## 2. 分项修复方案

### W1：会话读取失败不得导致索引被覆盖

**证据与触发链**

- `src/services/sessions.ts:304`：`loadSession` 把不存在、JSON 损坏和读取错误统一转成 `null`。
- `src/hooks/usePersistence.ts:448`：加载后过滤所有 `null`。
- `src/hooks/usePersistence.ts:363`：后续保存仅根据内存中成功加载的会话重建 `sessionIds`。
- 主屏与副屏两条加载路径都有同样问题；并且当前在会话加载完成前就写入批注桶、设置 loaded 标记，因此只让 `loadSession` 抛错并不足以修复。

**修复设计**

1. 后端 `load_session` 改为返回 `Result<Option<InterpretationSession>, String>`：
   - 文件明确不存在时返回 `Ok(None)`，允许清理失效引用。
   - 文件存在但读取或解析失败时返回 `Err`，不得伪装成不存在。
2. 前端 `loadSession` 只在后端返回 `null` 时返回 `null`；invoke 失败必须 rethrow，并保留现有日志。
3. 重构 `usePersistence` 的主屏/副屏加载顺序：
   - 先在局部变量中读取 PDF 数据并等待全部会话结果。
   - 全部成功后才设置 loaded 标记、提交批注桶和会话列表。
   - 任一非缺失会话失败时，不提交部分结果，不标 loaded，不允许后续保存覆盖原 `sessionIds`。
   - 明确缺失的会话可按现有逻辑过滤；重开 tab 后可重试失败加载。
4. 主屏和副屏共用同一个加载辅助函数，避免两份实现再次漂移。

**回归测试**

- 一个 PDF 引用两个会话，其中一个读取失败：不得提交部分会话，不得调用 `save_pdf_data` 删除其 ID。
- 会话 JSON 损坏与文件不存在分别测试：前者阻断索引覆盖，后者返回 `null`。
- 主屏、副屏各覆盖一次；恢复读取后重开 tab 能正常加载。
- 更新 `src/services/sessions.test.ts`、`src/hooks/usePersistence.test.tsx` 和 `src-tauri/src/lib.rs` 中现有“后端抛错返回 null”的旧断言。

### W2：栅格化打印不得静默缺页

**证据与触发链**

- `src/services/printPdf.ts:242`：`rasterize.render(pageNum)` 返回 `null` 时直接 `continue`。
- `src/services/print.ts:63`、`:69`：Canvas 上下文或 JPEG 编码失败时确实返回 `null`。
- `PrintModal` 已能捕获 rejected Promise 并显示失败，因此无需新增另一套错误 UI。

**修复设计**

1. `buildRasterPdf` 遇到任一目标页返回 `null` 时立即抛出包含原页码的错误，不返回部分文档。
2. 保持现有页码顺序、批注叠加和成功路径不变。
3. 让原始错误继续进入 `PrintModal` 现有日志与 `print.failed` 提示；如需页码文案，在 `locales/zh-CN.json` 与 `en.json` 同步新增打印失败详情，不把英文技术错误直接展示给用户。

**回归测试**

- 在 `src/services/printPdf.test.ts` 注入第 2 页返回 `null` 的 rasterizer，断言 Promise reject，且错误包含页码 2。
- 覆盖第一页、最后一页失败，以及全部页面成功时输出页数不变。
- 在 `PrintModal` 测试中确认生成失败后弹窗不关闭、不调用成功后的关闭动作。

### W3：旋转页面使用已有栅格化兜底

**证据与触发链**

- 批注坐标来自已处理旋转的 pdf.js viewport。
- `src/services/printPdf.ts:175` 使用 pdf-lib 的未旋转页面尺寸，`:187` 直接做坐标翻转。
- `src/services/printPdf.ts:29` 已注明旋转页面未补偿。

**修复设计**

采用最低风险的正确性修复，不在本阶段手写旋转矩阵：

1. 矢量路径选定目标页后，检查每个页面的 `page.getRotation().angle`。
2. 只要任一目标页旋转角度非 0，就复用现有整页栅格化兜底；pdf.js 渲染会保留页面旋转，批注再按显示坐标叠加。
3. 非旋转文档继续走矢量路径，避免无关输出变化。
4. 删除“旋转页面暂不处理”的过时注释，说明现在的兜底策略。

**回归测试**

- 用 pdf-lib 生成 `/Rotate` 为 90°、180°、270° 的页面，确认这些文档进入 rasterizer。
- 普通 0° 文档仍走矢量路径。
- 对 90° 页面做渲染级断言：批注中心点与 pdf.js viewport 中的预期位置一致。
- 在 Windows 上用 Edge 打开导出文件，人工核对旋转页批注与 App 内显示一致。

### W5：最近文件保存串行化，并提供可等待的 flush

此项先于 W4 实施，使正常关窗和更新重启共用同一套可靠保存能力。

**证据与触发链**

- `src/hooks/useRecentFiles.ts:94`：每次变更 fire-and-forget 保存整份列表。
- `src/services/recentFiles.ts:28`：保存错误被吞，调用方无法等待或感知失败。
- `src/App.tsx:771`：退出时逐 tab 调用 `updateLastPage`，但只等待 `persistence.flushPendingSaves()`。
- 多个 tab 会产生多份并发整表快照，后端锁只能保证写入不损坏，不能保证较新的快照最后落盘。

**修复设计**

1. `saveRecentFiles` 改为失败后 rethrow，与 `savePdfData`/`saveSession` 一致。
2. `useRecentFiles` 内部增加保存 Promise 队列，所有新增、删除、置顶、清空和页码更新都按状态产生顺序入队；后一个快照必须等前一个写完后再写。
3. 用最新状态 ref 计算下一个快照，避免把异步保存作为 React state updater 的副作用；ref 同步更新，保证同拍连续操作不会读旧状态。
4. 每次入队时捕获并记录错误，保持队列后续可继续，不产生未处理 rejection。
5. 暴露 `recentFiles.flushPendingSaves(): Promise<void>`，等待当前队列及其之前已入队的操作全部完成。
6. App 退出流程先登记所有 tab 的最新页码，再同时等待：
   - `persistence.flushPendingSaves()`；
   - `recentFiles.flushPendingSaves()`。

**回归测试**

- 用 deferred Promise 阻塞第一次保存，连续更新两个 tab；断言后端写入顺序与操作顺序一致，最终快照包含两个最新页码。
- 关窗测试中，在最近文件 Promise 完成前不得调用 `win.destroy()`，完成后才允许销毁。
- 一次保存失败后，后续保存和 flush 仍能执行，且无 unhandled rejection。
- 覆盖 clear、pin、remove 与 lastPage 混合操作，防止只修退出路径。

### W4：更新下载前后都执行统一退出保存

**复核依据**

当前锁定的 `tauri-plugin-process 2.3.1` 的 restart 命令调用 `AppHandle::request_restart()`；它触发应用级 `RunEvent::ExitRequested`，不会经过前端注册的 `WebviewWindow.onCloseRequested`。因此现有 `src/App.tsx:797` 的关窗保存不能覆盖更新重启。

**修复设计**

1. 扩展 `src/services/updater.ts` 的 `installUpdate`，接收 `beforeExit: () => Promise<void>`。
2. 调用顺序固定为：
   1. 等待第一次 `beforeExit`，保护点击更新时已有的未保存数据；
   2. `downloadAndInstall()`；
   3. 再次等待 `beforeExit`，覆盖下载期间的新修改；
   4. `relaunch()`。
3. `beforeExit` 自身 reject（如超时或意外异常）时不得继续下载/重启，错误交给两个入口现有的安装失败处理；单项磁盘 I/O 错误维持现有记录与重试语义，不在本次顺带改动。
4. App 将当前 `flushOnExitRef.current()` 包装成稳定回调；启动更新弹窗直接复用，设置页通过新的 `onBeforeUpdate` prop 注入，避免 SettingsModal 反向依赖 persistence。
5. 不修改 NSIS 配置与 updater 签名流程。

**回归测试**

- 在 updater 单元测试中断言顺序为 `flush → download/install → flush → relaunch`。
- 第一次或第二次 flush 失败时，不得 relaunch；第二次失败时允许已经下载，但不能重启。
- App 测试分别覆盖启动更新弹窗和设置页入口都传入同一 flush。
- Windows 实机冒烟：更新下载期间新增批注/产生流式回答，重启后最后内容与会话引用均存在。

### W6：API Key 删除失败必须传播并保持 UI 原状

**证据与触发链**

- `src/services/settings.ts:332`：`deleteApiKey` 捕获错误后不抛。
- `src/components/SettingsModal.tsx:382`：调用方因此总会清空 draft 和平台已配置标记，自己的 catch 实际不可达。

**修复设计**

1. `deleteApiKey` 记录日志后 rethrow。
2. `SettingsModal.handleDeleteApiKey` 仅在 await 成功后清除本地状态；失败时保留 Key 配置标记和 draft。
3. 使用设置页现有错误区域显示明确失败提示；新增 `settings.deleteApiKeyFailed` 时同步更新中英文 locale。
4. 成功后行为不变，仍由现有保存/刷新链路更新标题栏状态。

**回归测试**

- `deleteApiKey` 在 invoke reject 时必须 reject。
- SettingsModal 模拟 Windows 凭据删除失败：显示错误、平台仍标记已配置，不错误清空状态。
- 删除成功路径保持现状。

### W7：Channel 发送失败立即终止 LLM 流

**证据与触发链**

`src-tauri/src/llm_proxy.rs` 中有 17 处 `on_event.send(...)`，结果全部被忽略。正常“中止”已有主动取消；本项只处理 WebView2 刷新/崩溃或 Channel receiver 提前释放的异常断连。

**修复设计**

1. 为 StreamEvent 发送增加统一辅助函数，发送失败返回明确的终止错误。
2. `parse_sse_line`、`flush_tool_calls` 和 `pump_sse_stream` 传播该终止信号；Channel 已关闭时不要再尝试发送 Error/Done。
3. 区分两类错误：
   - SSE JSON malformed：维持现有记录日志并继续；
   - Channel 发送失败：立即结束 pump，drop 响应流以关闭 HTTP 请求。
4. 保留 `chat_completions_stream` 末尾的 cancel token cleanup；提前终止也必须删除请求条目。
5. 成功后更新 `docs/BACKLOG.md`，移除或标记 M-B5 已修复。

**回归测试**

- 将事件 sink 抽象为可注入失败的发送闭包/trait，模拟第一次或中途发送失败，断言流立即停止读取后续 chunk。
- 验证正常 SSE、malformed SSE 和用户主动 cancel 的现有行为不变。
- 验证异常终止后 `cancel_tokens` 不再保留该 request id。
- Windows 开发构建中在流式回答期间刷新 WebView2，确认后端日志出现终止记录，网络请求不再继续。

## 3. 测试与交付门禁

### 自动测试

每完成一项先跑对应测试，再运行完整门禁：

```bash
npm run type-check
npm run lint
npm run test
cd src-tauri && cargo test
```

在 Windows runner/本机额外执行：

```powershell
cd src-tauri
cargo test --locked
```

将 `.github/workflows/ci-full.yml` 的 Windows job 从仅 `cargo check --locked` 扩展为同时运行 `cargo test --locked`，防止平台存储与原生分支只靠 Linux 测试推断。

### Windows 实机验收

1. 两个会话中故意损坏一个 JSON，修改另一批注后重启：损坏文件仍在，原 session id 不得被删除。
2. 模拟单页栅格失败：打印弹窗显示失败，不得打开或导出缺页 PDF。
3. 分别打开含 90°/180°/270° 页面的 PDF，打印后核对批注位置。
4. 打开多个 PDF，修改页码后立即关窗：重开最近文件，所有页码均恢复到最后位置。
5. 更新下载期间继续修改批注和会话：重启后最后修改仍存在。
6. 模拟 Credential Manager 删除失败：UI 必须显示失败，不得显示已清除。
7. 流式期间刷新 WebView2：后端应停止该请求，不继续消耗 token。

## 4. 完成标准

- 七项均有对应自动回归测试，且旧测试已按新错误语义更新。
- 完整前端与 Rust 测试通过，Windows `cargo test --locked` 通过。
- Windows 实机验收覆盖打印、退出、更新与凭据四条原生链路。
- 不改变 PDF 授权白名单、API Key 后端代理、NSIS 更新签名等既有安全边界。
