# SpecReader AI — PDF 渲染架构重构方案

> 状态：**阶段 1 完成 ✅ ｜ 阶段 2 完成 ✅ ｜ 阶段 3 核心完成 ✅（usePdfDocument/useZoomAnchor/useViewportManager/useScrollPageSync/useTabRestore 已抽出）｜ Review 修复完成 ✅（2026-07-17）**
> 生成日期：2026-07-16 ｜ 最后更新：2026-07-17
> 关联：`docs/PDF_RENDERING_AND_OVERLAYS.md` 第 9、10 节问题清单；`docs/REFACTOR_REVIEW_2026-07-17.md` Review 报告
> 目标：在修复 9/10 节问题的同时优化架构，让后续开发更顺畅

## 进度

- [x] **阶段 1 基础设施层**（已完成）：新增 `coordinateConverter.ts`/`useDrag.ts` + 单测；扩展 `useClampedPopupPosition` 支持 `yPercent`；WordTooltip 接入 clamp；TranslatePopup/AnnotationMarker 接入 useDrag；fit-center 加就绪门控；删 PdfPage 命令式写入。修复 9.2 / 9.3 / 10.3 / 10.4。
- [x] **阶段 2 领域层**（完成）：`useSearchDomain`（修 9.1/9.6/10.2/9.9）、`useZoomAnchor`（架构收敛）、`useViewportManager`（修 9.4）已完成并接入。**10.1** 通过最小修复已解决。阶段 2 实际修复 6 项（9.1/9.4/9.6/9.9/10.1/10.2）。9.5 留 useSearchDomain 后续优化。
- [x] **阶段 3 协调层薄化**（核心完成）：7 个领域 hook 已抽出 — `usePdfDocument`、`useSearchDomain`、`useZoomAnchor`、`useViewportManager`、`useScrollPageSync`、`useTabRestore`。PdfViewer 1652→1228 行（-424，-26%）。剩余职责：goToPage、keydown/wheel effect、input handlers、toolbar UI、PdfPage 渲染 props 透传。`<300 行` 目标经评估不现实（main JSX 本身 ~365 行）；务实状态为「核心状态逻辑全外移，PdfViewer 剩 UI + 协调」。
- [x] **Review 修复**（2026-07-17，见 `REFACTOR_REVIEW_2026-07-17.md`）：修复 Review 发现的 6 项 bug（ensureViewport 误翻就绪标志、goToPage 过期 scale 闭包、缩放边界 isZooming 锁死、激活 tab pendingGotoPage 屏蔽 + 跨 tab 跳转被旧 scrollTop 覆盖、searchLoading 卡死、渲染期写 ref）与 4 项性能问题（setPageVisible bail-out、PdfPage memo + 单条目 prop、loadPages 并行化、滚动同步跳过离屏页 DOM 读取）。验证：type-check + lint 0 error + 单测 306 + E2E 32 全过。

## 当前已修复问题（10 项）

| 问题 | 阶段 | 措施 |
|------|------|------|
| 9.1 / 9.6 搜索高亮缩放错位 | 2 | useSearchDomain 存 PDF 原始坐标 |
| 9.2 WordTooltip 无 clamp | 1 | useClampedPopupPosition 接入 |
| 9.3 命令式 wrapper.style | 1 | 删除 |
| 9.4 fitToWidth 大文档无反馈 | 2 | useViewportManager.ensureViewport 按需加载 |
| 9.9 scrollTop 竞争 | 2 | useSearchDomain 去 goToPage 依赖 |
| 10.1 tab 切换重置首页 | 2 | scroll 即时 setPageNum（现 useScrollPageSync）|
| 10.2 搜索翻页拉回 | 2 | useSearchDomain goToPageRef |
| 10.3 fitToWidth 横向偏移 | 1 | fit-center 加 viewportsForScale 门控 |
| 10.4 拖拽不灵活 | 1 | useDrag 全局监听 |

