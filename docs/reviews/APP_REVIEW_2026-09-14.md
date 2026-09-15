# 全面 Review 报告（2026-09-14）

范围：SpecReader AI v1.0.0 全栈审查——前端交互与状态管理、Rust 后端、LLM / Agent Tools 链路、Windows 平台适配、测试覆盖与质量、性能与资源、安全与隐私、产品完成度与文档一致性，共 8 个维度。**该产品目前只发布 Windows 版**，本报告含专门的 Windows 适配与发布就绪度评估。

方法：对照 `docs/reviews/CODE_REVIEW_2026-08-16.md` 逐条核实历史发现（已修复不重复报告，未修复标注「历史遗留」），其余为基于代码证据的新发现。严重级别：高 / 中 / 低。

测试基线（本机实测）：`type-check` 0 错误；`lint` 0 错误 2 警告（均为 react-hooks/exhaustive-deps）；前端单测 **58 文件 / 680 用例全绿**。

---

## 总体结论

代码质量处于健康水平。上一轮（2026-08-16）的 5 个高级别发现（H1–H5，流式中止挂起、悬空 toolCalls、翻译浮层卡死、休眠误伤 active tab、跳页监听器污染）**全部已修复且有回归测试**，「每个 bug 配回归测试」的文化保持得好。安全架构扎实：API Key 真正不落地前端、LLM 流量后端代理、CSP 主体收紧、updater 强制签名校验。

本轮**新增高严重级别发现 1 条**（W1 打印链路在中文用户名 Windows 机器上静默失效），新增中低危发现约 20 条；主要债务是**历史遗留修复率低**——上轮中级别发现约 30 条中大部分原样保留（后端 M-B 系列全部未修，前端 M-F 系列约 12 条未修）。

---

## 高严重级别（新发现）

### W1. Windows 打印链路：`cmd /c start` 的 `%var%` 扩展毁坏非 ASCII 用户名的文件 URL，打印打开静默失效

- 位置：`src-tauri/src/lib.rs:434-438`
- 问题：打印临时文件落在 `%APPDATA%\...\print\`，路径含 Windows 用户名。`Url::from_file_path` 把非 ASCII 用户名百分号编码为 `file:///C:/Users/%E5%BC%A0%E4%B8%89/...`，该字符串经 `cmd /c start "" microsoft-edge:<url>` 调起时，**cmd 对整条命令行做 `%var%` 变量扩展**（引号不豁免），`%E5%BC%A0...%` 被两两配对展开为空串，URL 变乱码，Edge 打开不存在的文件。`spawn` 本身成功，前端无报错——用户只看到 Edge 错误页，「用阅读器打开打印」静默失效（导出 PDF 是仅有退路）。
- 触发场景：Windows 用户名含中文/非 ASCII 字符（本产品目标用户群——国内检测认证工程师——并不罕见）的用户执行打印。
- 修复：去掉 cmd 中转，改走 ShellExecute 语义（如 `open::that(format!("microsoft-edge:{}", url))` 或 `rundll32 url.dll,FileProtocolHandler`）；建议用中文用户名账户实机验证。

---

## 中严重级别（新发现，按维度归纳）

### 前端交互

- **N1. 流式中的会话被原样落盘，重开后永久卡「生成中」**：关窗 flush（`App.tsx:671-707`）把带 `isStreaming:true` 的会话落盘，`loadSession`（`sessions.ts:261-270`）无复位逻辑，重开后面板气泡永远转圈、追问输入框永久禁用。与翻译批注已有的加载侧自愈（`annotations.ts:37-48`）对齐即可修复。
- **M-F3 从潜伏变为可触发**（历史遗留升级）：H1 修复后，中止旧 agent loop 立即追问时，旧 loop 迟到的收尾会误伤新 loop（`agentLoopAbortRef` 按 session.id 注册、`finishStreaming` 无条件清状态，`usePersistence.ts:597, 1044-1057`）。

### Rust 后端

- **B-N1. 词典解压校验失败后残留损坏文件，下载功能永久锁死**：`dictionary.rs:541` 先 rename 到正式路径再校验，校验失败不清理；此后 `download_dictionary`（:186-195）因文件存在直接返回成功，悬停翻译永久损坏且无 UI 自愈入口。修复为单行级清理。
- **B-N2. `export_text_file` / `export_binary_file` 是 webview 可达的任意路径任意内容写入**（`lib.rs:341-378`）：仅检查父目录存在，不校验路径来自系统保存对话框。与历史遗留 M-B9（任意授权读 PDF）、B-N9（`check_files_exist` 存在性探测）属同一威胁模型缺口，应一并确定 webview 威胁模型后收口（如限定扩展名白名单 + 拒绝 AppData 内部路径）。

### LLM / Agent Tools

