# AI 面板（AiChatPanel）使用逻辑评审与优化报告

> 评审对象：右侧 AI 面板本体（暂存区 / 会话列表 / 会话对话区 / 面板容器），并将 `REVIEW_解读与自定义解读优化建议.md` 的 P0 项（标记内联结果、选区直达自定义解读）一并纳入实施范围。
> 视角：日常阅读 IEC / ISO / GB 等标准、以「选中条款 → 理解 → 组合追问」为核心循环的检测认证工程师。
> 依据代码：`AiChatPanel.tsx` / `AiChatPanel.css` / `useRightPanelLayout.ts` / `usePersistence.ts` / `services/stash.ts` / `services/sessions.ts` / `services/llm.ts` / `App.tsx` 及旧评审文档。
> 状态：**已经产品负责人逐条确认**（见「一、已确认的设计决策」），本报告可作为实施依据。

---

## 一、已确认的设计决策

| # | 议题 | 结论 |
| --- | --- | --- |
| D1 | 未解读暂存不落盘 | **维持现状（有意设计）**。暂存区定位是「截取不同页面/位置的文本、合并后与 LLM 交互」的临时中转区，不是长期存储。 |
| D2 | 会话列表信息过简 | **改造**：列表项改为「页码 + 类型徽章 + LLM 生成的 summary」。 |
| D3 | 面板内删除会话 | **支持**。删除会话时连带删除 PDF 上对应的蓝色标记，两处保持一致。 |
| D4 | 自定义解读「默认全选」隐式行为 | **改造**：按钮常驻显示参与片段数量；解读要求弹窗内列出片段清单。 |
| D5 | 流式期间 Enter 被忽略 | **维持现状（有意设计）**。防止 Enter 误触发中止，不加 toast 提示。 |
| D6 | 旧文档 P0 项 | **纳入本次范围**：解读标记内联结果（与翻译弹层统一）、自定义解读选区直达。 |

---

## 二、总体判断

面板工程完成度高（流式、Agent Tools loop、自动滚动、双屏合并显示、暂存编辑同步标记均已具备），但目前更像「会话查看器」而非「工作台」：

- 会话列表无法区分会话（所有 explain 会话预览几乎相同），查找成本高；
- 会话在面板内不可删除、不可检索、不可回跳原文；
- 解读结果离阅读上下文远（需跳两次，旧文档核心结论）；
- 自定义解读链路步骤多、参与范围不透明。

---

## 三、P0 改造项

### P0-1 会话列表重构：页码 + 类型徽章 + LLM summary（D2）

- 现状：`session-item-prompt` 显示「最后一条 user 消息截断 80 字」（`AiChatPanel.tsx:548-573`）。explain 会话的 user 消息是 `llm.prompts.explain` 模板整段（`zh-CN.json:262`），**所有 explain 会话前 80 字几乎一致**，无法区分。
- 改造：
  1. `InterpretationSession` 新增 `summary?: string` 字段（`#[serde(default)]` 保持旧数据兼容；无 summary 的旧会话回退显示来源文本截断）。
  2. 首轮解读完成后，追加一次轻量 LLM 调用生成一句话 summary（或复用同一流末尾生成），写入 session 并落盘。需新增 i18n prompt 模板（`llm.summarizePrompt`，两边 locales 同步）。
  3. 列表项布局：`p.N` 页码徽章 + 类型徽章（解读 / 自定义解读，取 `session.action`）+ summary 文本；保留流式状态标识。
- 涉及：`services/sessions.ts`、`usePersistence.ts`（`runSessionStream` 收尾处）、`AiChatPanel.tsx`、`locales/*`、相关测试。

### P0-2 解读标记内联结果，与翻译弹层统一（旧文档 I1/U1/F1，D6）