未修复：9.5（搜索大文档分页，留 useSearchDomain 后续优化）、9.7（文档过时，待统一更新）、9.8（部分，useDrag 每帧 onMove）、9.10（Info 无害）。

## 后续续做指引（暂停点）

### 当前代码状态
- 所有改动已通过 type-check + lint 0 error + 全量单测 298 + E2E 30。
- 新增 8 个 hook/工具（各带单测）：`coordinateConverter.ts`、`useDrag.ts`、`useSearchDomain.ts`、`usePdfDocument.ts`、`useZoomAnchor.ts`、`useViewportManager.ts`、`useScrollPageSync.ts`、`useTabRestore.ts`。
- PdfViewer 1228 行，剩余职责：goToPage（67行）、keydown effect（92行）、wheel effect（60行）、input handlers（69行）、fitToWidth（37行）、handleOutlineClick、main JSX（~365行）。

### 阶段 3 本轮完成（useScrollPageSync + useTabRestore，2026-07-16）
- **useScrollPageSync**（164 行 + 7 测试）：接管 scroll sync effect（监听 scroll/resize，computeAndSyncPage 即时 setPageNum，debounce 100ms 上报 scrollTop）。入参含 isJumpingRef/isZoomingRef 抑制。goToPage 留 PdfViewer（与 pageViewports 紧密）。
- **useTabRestore**（157 行 + 8 测试）：接管 tab sync effect（initialState 变化同步 pageNum/scale/viewMode）+ pendingGotoPage effect（pdf 就绪后执行 pending 跳转 + 恢复 scrollTop）。pendingGotoPageRef/pendingScrollTopRef/hasRestoredRef 移入 hook。`hasRestoredRef` 保证每 mount 只恢复一次。
- PdfViewer 1354→1228 行（-126）。验证：useScrollPageSync 7 + useTabRestore 8 测试 + 全量单测 298 + E2E 30 全过。
- **`<300 行` 评估**：经分析 main JSX（toolbar + PdfPage 渲染）本身约 365 行，加上 input handlers/outline/快捷键，PdfViewer 即使抽尽所有 effect 也难低于 ~600 行。故 `<300 行` 目标调整为「核心状态逻辑全外移至 hook，PdfViewer 仅剩 UI + 协调」，当前已达成此务实目标。

### 9.5 判定（留后续）
useSearchDomain 用 `pdf.getPage().getViewport({scale:1})` + `getTextContent()` 构建索引，不依赖外部 pageViewports。9.5「搜索大文档分页」实际是搜索索引遍历所有页 `getTextContent` 的慢操作，属 useSearchDomain 内部优化（分批/懒加载），非 viewport 职责。留待 useSearchDomain 后续迭代。

### 后续可选优化（非必须）
- 9.5：useSearchDomain 分批索引（先可见页，再后台遍历其余）
- 9.8：useDrag 松手一次提交（当前每帧 onMove，已流畅）
- CoordinateConverter 调用点迁移（已建工具但调用点未全替换）
- goToPage 可考虑并入 useScrollPageSync（与 isJumpingRef/scroll 协调紧密），但会增加 hook 对 pageViewports 的耦合

### 务实调整记录
- 未新建薄 `useReadyViewports`/`useOverlayPosition`：门控直接加在 fit-center effect（现用 viewportsReady），`useOverlayPosition` 概念由增强后的 `useClampedPopupPosition`（支持 `yPercent`）承担。
- `CoordinateConverter` 已建但调用点迁移留后续（纯新增不影响）。
- 9.8「松手一次提交」未完全实现（useDrag 仍每帧 onMove），留作后续优化。
- 10.1 用最小修复（scroll 即时 setPageNum，现 useScrollPageSync 承接）而非完整重构，行为已正确。
- **#14 useZoomAnchor**：用 `scaleRef`/`onRestoredRef` 解耦回调重建。
- **#13 useViewportManager**：`ensureViewport` 用 `inFlightRef` 去重并发加载；`loadPages` 内部方法被预加载 effect 和 ensureViewport 共享；`pageViewports` 不清空策略保留。
- **阶段 3 useScrollPageSync/useTabRestore**：goToPage 留 PdfViewer（与 pageViewports/computeContinuousScrollTop 紧密），useTabRestore 在 goToPage 定义后调用；`<300 行` 目标调整为「核心状态逻辑全外移」。

