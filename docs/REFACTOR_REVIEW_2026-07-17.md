# PDF 渲染重构 Review 报告（2026-07-17）

> 对象：`docs/REFACTOR_PLAN.md` 阶段 1–3 的全部改动（未提交工作区）。
> 方法：8 个新 hook/工具 + 5 个改动组件与 HEAD 原版逐段对比。
> 验证基线：type-check ✅ ｜ lint 0 error（6 warning）✅ ｜ 单测 299 ✅ ｜ E2E 32 ✅
> 状态：**全部问题已修复**（修复内容见各条「修复」小节）。

## 问题总览

| # | 问题 | 性质 | 严重度 | 状态 |
|---|------|------|--------|------|
| 1 | `ensureViewport` 提前翻转 `viewportsForScale` | 重构新引入 | 中 | ✅ 已修 |
| 2 | `goToPage` 闭包捕获过期 `scale` | 重构新引入 | 低 | ✅ 已修 |
| 3 | 缩放到达 MIN/MAX 边界后 `isZoomingRef` 卡死 + 滚动回跳 | 既有 bug 搬运 | 中 | ✅ 已修 |
| 4 | 当前激活 tab 的 `pendingGotoPage` 被 `hasRestoredRef` 屏蔽；跨 tab 跳转被旧 scrollTop 覆盖 | 既有 bug 搬运 | 中 | ✅ 已修 |
| 5 | `searchLoading` 卡在 true | 既有 bug 搬运 | 低 | ✅ 已修 |
| 6 | 渲染期写 ref ×3 处 | 代码气味 | 轻微 | ✅ 已修 |
| P1 | `setPageVisible` 无 bail-out，IO 回调全员重渲染 | 既有性能 | 中 | ✅ 已修 |
| P2 | `PdfPage` 未 memo，viewer 任何状态变化全页重渲染 | 既有性能 | 中 | ✅ 已修 |
| P3 | `loadPages` 串行 await，且取消即丢弃全部已加载页 | 既有性能 | 低 | ✅ 已修（并行化） |
| P4 | 滚动页码检测每事件 O(N) 次 `getBoundingClientRect` | 既有性能 | 低 | ✅ 已修 |
| P5 | 搜索索引全文档串行扫描（9.5） | 已知遗留 | — | ⏸ 按计划留待后续 |

---

## 1. `ensureViewport` 提前翻转 `viewportsForScale`（重构新引入，中）

`useViewportManager.ts` 的 `ensureViewport` 加载**单个页**后调用 `setViewportsForScale(scale)`，
把全局就绪标志置为当前 scale。但 `pageViewports` 按设计从不清空，其余条目可能仍是旧 scale。

**触发场景**：缩放（A→B）后、batch B 提交前点击「适合宽度」。ensureViewport 走加载分支并翻转标志：

- `useZoomAnchor` restore effect 的 `viewportsForScale === scale` 门控提前通过 → 在旧 scale 的
  DOM 上用新 scale 的数学恢复 scrollTop → 滚动位置错误，`isZoomingRef` 提前释放，锚点被消费，
  batch B 提交后不会再修正。
- fit-center effect 的 `viewportsReady` 门控同样提前通过 → 对着 stale `scrollWidth` 居中后
  `pendingFitCenterRef` 已被消费 → 页面停在偏移位置（10.3 症状在此竞态下回归）。

**修复**：`ensureViewport` 不再调用 `setViewportsForScale`（就绪标志只由整批提交置位）。
fitToWidth 直接使用返回的 entry，不依赖该标志。

## 2. `goToPage` 闭包捕获过期 `scale`（重构新引入，低）

`PdfViewer.tsx` 的 jump-lock 释放回调上报 `{ pageNum, scale, viewMode, scrollTop }`，但
`goToPage` 的 useCallback 依赖是 `[numPages, viewMode, pageViewports]`，`scale` 不在依赖里
（lint warning 617 行正好指向此）。缩放已开始、viewport batch 未提交的窗口内跳页，会把旧
scale 写回父级 tab 状态。

**修复**：`goToPage` 改用 `pageViewportsRef` / `scaleRef` 读取最新值，依赖收敛为
`[numPages, viewMode, pageWrapperRefs]`——既修了过期闭包，也让 goToPage 身份在缩放/滚动期间
稳定（为 P2 的 memo 铺路）。

## 3. 缩放边界（MIN/MAX）`isZoomingRef` 卡死 + 滚动回跳（既有 bug，中）

`useZoomAnchor.zoomTo` 用**未 clamp 的 target** 与当前 scale 比较。在 MAX_SCALE 时点 zoomIn：
`5.0 !== 5.5` → 捕获锚点 + `isZoomingRef=true` → setScale clamp 到 5.0 状态不变 → 不重渲染 →
restore effect 不触发 → **锁永不释放**，滚动页码同步被无限期抑制。wheel 路径同样：阈值一过
无条件置锁，即使 `applyStep` 在边界空转。

后续更糟：用户滚动 → IO 触发 preload 提交新 Map → restore effect 重跑 → 门控通过（scale 未变）
→ 用**过期锚点**把滚动位置拉回去。

原版逻辑完全相同（既有 bug），随重构顺手修复。

**修复**：

- `zoomTo` 先 clamp 再比较：`clamped !== scaleRef.current` 才捕获锚点 + 置锁。
- wheel 处理器在边界方向（`scale <= MIN && 缩小` / `scale >= MAX && 放大`）跳过锚点捕获与置锁。

## 4. `pendingGotoPage` 两处缺陷（既有 bug，中）

### 4a. 当前激活 tab 的 pending 跳转被永久屏蔽

