# Backlog（未修复项与产品建议）

> 整理自历史评审文档（原 `docs/reviews/` 与 `docs/REVIEW_*.md`，已于 2026-10-11 文档清理时删除或精简归档；完整分析可查 git 历史）。本文件只收录当时提出且至今未落地的条目，已修复项不再保留。

## 确认未修复的工程项（2026-10-11 核实仍存在）

### 1. LLM 流 Channel 发送失败被吞，前端断开后白烧 token（原编号 M-B5）

- 位置：`src-tauri/src/llm_proxy.rs`（所有 `let _ = on_event.send(...)` 调用点）。
- 问题：webview 刷新/关闭/前端主动放弃后，Channel receiver 已 drop，`send` 持续失败但后端无感知，继续把整条流（含计费 token）跑完，`cancel_tokens` 条目也要等流自然结束才清理。
- 触发场景：流式过程中 webview 崩溃重载、前端侧提前 drop channel。
- 修复方向：在 SSE 解析/泵送循环中检测 `send` 返回 `Err`，直接终止循环并走 cleanup。

### 2. 词典下载 sha256 完整性校验未启用（原编号 M-B7 残余）

- 位置：`src-tauri/src/dictionary.rs` 顶部——两个 sha256 校验常量均为空串，完整性校验实际跳过（解压防 zip 炸弹的大小上限校验仍在）。
- 修复方向：填入 ECDICT 发布包的 sha256 常量。

## 未实施的产品建议

### 3. 首启隐私告知（PRD §9.3 明确要求）

- 首次启动向导应明确告知「选中的文本会发送给第三方 LLM」，需用户同意。标准文件常涉客户保密项目，敏感度高；当前 SetupWizard 只字未提。

### 4. 整页 / 整节解读入口（原 REVIEW_解读 F3）

- 目前解读只能从选中文本发起；对排版密集的标准条款，「解读当前页 / 当前章节」是高频诉求，SelectionToolbar 尚无此入口。