---

## 1. 背景与目标

### 1.1 现状量化

`PdfViewer.tsx` 已成为「上帝组件」：

| 指标 | 数值 |
|------|------|
| 文件行数 | 1735 |
| React hooks 总数 | 80（21 useState + 20 useEffect + 23 useRef + 13 useCallback + 3 useMemo） |
| 承担职责 | 8 项（PDF 加载 / viewport 预加载 / 缩放锚点 / 搜索 / 滚动同步 / tab 恢复 / 选区 / 大纲） |

`PdfPage.tsx` 684 行，分层渲染 + 选区 + 链接 + 词典取词混在一起，但复杂度可控，本次不作为拆分重点。

### 1.2 核心病灶

9/10 节的多数问题不是单点 bug，而是同一架构病灶的不同症状：

- **A1 上帝组件**：8 项职责挤在 PdfViewer，状态耦合严重。
- **A2 effect 链耦合**：20 个 effect 互为依赖，`scale`/翻页/缩放任一变化触发多链反应 → 10.2 拉回循环、10.1 时序竞争。
- **A3 定位/拖拽散落**：clamp 仅 3 个 popup 接入（WordTooltip 漏 → 9.2）；拖拽两处各写一份（10.4）；无统一抽象。
- **A4 领域状态混入渲染状态**：searchMatches 存 wrapper 坐标（scale 相关）→ 9.1/9.6。
- **A5 状态恢复脆弱**：scrollTop 在 4 处上报；`viewportsForScale===scale` 门控散布且 fit-center 漏 → 10.1/10.3。
- **A6 坐标系无统一抽象**：PDF↔wrapper↔screen 转换散落 6+ 处 `×scale`。

> 关键洞察：10.2（搜索拉回）不是单个 effect 写错，而是「状态驱动 + useCallback 依赖」模式在 effect 链复杂时的固有脆弱性。局部止血可行，但只要 effect 链还在，同类问题会持续涌现。

### 1.3 目标架构

三层分层（详见 `PDF_RENDERING_AND_OVERLAYS.md` 配图）：

```
协调层   PdfViewer（<300 行，组合 hooks + 渲染 page wrappers）
   │
领域层   usePdfDocument · useViewportManager · useZoomAnchor
         useSearchDomain · useScrollPageSync · useTabRestore
   │
基础设施 useOverlayPosition · useDrag · CoordinateConverter · useReadyViewports
```

### 1.4 重构原则

1. **行为不变**：重构期间用户可见行为不变，纯函数单测（popupPosition/zoomAnchor/fitToWidth）是安全网。
2. **渐进式**：分 3 阶段，每阶段独立可验证、可回滚，结束跑全量单测 + E2E。
3. **先低风险后高风险**：基础设施层（新增独立 hook）→ 领域层（整体替换）→ 协调层薄化。
4. **每步小提交**：一个 hook 一个提交，便于 review 与回滚。

---

## 2. 阶段 1：基础设施层（低风险止血）

> 新增 4 个独立 hook/工具，逐个接入现有组件。修 9.2 / 9.3 / 10.4 / 9.8。不改动 PdfViewer 主结构。

### 2.1 `useOverlayPosition`（统一浮层定位）

**职责**：在 `useClampedPopupPosition` 基础上封装「强制 clamp + transform 规格统一 + z-index 约定」，所有页内浮层统一接入。

```ts
// src/hooks/useOverlayPosition.ts
interface OverlayTransform { xPercent: number; yPx: number }
interface UseOverlayPositionOptions {
  anchor: { x: number; y: number }      // wrapper 内坐标（已 ×scale）
  transform?: OverlayTransform          // 默认 { xPercent: -50, yPx: 12 }
  extraDeps?: React.DependencyList      // 内容变化时重算（如流式文本）
}
interface UseOverlayPositionResult {
  popupRef: React.RefObject<HTMLDivElement | null>
  pos: { x: number; y: number }
}
export function useOverlayPosition(
  options: UseOverlayPositionOptions
): UseOverlayPositionResult
```