- **T1. `search_in_pdf` 在被截断的页文本上搜索，密集页尾部匹配静默漏报**：`pdfTools.ts:54` 把每页文本截到 8000 字符，搜索复用截断文本（:320-336），漏报时模型会把「未找到」当权威结论断言给用户。修复：搜索用全文、仅返回给 `read_pdf_page` 时截断。
- **T2. 关 tab 不中断自由提问会话的流**：`usePersistence.ts:1825-1837` 的关联判定只看 sources，空 sources 的锚定会话漏判——签名里 `_fileHash` 未使用参数强烈暗示漏实现。流继续白烧 token 且后续工具调用全部失败。

### Windows 适配

- **W2. `webviewInstallMode: "skip"`，无 WebView2 的机器装完即死**（`tauri.conf.json:64-65`）：未预装 WebView2 的 Win10（LTSC、企业精简镜像）安装后启动失败且无引导。建议改 `embedBootstrapper`（离线可用，+约 2MB）。
- **W3. CI 无 Windows 目标，Windows-only 代码只在发版时才第一次被编译**（`ci-full.yml` 全部 ubuntu）：`#[cfg(target_os = "windows")]` 代码块（Edge 打印、`open_default_apps_settings`、single-instance 分支）从不参与 check/clippy/test。建议 CI 加 `cargo check --target x86_64-pc-windows-msvc`。
- **W4. updater endpoints 把 GitHub 排在 Gitee 前**：国内用户每次检查更新先等 GitHub 超时（`tauri.conf.json:72-75`），需验证当前 updater 版本的回退行为，考虑 Gitee 优先。

### 安全与隐私

- **S1. CSP `connect-src https:` 是纯多余授权，与「PDF 不上传云端」承诺相矛盾**（`tauri.conf.json:26`）：webview 没有任何需要外联的代码（LLM/词典/更新全在后端），任何 webview 内脚本执行都可向任意 HTTPS 端点外发 PDF 内容。删除 `https:` 即可。
- **S2. 自定义平台 baseUrl 无 scheme 校验**（`llm_proxy.rs:702`）：`http://` 下 API Key 与选中文本明文过网，界面无警告。后端发请求前校验 scheme（localhost 除外）。
- **S3. MarkdownRenderer 对全部元素放行 `style`/`className`**（历史遗留 M-F15，`MarkdownRenderer.tsx:78`）：恶意 PDF 可经提示注入让 LLM 输出覆盖全屏的伪造界面钓鱼；与 S1 叠加后钓到的内容可直接外发。

### 性能与资源

- **P1. 内存预算记账盲区：canvas 位图不计入**：`memoryBudget.ts` 只按 `Σ文件大小×2` 记账，但 keep-alive 下每个存活 tab 常驻可见窗口 canvas 位图（scale 1.5 + DPR 2 单页约 17MB），15 个存活 viewer 仅 canvas 就可达 750MB-1.3GB，远超预算线零记账。预算机制的核心承诺因此打折。建议把「存活 viewer 数 × 位图估算」并入 `projectUsage`。
- **P2. 前端零代码分割，1.9MB 单 chunk 全量随启动加载**：pdfjs、katex、pdf-lib、react-markdown 全部静态打进入口 chunk，首屏空 tab 并不需要它们。建议 pdfjs 与打印链路动态 `import()`。另 KaTeX 字体 woff/ttf 冗余打包约 1MB（低）。

### 测试

- **TS1. 测试把「保存吞错」缺陷固化为预期**：`annotations.test.ts:172-178` 直接断言 savePdfData 后端失败时静默 resolve，使 M-F1 的重试语义失效并被测试锁死。
- **TS2. SetupWizard 零测试**（历史 M-F12 仍存活：改 Key 不重置测试状态，可用未验证 Key 完成向导）；AGENTS.md §8.1 声称的 SetupWizard / updater 测试实际不存在。
- **TS3. E2E 缺口**：并排对照拖拽、全文搜索、解读/Agent Tools 流（Channel mock 已具备能力但未用）、条款链接悬停预览（fixture `sample-links.pdf` 已生成却闲置）、打印编排，五条用户主路径零端到端覆盖。

### 产品与文档

- **D1. 多份核心文档版本停留在 v0.9.11**：`AGENTS.md` §13、`docs/PRD.md` 头部、`docs/AGENT_TOOLS_DESIGN.md` 状态行均过时；PRD「最多同时打开 10 个文件」早已被内存预算休眠取代；README 的 spec/hook 数量与平台清单漂移。
- **D2. ShortcutsModal 把 PageUp/PageDown 标注为「上一页/下一页」**，实际是翻屏（90% 屏高），与 ←/→ 的按页跳转不同（`ShortcutsModal.tsx:35-37` vs `PdfViewer.tsx:589-594`）。

---

## 历史遗留未修复清单（2026-08-16 报告，本轮核实仍存在）

以下均有完整分析见 `docs/reviews/CODE_REVIEW_2026-08-16.md`，此处仅列编号与一句话摘要。**建议安排一个专门的「历史债务清理」迭代。**

后端（全部未修）：