`useTabRestore` effect 2 被 `hasRestoredRef.current` 挡在 mount 恢复之后。`gotoTabPage` 对
**当前已激活 tab** 设置 `pendingGotoPage` 时不触发 remount（key 不变），effect 1 只把值写进
ref，effect 2 因门控直接 return —— 连续模式下点击右侧面板指向当前 tab 的暂存/批注，页码输入
会变但**滚动不会发生**。（`PdfViewerHandle.goToPage` imperative 出口在 App 中无调用方。）

### 4b. 跨 tab 跳转被旧 scrollTop 覆盖

`gotoTabPage` 只改 `pageNum`/`pendingGotoPage`，保留旧 `scrollTop`。跨 tab 跳转 remount 后，
mount 恢复路径在 `goToPage(目标页)` 之后又 `scrollTop = 旧值` → ** snap 回该 tab 上次的阅读
位置**，跳转目标被覆盖。普通 tab 切换（`activateTab` 置 `pendingGotoPage = tab.pageNum`）则依赖
这个 scrollTop 恢复，两种共用一个分支。

**修复**：

- `useTabRestore` effect 2 重构：`pendingGotoPage` 不再受 `hasRestoredRef` 门控（mount 后新到
 达的 pending 跳转也执行），并把 `initialState?.pendingGotoPage` 加入依赖；scrollTop 恢复仍只在
 mount 后第一次生效（防止 re-run 把旧 scrollTop 盖回用户位置）。
- `useTabs.gotoTabPage` 同时清空 `scrollTop`（主动导航不应恢复旧阅读位置）；普通 tab 切换路径
 （`activateTab`）不受影响。

注：review 时另怀疑「大文档远距离 pending 跳转因 `pageViewports.has(pending)` 门控永不执行」，
经核实不可达——`pendingGotoPage` 的所有生产者（`gotoTabPage`/`activateTab`/`handleCloseTab`）
都令其等于 `tab.pageNum`，而预加载窗口必含 `pageNum`，无需额外处理。

## 5. `searchLoading` 卡在 true（既有 bug，低）

`useSearchDomain` 的早退分支（关闭搜索/清空 query）不重置 `searchLoading`；被取消的 build 在
`if (cancelled) return` 处直接返回，跳过 `setSearchLoading(false)`。搜索中清空关键词 → 加载
指示一直转圈。

**修复**：两个早退分支补 `setSearchLoading(false)`。

## 6. 渲染期写 ref ×3 处（轻微）

`PdfViewer.tsx`（`goToPageRef.current = goToPage`）、`usePdfDocument.ts`（`onPdfLoadedRef`）、
`useDrag.ts`（`onMoveRef`/`onEndRef`/`enabledRef`）在渲染函数体内写 ref。当前可工作，但违反
React 并发渲染约定。

**修复**：全部挪入 `useEffect` 同步。

---

## P1. `setPageVisible` 无 bail-out（既有性能，中）

IO 每次回调（阈值 0/0.25/0.5/0.75/1 间穿越）都 `new Set`，即使集合成员没变 → PdfViewer 整体
重渲染 + preload effect 重跑（取消并重发 batch）。

**修复**：成员未变化时返回原 Set 引用。

## P2. `PdfPage` 未 memo（既有性能，中）

`pageNum` 每变一次、viewport batch 每提交一次，全部 N 个 `PdfPage` 都重新 render。且
`pageViewports` 整 Map 作 prop + batch 每次重建 entry 对象，memo 也挡不住。

**修复**（组合拳）：

- `PdfPage` 改收单个 `pageViewport` entry（不再收整 Map）并 `React.memo`。
- `useViewportManager` 提交时按 width/height 去重：值未变的页保留旧 entry 对象（引用稳定），
 全 batch 无变化时返回原 Map（跳过一次整树渲染）。
- `goToPage` 身份稳定化（见 #2）。

效果：滚动翻页/IO 回调时，只有进入/离开渲染窗口的页重渲染。

## P3. `loadPages` 串行 await（既有性能，低）

50 页小文档逐页 `await getPage`；大文档滚动中 batch 频繁被取消时已加载页整条丢弃。

**修复**：改为 `Promise.all` 并行加载（窗口 ≤ 阈值，并发量可控）；取消时仍丢弃（防止旧 scale
写入，行为正确），但并行后 batch 时长大幅缩短，被取消概率显著降低。

## P4. 滚动页码检测 O(N) 次 DOM 读取（既有性能，低）

`useScrollPageSync.computeAndSyncPage` 每个 scroll 事件对全部页 wrapper 调
`getBoundingClientRect`。

**修复**：利用 `useViewportManager` 已有的 `pageVisibilityRatios`（此前只写不读），比率 ≤ 0
的页跳过 DOM 读取；未知页默认检查（冷启动正确）。jump/zoom 抑制窗口内比率可能过期，但此时
同步本就被锁，且 goToPage 已显式 setPageNum，风险可控。

## P5. 搜索索引全文档串行扫描（9.5，留待后续）

按 `REFACTOR_PLAN.md` 既定决策留待 useSearchDomain 后续迭代（分批索引：先可见页，再后台遍历）。
本次不动。

---

## 修复验证

- `npm run type-check` ✅
- `npm run lint` 0 error（PdfViewer 原有 3 个 exhaustive-deps warning 随修复消除）✅
- `npm run test` 全部通过（含新增用例：ensureViewport 不翻转就绪、边界缩放置锁、post-mount
  pending 跳转、setPageVisible bail-out、条目去重、searchLoading 重置）✅
- `npm run test:e2e` ✅