- 现状：`TranslatePopup` 内联流式渲染翻译结果；`ExplainPopup` / `StashInterpretedPopup` 只显示原文 + 「查看解读 / 删除」，看结果需「标记 → 弹层 → 查看解读 → 面板」跳两次，且跳转后原文弹层被关闭、上下文丢失。生成中标记上无任何状态反馈。
- 改造：
  1. 抽取 `TranslatePopup` 的内联渲染骨架为可复用 `<InlineResultPopup>`（结果 Markdown / loading / error / 拖拽 / 操作区）。
  2. `ExplainPopup` 与 `StashInterpretedPopup` 改为其特化：直接展示解读结果（含流式/错误态）、原文折叠、「在面板中展开 / 追问」「重新解读」「删除」操作。
  3. 标记增加「生成中」态（呼吸/spinner），面板折叠时用户也能在阅读位置感知进度。
- 涉及：`components/TranslatePopup.tsx`、`ExplainPopup.tsx`、`StashInterpretedPopup.tsx`、`PdfAnnotations.tsx`、`AnnotationMarker.tsx` 及样式。

### P0-3 自定义解读选区直达 + 弹窗片段清单（旧文档 I2/U5，D4）

- 现状链路：选区 → 暂存 → 去面板 →（选择模式勾选）→ 自定义解读 → 填 prompt → 发送，≥5 步且跨左右两栏；未进选择模式时默认**全部暂存**参与（`AiChatPanel.tsx:157`），按钮不显示数量。
- 改造：
  1. 选区工具条（`SelectionToolbar`）增加「自定义解读」入口：直接调起解读要求弹窗，当前选区作为新片段预加入，与已有暂存合并供勾选。
  2. `CustomInterpretModal` 改为接收片段列表，内部渲染可勾选片段清单（文件名 / 页码 / 摘要），提交即发起——选择模式前置到弹窗内，面板侧的「选择」模式可相应简化或保留为多轮筛选入口。
  3. 面板「自定义解读」按钮常驻显示数量：`自定义解读（N 个片段）`。
- 涉及：`SelectionToolbar.tsx`、`CustomInterpretModal.tsx`、`AiChatPanel.tsx`、`App.tsx`（选区动作接线）、`usePersistence.ts`。

### P0-4 面板内删除会话（D3）

- 现状：session 列表项只有点击进入（`AiChatPanel.tsx:552-558`），删除唯一路径是回 PDF 找标记。
- 改造：会话列表项与会话详情头部加删除入口（hover 显示 / 两段式确认）；删除走既有 `handleAnnotationDelete` 级联逻辑（含磁盘 `deleteSessionOnDisk`），**同时删除 PDF 上的蓝色标记**，两处保持一致。
- 涉及：`AiChatPanel.tsx`、`usePersistence.ts`（抽出「按 session 删除」的独立入口，复用级联与确认框）。

---

## 四、P1 改造项

### P1-1 对话区 user 消息折叠 + 源片段卡片（旧文档 F7 方向一致）

- 现状：explain 的 user 气泡是整段模板 prompt；custom 的 user 气泡是「要求 + 全部片段原文拼接」。追问几轮后会话大半篇幅是重复原文。
- 改造：user 消息默认折叠为「要求摘要 + 源片段卡片列表」（文件名 / 页码 / 摘要，点击卡片跳转原文、展开查看全文）；assistant 原文不变。

### P1-2 会话回跳原文（旧文档 I5）

- 会话详情头部（现为返回箭头 + 来源文字）加「跳转原文」按钮；多源会话列出多个可点项。复用 `handleGotoStash` / `tabs.gotoTabPage` 已有能力。

### P1-3 消息复制 / 会话导出（旧文档 F6）

- assistant 消息 hover 显示「复制」按钮（`utils/clipboard.ts` 已有）；会话详情加「复制全部 / 导出 .md」。

### P1-4 「当前文档 / 全部」会话过滤（旧文档 U4）

- sessions tab 顶部加过滤切换。「全部」视图跨 fileHash 聚合当前已加载的会话，解决「刚才那条解读在哪个文档里」的找回问题；默认仍按当前可见 tab 过滤保持聚焦。

### P1-5 面板最小宽度

- `RIGHT_PANEL_MIN_WIDTH = 180`（`useRightPanelLayout.ts:5`）下会话气泡约 120px 宽，长解读不可读。提升到约 280px（暂存列表在窄宽度下仍可用，会话详情是宽度需求方）。