**迁移点**：
- `TranslatePopup.tsx:52-58` → `useOverlayPosition({ anchor: { left, top }, extraDeps: [localContent, isStreaming] })`
- `ExplainPopup.tsx:29` → 同上
- `StashInterpretedPopup.tsx:27` → 同上
- `WordTooltip.tsx` → **新增接入**（修 9.2）：tooltip 的 transform 是 `translate(-50%,-100%)`，需传 `{ xPercent: -50, yPx: -100? }` 或支持百分比 y（扩展 `OverlayTransform` 支持 `yPercent`）

**顺带修复**：
- 9.2 WordTooltip 无 clamp
- 9.3 命令式 `wrapper.style`（与 clamp 无关，但本次清理 PdfPage render effect 187-188 的命令式写入）

**验收**：
- 所有页内浮层（translate/explain/stash/tooltip）边界不溢出 wrapper
- 边缘单词 tooltip 不被 `overflow:auto` 裁切

**回归测试**：`popupPosition.test.ts`（不变）；`useClampedPopupPosition` 接线测试保持；新增 `useOverlayPosition` 边缘用例（顶部/左侧/右侧/底部单词）。

### 2.2 `useDrag`（统一拖拽，全局监听）

**职责**：封装全局 `mousemove`/`mouseup` 监听 + 移动阈值 + 增量回调，替代各组件手写拖拽。

```ts
// src/hooks/useDrag.ts
interface UseDragOptions {
  onMove: (dx: number, dy: number) => void
  onEnd?: () => void
  threshold?: number           // 触发拖动的最小位移，默认 2
  enabled?: boolean            // 默认 true
}
interface UseDragResult {
  isDragging: boolean
  handlers: { onMouseDown: (e: React.MouseEvent) => void }
}
export function useDrag(options: UseDragOptions): UseDragResult
```

**实现要点**：`onMouseDown` 时 `window.addEventListener('mousemove'/'mouseup')`，松手或 `enabled=false` 时移除。彻底解决「鼠标移出元素丢失事件」。

**迁移点**：
- `TranslatePopup.tsx:127-159`（header mousedown + body move/up）→ header 绑 `handlers.onMouseDown`，移除 body 的 move/up/leave
- `AnnotationMarker.tsx:70-100` → 同上

**顺带修复**：
- 10.4 translation 拖拽不灵活/拖不动
- 9.8 拖动每帧 setState（`useDrag` 可内置「拖动中本地累积、松手一次性提交」模式，由 `onEnd` 触发落盘）

**验收**：
- 在 header 任意位置按下并拖动，popup 平滑跟随
- 鼠标移出 popup 后仍可继续拖动，松手才停
- 拖动结束后 position 持久化一次（非每帧）

**回归测试**：新增 `useDrag.test.ts`（mock window 事件）；`AnnotationMarker.test.tsx`/`TranslatePopup.test.tsx` 拖拽用例。

### 2.3 `CoordinateConverter`（坐标转换收敛）

**职责**：把散落的 `×scale` / `/scale` 收敛为统一转换器，消除隐式坐标假设。

```ts
// src/utils/coordinateConverter.ts
export class CoordinateConverter {
  constructor(private scale: number) {}
  /** PDF 原始 → wrapper 内（渲染用） */
  pdfToWrapper(p: { x: number; y: number }): { x: number; y: number }
  /** wrapper 内 → PDF 原始（持久化用） */
  wrapperToPdf(p: { x: number; y: number }): { x: number; y: number }
  /** 屏幕 client → wrapper 内 */
  clientToWrapper(clientX: number, clientY: number, rect: DOMRect): { x: number; y: number }
  /** 屏幕 client → PDF 原始 */
  clientToPdf(clientX: number, clientY: number, rect: DOMRect): { x: number; y: number }
}
// 或导出纯函数版本，便于单测
```