| 编号 | 摘要 |
|---|---|
| M-B1 | 旧目录迁移非事务性，部分失败永久半迁移；symlink 中止拷贝 |
| M-B2 | atomic_write tmp 名跨扩展名碰撞；无 fsync |
| M-B3 | PDF hash 缓存 TOCTOU + mtime 粒度 → 批注键错位风险 |
| M-B4 | **300s 总超时覆盖整个流式 body，thinking 长解读被腰斩**（优先级最高） |
| M-B5 | Channel 发送失败被吞，前端断开后流跑到底白烧 token |
| M-B6 | 钥匙串旧 key 迁移先删后不确认写入，可永久丢 key |
| M-B7 | 词典 zip 大小校验在写盘后；206 不校验 Content-Range；sha256 常量为空 |
| M-B8 | 打印临时文件先删后写 + 异步竞态 |
| M-B9 | authorize_pdf_path 对 webview 完全信任（威胁模型待确认） |
| L-B1～L-B16 | 锁中毒 unwrap、settings 损坏无备份、request_id 冲突等 16 条低危 |

前端（M-F 系列约 12 条未修，抽要）：

| 编号 | 摘要 |
|---|---|
| M-F1 | savePdfData/saveSession 吞错 → 写盘失败静默丢数据，重试语义失效 |
| M-F2 | 删除进行中会话不 interrupt，白烧 token |
| M-F3 | 中止后立即追问的 loop 收尾竞态（H1 修复后变为可达，见上文） |
| M-F4 | 批量拖放并发 addTab 不做预算/去重串行化 |
| M-F5 | useRecentFiles 加载竞态覆盖在飞新增 |
| M-F6 | activateTab 无条件重写 pendingGotoPage，可取消在飞跳页 |
| M-F8 | canvas 位图无尺寸上限（MAX_SCALE 5 × 高 DPR 单页数百 MB） |
| M-F10 | 链接预览异步 resolve 不校验 hover 有效性 |
| M-F11/F12 | 设置页/向导改配置不重置测试状态 |
| M-F13 | 打印导出丢返回值，取消保存对话框连带关打印弹窗 |
| M-F16 | AiChatPanel 自动 tab 切换仍会把面板拽走 |
| M-F17 | 流式期间 50ms 合批持续重置 500ms 落盘防抖，崩溃丢整段回答 |

---

## Windows v1.0 发布就绪度评估

已就绪：一键发布流水线（门禁 → bump → changelog 固化 → tag → Windows 构建 → Draft Release → 人工冒烟 → Publish）；updater 双端点 + minisign 签名；单实例 + PDF 文件关联 + NSIS currentUser 免 UAC；680 前端单测 + 8 个 E2E + cargo test 的测试面；NSIS 产物与 Gitee 同步逻辑核对无误。

发布前建议处理/确认（按优先级）：

1. **W1 打印 cmd 扩展缺陷**——中文用户名用户打印必坏，且无任何报错提示。
2. **W2 WebView2 引导**——改 `embedBootstrapper` 或在 README/落地页明确系统要求；冒烟测试覆盖一台无 WebView2 的干净 Win10 虚拟机。
3. **W3 CI 加 Windows cargo check**——防止 Windows-only 代码到发版才暴露编译错误。
4. **代码签名缺失是有意决策**，但首批用户会遇 SmartScreen 拦截——落地页/Release notes 给安装指引。
5. 冒烟清单确认覆盖：自动更新链路（旧版→1.0）、文件关联双击打开、首次启动向导、中文用户名账户。
6. 文档版本号同步（D1）——1.0 是对外里程碑，AGENTS.md / PRD 应一致。

---

## 修复优先级建议

**P0（下一迭代必做）**
1. W1 打印链路去 cmd 中转（高，Windows 核心用户必踩）
2. M-B4 300s 流式总超时（历史遗留，thinking 长解读腰斩）
3. N1 流式会话落盘复位（中，用户可感知的永久卡死）
4. B-N1 词典校验残留锁死（中，单行级修复）

**P1（安全收口，小改动大收益）**
5. S1 CSP 删除 `connect-src https:`
6. S2 baseUrl 强制 https
7. B-N2 + M-B9 确定 webview 威胁模型，堵任意写/任意读口子
8. M-B6 钥匙串迁移丢 key

**P2（历史债务清理迭代）**
9. M-F1 + TS1 保存吞错（含翻转固化测试）
10. M-F3 loop 收尾竞态
11. T1 搜索截断漏报 / T2 关 tab 漏 interrupt
12. M-F17 流式期间周期性落盘
13. 后端 M-B1/B2/B3/B7/B8 与前端 M-F 其余项

**P3（工程基建）**
14. W2/W3/W4 Windows 打包与 CI
15. P1 内存预算记账扩展 / P2 代码分割
16. TS3 E2E 主路径补覆盖（并排对照 > 解读流 > 链接预览 > 搜索）
17. D1/D2 文档同步