### P1-6 会话卡片信息层级

- 随 P0-1 一并落地：类型徽章、页码、summary、流式状态标识视觉强化（当前斜体「生成中」过弱）。

---

## 五、P2 / P3（记录，暂不实施或随主线顺带）

- **P2-1 新暂存无感知**：用户在 sessions tab 时新增暂存不切换、无角标；建议 tab 标签加未读圆点或短暂高亮。
- **P2-2 会话详情滚动位置不保留**：返回列表再进入时消息区重建、scrollTop 归零；长会话回读体验差。
- **P2-3 暂存排序**：按添加顺序；可选「按页码排序」更贴合条款阅读顺序。
- **P2-4 ContextWidget 上限引导**：接近 100% 时建议「另起会话」的轻提示（当前只显示百分比条，超限只能等 LLM 报错）。
- **P3-1 会话详情头部来源文字 `max-width:180px` 截断**（`AiChatPanel.css:44`），多源会话必省略且无 tooltip。
- **P3-2 深色主题**：颜色硬编码浅色，待主题规划时统一处理。

### 明确不做（有意设计，见 D1 / D5）

- 暂存持久化：不做。暂存区是临时中转区，重启/关 tab 丢弃符合定位。可在 UI 文案上强化「暂存为临时区」的心智（如空状态/清空确认文案，顺带即可）。
- 流式期间 Enter 提示：不做。保持忽略，防误触中止。

---

## 六、实施路径建议（按依赖排序）

1. **数据层先行**：`InterpretationSession` 加 `summary` 字段（serde 兼容）+ 按 session 删除的独立入口（`usePersistence.ts`）。
2. **P0-1 会话列表重构**：summary 生成调用、列表项 UI、徽章。
3. **P0-4 面板内删除会话**：依赖第 1 步入口。
4. **P0-3 自定义解读直达**：`CustomInterpretModal` 片段清单化 + `SelectionToolbar` 入口 + 按钮常驻数量。
5. **P0-2 标记内联结果**：抽 `<InlineResultPopup>`，两个 popup 特化，标记生成中态。改动面最大，独立成 PR。
6. **P1 各项**随主线顺带或后续迭代。

### 配套要求

- i18n：新增文案（summary prompt、徽章、按钮、确认框）需 `zh-CN.json` / `en.json` 两边同步。
- 数据兼容：`summary` 用 `#[serde(default)]` / 可选字段；旧会话无 summary 时回退显示来源摘要。
- 测试：
  - 单测：`sessions.ts` 序列化兼容、`usePersistence` 按 session 删除级联、summary 写回时机、`AiChatPanel` 列表项渲染、`CustomInterpretModal` 勾选逻辑。
  - E2E：可选补「面板内删除会话后标记同步消失」回归。
- 文档：实施后同步更新 `AGENTS.md` 第 1 章能力描述与第 6.4 节状态流、`TESTING.md`。

---

## 七、与旧评审文档的关系

`REVIEW_解读与自定义解读优化建议.md` 中：

- **纳入本次范围**：F1/I1/U1（标记内联结果，→ P0-2）、I2/U5（选区直达 + 弹窗片段清单，→ P0-3）、I4（生成中态，→ P0-2 子项）、U3（会话卡片，→ P0-1/P1-6）。
- **并入 P1**：F6（复制/导出 → P1-3）、F7（源片段卡片 → P1-1）、I5（回跳原文 → P1-2）、U4（全部会话视图 → P1-4）。
- **本次不实施，留待后续**：F2（保留源暂存，与 D4 弹窗清单方案部分冲突，待 P0-3 落地后重评）、F3（整页/整节解读）、F4（重复解读幂等）、F5（快捷指令模板）、F8（笔记/知识库）、I3（选择模式预览，将被 P0-3 弹窗清单取代）、I6（Enter 提示，D5 明确不做）、I7（删除级联选项）、U2（标记视觉区分，部分随 P0-2 自然解决）、U6/U7。