**迁移点**：
- `PdfPage.tsx:561-566`（`pdfX = (clientX - rect.left) / scale`）→ `converter.clientToPdf`
- `AnnotationMarker.tsx:60-61`（`left = position.x * scale`）→ `converter.pdfToWrapper`
- `TranslatePopup.tsx:45-46`、`ExplainPopup.tsx:25-26`、`StashInterpretedPopup.tsx:25-26` → 同上
- `PdfAnnotations.tsx:70-78`（`dx / scale`）→ `converter.wrapperToPdf` 增量

**验收**：行为不变（纯重构），代码中 `* scale` / `/ scale` 字面量减少。

**回归测试**：新增 `coordinateConverter.test.ts`；现有接线测试不变。

### 2.4 `useReadyViewports`（就绪门控收敛）

**职责**：把 `viewportsForScale === scale` 门控收敛成单一 hook，消除 fit-center 漏判（10.3）。

```ts
// src/hooks/useReadyViewports.ts
interface UseReadyViewportsResult {
  pageViewports: Map<number, PageViewportInfo>
  isReady: boolean              // viewportsForScale === scale
  viewportsForScale: number
}
export function useReadyViewports(
  scale: number,
  pageViewports: Map<number, PageViewportInfo>,
  viewportsForScale: number
): UseReadyViewportsResult
```

**迁移点**：
- `PdfViewer.tsx:1212`（zoom restore effect `if (viewportsForScale !== scale) return`）→ `if (!isReady) return`
- `PdfViewer.tsx:320-332`（fit-center effect）→ **新增 `if (!isReady) return` 门控**（修 10.3）
- `PdfViewer.tsx:1271`（fitToWidth 用 `entryScale: viewportsForScale`）→ 保持

**顺带修复**：10.3 适合宽度后横向偏移。

**验收**：fitToWidth 后页面横向居中，无偏移；缩放过渡期不提前居中。

**回归测试**：`fitToWidth.test.ts`；新增「viewport 未就绪时不居中」用例。

### 2.5 阶段 1 验收清单

- [ ] 4 个新 hook/工具各自单测通过
- [ ] 现有纯函数单测全绿
- [ ] 前端单测（`npm run test`）全绿
- [ ] E2E（`npm run test:e2e`）布局/翻页/缩放用例全绿
- [ ] 手测：边缘单词 tooltip 不裁切、translation 拖动流畅、fitToWidth 居中

---

## 3. 阶段 2：领域层（解耦 effect 链）

> 抽 4 个领域 hook，整体替换 PdfViewer 内对应逻辑。修 9.1 / 9.6 / 10.2 / 10.3 / 9.4 / 9.5。这是收益最大、风险中等的阶段。

### 3.1 `useSearchDomain`（搜索领域，重点）

**职责**：搜索索引/高亮/导航整体抽出。**核心改造：命中存 PDF 原始坐标，渲染时 ×scale；跳转用 ref 持有 goToPage，不进依赖。**

```ts
// src/hooks/useSearchDomain.ts
interface SearchMatch {
  id: string
  page: number
  pdfX: number; pdfY: number          // PDF 原始坐标（scale 无关）
  pdfWidth: number; pdfHeight: number
  text: string
}
interface UseSearchDomainOptions {
  pdf: PDFDocumentProxy | null
  numPages: number
  scale: number                        // 仅用于渲染高亮，不触发索引重建
  goToPageRef: React.MutableRefObject<(page: number) => void>  // ref，不进依赖
}
interface UseSearchDomainResult {
  searchOpen: boolean; setSearchOpen: (v: boolean) => void
  searchQuery: string; setSearchQuery: (v: string) => void
  searchMatches: SearchMatch[]
  searchActiveIndex: number; setSearchActiveIndex: (v: number) => void
  searchHighlightsByPage: Map<number, SearchHighlight[]>  // 渲染时 pdfToWrapper
}
export function useSearchDomain(options: UseSearchDomainOptions): UseSearchDomainResult
```

