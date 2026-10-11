# 全面 Review 报告（2026-09-14）· 精简归档版

> 原文为 v1.0.0 发布前的 8 维度全栈审查（155 行）。2026-10-11 文档清理时精简为本归档版：保留结论与事项清单的当前状态，逐条分析已删除（完整原文见 git 历史）。确认仍未修复的项已抄至 `docs/BACKLOG.md`。
>
> 状态标记：✅ 已修复（2026-10-11 抽查核实，多数有回归测试）/ ❌ 仍开 / ❓ 未逐条核实。

## 总体结论（2026-09-14）

代码质量健康；上一轮（2026-08-16）的 5 个高级别发现（H1–H5：流式中止挂起、悬空 toolCalls、翻译浮层卡死、休眠误伤 active tab、跳页监听器污染）全部已修复且有回归测试。本轮新增高危 1 条（W1 中文用户名 Windows 打印静默失效）、中低危约 20 条。

## Windows v1.0 发布就绪度结论（2026-09-14）

已就绪：一键发布流水线、updater 双端点 + minisign 签名、单实例 + 文件关联、测试面。发布前需处理 W1 / W2 / W3 并冒烟验证（自动更新链路、文件关联、首启向导、中文用户名账户）。→ v1.0.0 已发布，上述项均已落地。

## 事项清单与状态

### 本轮新发现（2026-09-14）

| 编号 | 摘要 | 状态 |
| --- | --- | --- |
| W1 | Windows 打印 `cmd /c start` 的 `%var%` 扩展毁坏非 ASCII 用户名 URL | ✅ rundll32 方案 + 回归测试 |
| W2 | `webviewInstallMode: skip`，无 WebView2 机器装完即死 | ✅ 改 `embedBootstrapper` |
| W3 | CI 无 Windows 目标，Windows-only 代码发版才首编译 | ✅ ci-full 含 Windows cargo check |
| W4 | updater endpoints GitHub 优先于 Gitee | ✅ Gitee 优先 |
| N1 | 流式中的会话原样落盘，重开后永久卡「生成中」 | ✅ `sanitizeLoadedSession` 加载自愈 |
| B-N1 | 词典解压校验失败残留损坏文件，下载永久锁死 | ✅ `remove_corrupt_dict_file` |
| B-N2 | `export_*_file` 是 webview 可达的任意路径写 | ✅ 扩展名白名单 + 拒绝 AppData 路径 |
| T1 | `search_in_pdf` 在截断页文本上搜索，密集页尾部漏报 | ✅ 搜索用全文，仅返回给模型时截断 |
| T2 | 关 tab 不中断空 sources 自由提问会话的流 | ✅ 锚点 hash 判定关流 |
| S1 | CSP `connect-src https:` 多余授权 | ✅ 已删除 |
| S2 | 自定义平台 baseUrl 无 scheme 校验 | ✅ 强制 https，仅放行 localhost |
| S3 | MarkdownRenderer 对全部元素放行 `style`/`className` | ❓ 未核实 |
| P1 | 内存预算不计 canvas 位图 | ✅ `BITMAP_BYTES_PER_ALIVE_VIEWER` |
| P2 | 前端零代码分割 | ✅ 部分（pdfjs 已懒加载拆 chunk） |
| TS1–TS3 | 测试固化吞错 / SetupWizard 零测试 / E2E 主路径缺口 | ✅ E2E 已扩至 13 个 spec |
| D1 / D2 | 文档版本漂移 / ShortcutsModal PageUp/Down 标注不准 | ✅ / ❓（D1 随 2026-10-11 清理收口） |

### 历史遗留（源自 2026-08-16 评审）

| 编号 | 摘要 | 状态 |
| --- | --- | --- |
| M-B1 | 旧目录迁移非事务性 | ✅ 事务化迁移 |
| M-B2 | `atomic_write` tmp 名碰撞 / 无 fsync | ✅ pid+seq 命名 + fsync |
| M-B3 | PDF hash 缓存 TOCTOU | ✅ 读后复核快照 |
| M-B4 | 300s 总超时覆盖整个流式 body，长解读腰斩 | ✅ `connect_timeout` 取代总超时 |
| M-B5 | Channel 发送失败被吞，断连后白烧 token | ❌ 仍开 → `docs/BACKLOG.md` |
| M-B6 | 钥匙串旧 key 迁移先删后不确认写入 | ✅ 确认写入成功后才删旧条目 |
| M-B7 | zip 大小校验滞后 / 206 不校验 Content-Range / sha256 为空 | ⚠️ 部分：sha256 常量仍空 → `docs/BACKLOG.md` |
| M-B8 | 打印临时文件先删后写 + 异步竞态 | ✅ 纳秒+序号命名，10 分钟宽限清理 |
| M-B9 | `authorize_pdf_path` 对 webview 完全信任（威胁模型决策项） | ❓ 未核实 |
| M-F1 | `savePdfData`/`saveSession` 吞错 | ✅ 改 rethrow + 测试翻转 |
| M-F8 | canvas 位图无尺寸上限 | ✅ `MAX_CANVAS_PIXELS` |
| M-F2～F7、F10～F17 | 删除不 interrupt、loop 收尾竞态、加载竞态等约 10 条 | ❓ 未逐条核实 |
| L-B1～L-B16 | 锁中毒 unwrap、settings 损坏无备份等 16 条低危 | ❓ 未逐条核实 |