**关键改造**：
1. 索引依赖改为 `[searchOpen, searchQuery, pdf, numPages]`（**去掉 `scale`**），命中用 `page.getViewport({scale:1})` 的 `convertToPdfPoint` 存 PDF 原始坐标 → 修 9.1/9.6。
2. 高亮渲染时 `pdfToWrapper(match)` × 当前 scale，scale 变化无需重建索引。
3. 跳转 effect 依赖仅 `[searchActiveIndex, searchMatches]`，`goToPage` 用 `goToPageRef.current` → **修 10.2**（pageViewports 变化不再触发重跳）。

**迁移点**：`PdfViewer.tsx:922-1057`（搜索 build effect + active effect + highlightsByPage memo）整体迁入。

**顺带修复**：9.1 / 9.6 / 10.2。

**验收**：
- 缩放时搜索高亮不漂移、不重建（立即跟随）
- 搜索激活时用户可自由翻页，不被拉回 active match 页
- 大文档搜索仍可工作（性能优化见 3.2）

**回归测试**：新增 `useSearchDomain.test.ts`（索引稳定性、跳转触发条件、PDF 坐标转换）；`PdfViewer.zoom.test.tsx` 搜索高亮用例。

### 3.2 `useViewportManager`（viewport 预加载 + visiblePages）

**职责**：接管 `pageViewports`/`visiblePages`/`viewportsForScale` 的预加载策略，封装 `useReadyViewports`。

```ts
interface UseViewportManagerOptions {
  pdf; numPages; scale; pageNum; viewMode
}
interface UseViewportManagerResult {
  pageViewports: Map<number, PageViewportInfo>
  visiblePages: Set<number>
  isReady: boolean
  setPageVisible: (page: number, ratio: number) => void  // IO 回调
}
```

**迁移点**：`PdfViewer.tsx:214-217`（state）、`:809-857`（预加载 effect）、`:789-805`（IO 回调）。

**顺带修复**：9.4（fitToWidth 大文档无反馈 → viewportManager 可触发目标页加载后再 fit）、9.5（搜索分批，由 useSearchDomain 调 viewportManager 按需加载可见页）。

**验收**：大文档（>50 页）翻页/搜索流畅；fitToWidth 在 viewport 未就绪时给出 loading 态而非静默 return。

**回归测试**：`PdfViewer.state.test.tsx`；新增大文档预加载用例。

### 3.3 `useZoomAnchor`（缩放锚点）

**职责**：`captureZoomAnchor` + restore effect 收敛。

```ts
interface UseZoomAnchorOptions {
  viewMode; scale; pageViewports; isReady
  containerRef; pageWrapperRefs
  onRestored: (page: number, scrollTop: number) => void
}
interface UseZoomAnchorResult {
  capture: (anchorViewportOffsetPx: number) => void
  isZoomingRef: React.MutableRefObject<boolean>
}
```

**迁移点**：`PdfViewer.tsx:678-686`（zoomTo）、`:1208-1245`（restore effect）、captureZoomAnchor 内联逻辑。

**验收**：缩放保留视口顶/光标锚点不变（行为不变）。

**回归测试**：`zoomAnchor.test.ts`（不变）；`PdfViewer.zoom.test.tsx`。

### 3.4 `useScrollPageSync` + `useTabRestore`（状态上报与恢复）

> 这两个触及状态上报链路，放阶段 2 末尾，风险中等。

**`useScrollPageSync`**：滚动页码检测 + **即时上报**（修 10.1 时序竞争）。
- 改造：滚动时 `pageNum` 即时写入 ref（不依赖 100ms debounce 完成才上报）；debounce 仅用于防抖触发 onStateChange，ref 始终是最新值。
- 切 tab 前 `activateTab` 可 flush ref → pendingGotoPage 用即时值。
- 迁移：`PdfViewer.tsx:1129-1201`。

**`useTabRestore`**：状态恢复单一来源。
- 改造：scrollTop 上报收敛为单一出口（去 4 处分散），恢复时单一入口。
- 迁移：`PdfViewer.tsx:471-514`、`:335-348`。

**顺带修复**：10.1。

**验收**：滚动后立即切 tab，切回位置正确；scrollTop 恢复不被占位 scrollHeight clamp（大文档场景补测）。

**回归测试**：`PdfViewer.pageJump.test.tsx`、`PdfViewer.state.test.tsx`；新增「滚动后立即切 tab」用例。

### 3.5 阶段 2 验收清单

- [ ] 6 个领域 hook 单测通过
- [ ] 搜索高亮缩放不漂移（手测）
- [ ] 搜索激活时可自由翻页（手测）
- [ ] fitToWidth 居中正确
- [ ] tab 切换位置恢复正确（含滚动后立即切）
- [ ] 全量单测 + E2E 全绿

---

## 4. 阶段 3：协调层薄化

> 把 PdfViewer 剩余职责（PDF 加载缓存、大纲、快捷键、单页/连续布局、选区/批注 props 透传）归位，PdfViewer 薄化到 <300 行。

### 4.1 `usePdfDocument`

**职责**：PDF 加载/`cachedBytes` 复用/大纲加载。
```ts
interface UsePdfDocumentResult {
  pdf: PDFDocumentProxy | null
  numPages: number
  isLoading: boolean
  error: string | null
  outline: OutlineItem[]
}
```
迁移：`PdfViewer.tsx:379-466`（加载）、`:516-535`（大纲）。

### 4.2 PdfViewer 协调层

组合 `usePdfDocument` + `useViewportManager` + `useZoomAnchor` + `useSearchDomain` + `useScrollPageSync` + `useTabRestore`，仅保留：
- props 透传（annotations/settings/onSelection 等）
- 渲染 page wrappers（single/continuous 布局）
- 快捷键绑定（Ctrl+F/ESC/Enter/方向键）
- toolbar UI（缩放/页码/模式/搜索按钮）

目标：<300 行，无业务 effect（effect 全在各 hook 内）。

### 4.3 阶段 3 验收清单

- [ ] PdfViewer <300 行，无直接 useEffect 业务逻辑
- [ ] `npm run type-check` + `npm run lint` 通过
- [ ] 全量单测 + E2E 全绿
- [ ] 手测完整阅读闭环（打开/翻页/缩放/搜索/批注/翻译/切 tab）

---

## 5. 问题映射总表

| 问题 | 阶段 | 措施 | 风险 |
|------|------|------|------|
| 9.1 搜索高亮缩放错位 | 2 | useSearchDomain 存 PDF 原始坐标 | 中 |
| 9.2 WordTooltip 无 clamp | 1 | useOverlayPosition 接入 | 低 |
| 9.3 命令式写 wrapper.style | 1 | 删 PdfPage:187-188 | 低 |
| 9.4 fitToWidth 大文档无反馈 | 2 | useViewportManager 触发加载 | 中 |
| 9.5 搜索大文档无分页 | 2 | useSearchDomain 按需加载 | 中 |
| 9.6 scale 变化全量重建 | 2 | useSearchDomain 去 scale 依赖 | 中 |
| 9.7 文档过时 | — | 更新 AGENTS.md/MEMORY | — |
| 9.8 拖动每帧 setState | 1 | useDrag 松手一次提交 | 低 |
| 9.9 scrollTop 竞争 | 2 | 自然消解（useSearchDomain 去 goToPage 依赖） | — |
| 9.10 双触发重算 | 1 | useOverlayPosition 合并触发 | 低 |
| 10.1 tab 切换重置首页 | 2 | useScrollPageSync 即时上报 + useTabRestore | 中 |
| 10.2 搜索翻页拉回 | 2 | useSearchDomain 去 goToPage 依赖 | 中 |
| 10.3 fitToWidth 横向偏移 | 1 | useReadyViewports 门控 | 低 |
| 10.4 拖拽不灵活 | 1 | useDrag 全局监听 | 低 |

---

## 6. 风险与回滚策略

### 6.1 风险

| 风险 | 缓解 |
|------|------|
| 重构引入回归 | 纯函数单测 + E2E 安全网；每 hook 独立提交 |
| 领域 hook 边界设计不当返工 | 阶段 2 每个 hook 先定接口签名 review，再实现 |
| 坐标转换边界（dpr/transform）遗漏 | CoordinateConverter 单测覆盖 convertToPdfPoint/ViewportPoint |
| 搜索性能回归 | useSearchDomain 保留 debounce 250ms，分批加载可见页 |

### 6.2 回滚

- 每阶段一个 feature branch（`refactor/phase-1-infra` 等），合并前全量验证。
- 单 hook 提交粒度，出问题可精确 revert 单个 hook 而不影响其他。
- 纯函数层（popupPosition/zoomAnchor/fitToWidth）保持不变，是行为基准。

---

## 7. 测试策略

| 层级 | 策略 |
|------|------|
| 纯函数 | 现有单测不变；CoordinateConverter 新增单测 |
| Hook | 新增 useDrag/useOverlayPosition/useSearchDomain/useReadyViewports 等单测，jsdom mock ResizeObserver/IO |
| 组件接线 | 现有 `*.test.tsx` 保持；新增「滚动后立即切 tab」「搜索激活翻页」「边缘 tooltip」用例 |
| E2E | `app.spec.ts`/`pdf-page-jump.spec.ts` 回归；新增搜索 + 缩放高亮 E2E |
| 手测清单 | 每阶段验收清单逐项手测 |

> TDD 约定保持：jsdom 不做布局，定位/缩放数学仍抽纯函数重点单测；组件层用可控 ResizeObserver 测接线。

---

## 8. 迁移顺序与里程碑

```mermaid
flowchart LR
  S1["阶段 1 基础设施层<br/>useOverlayPosition · useDrag<br/>CoordinateConverter · useReadyViewports<br/>修 9.2/9.3/9.8/9.10/10.3/10.4"] --> S2["阶段 2 领域层<br/>useSearchDomain · useViewportManager<br/>useZoomAnchor · useScrollPageSync · useTabRestore<br/>修 9.1/9.4/9.5/9.6/9.9/10.1/10.2"]
  S2 --> S3["阶段 3 协调层薄化<br/>usePdfDocument · PdfViewer &lt;300 行"]
  S3 --> Done["更新 AGENTS.md/MEMORY<br/>9.7 文档同步"]
```

**里程碑**：
- M1（阶段 1 完成）：用户可感知的拖拽/tooltip/fitToWidth 修复，PdfViewer 未大改。
- M2（阶段 2 完成）：effect 链解耦，搜索/缩放/切 tab 问题全修，PdfViewer 逻辑外移。
- M3（阶段 3 完成）：PdfViewer <300 行，架构目标达成，后续开发顺畅。

---

## 9. 待审核决策点

请审核以下决策，确认后开始实施：

1. **三阶段范围**：是否全部采纳，还是阶段 1/2 先行、阶段 3 视情况？
2. **hook 命名与位置**：均放 `src/hooks/`（`useOverlayPosition` 替换 `useClampedPopupPosition`？还是并存？建议替换，消除重复）。
3. **CoordinateConverter 形态**：class（带 scale 实例）还是纯函数模块？建议纯函数 + scale 参数，更易单测。
4. **useDrag 拖动提交模式**：松手一次提交（修 9.8）还是保持每帧提交（行为不变但更卡）？建议松手一次。
5. **searchHighlights 坐标迁移**：是否同步更新持久化格式（若存了 wrapper 坐标）？当前搜索高亮不持久化，仅内存，无迁移负担。
6. **9.7 文档过时**：阶段 3 末尾统一更新 AGENTS.md/MEMORY，还是发现即更？建议阶段 3 统一更。

审核通过后，我将按阶段 1 → 2 → 3 顺序实施，每阶段结束提交并跑全量测试。
