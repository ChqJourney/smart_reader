# Tab 状态隔离改造方案

> 状态：**已实施**  
> 关联问题：PDF Viewer 中当前页面、文本选区、解读标记在 tab 之间未隔离，切换 tab 时互相影响。

---

## 1. 问题现象（已修复）

1. **当前页面不独立**：切换 tab 后，页面/滚动位置 retaining 上一个 tab 的状态，或回到非预期位置。
2. **选择区域全局共享**：在 tab A 选中文本后，切换到 tab B 仍能看到选区；分屏时左右两个 PDF 视图共用同一份选区状态。
3. **解读标记闪现**：切换 tab 时，上一个 tab 的解读/翻译标记会短暂出现在当前 tab，随后消失。
4. **关闭活动 tab 丢失所有批注**：关闭当前活动 tab 时，会把所有 tab 的 annotations 全部清空。
5. **清除暂存误删其他 tab 的 stash 标记**：在当前 tab 清除暂存时，会同时删除其他 tab 的 stash 标记。
6. **分屏右侧面板归属不清**：右侧面板同时显示 active + secondary 两个 tab 的合并数据，点击跳转/解读时目标 tab 不明确。

---

## 2. 根因分析

### 2.1 当前页面/滚动位置未按 tab 保存

- `src/hooks/useTabs.ts` 中的 `PdfTab` 只保存了 `pageNum`、`scale`、`viewMode` 三个字段，**没有连续滚动偏移**。
- `src/components/PdfViewer.tsx` 内部用 `initialState` 初始化 `pageNum/scale/viewMode`；props 变化时通过 sync effect 同步回内部状态。
- `PdfViewer` 没有被赋予按 tab 区分的 React `key`。切换 tab 时 React 复用同一组件实例，仅通过 props/effects 刷新；内部状态（滚动条、搜索框、outline 开关等）会残留。
- 连续滚动模式下，`scrollTop` 没有保存到 tab 状态，切换回来时只能恢复 `pageNum`，无法精确定位到之前的阅读位置。

### 2.2 选择区域是全局状态

- `src/App.tsx` 中 `selection` 曾是 `App` 组件级的全局状态，所有 `PdfViewer` 实例共享。
- `handleSelection` 直接设置这个全局 selection。
- 全局唯一的 `SelectionToolbar` 基于这个全局 selection 渲染。
- 分屏模式下，左右两个 `PdfViewer` 的 `onSelection` 都指向同一个 `handleSelection`，会互相覆盖。
- 切换 tab 时，只能被动清空 selection，无法做到 tab 离开时保留、进入时恢复。

### 2.3 解读标记在全局数组中过滤时机过晚

- `src/hooks/usePersistence.ts` 中所有 tab 的 annotations 都存在同一个全局数组里。
- 当 `activeTab` 变化时加载新 PDF 数据，若中间态 `activeTab` 为 `null`，会执行 `setAnnotations([])` 清空全部。
- `App.tsx` 直接把全量 annotations 传给 `PdfViewer`，`PdfViewer` 再传给每个 `PdfPage`，最后才在 `PdfAnnotations` 里过滤。

**导致闪现的原因**：App 层把全量 annotations 传给 `PdfViewer`，如果旧 annotation 的 `fileHash` 缺失、或 transient 状态短暂满足过滤条件，就会在当前 tab 渲染出来，随后被新的 state 替换而消失。

### 2.4 当前代码中的确定性数据破坏 bug（优先级最高）

#### 2.4.1 关闭活动 tab 清空全部 annotations

原 `src/App.tsx`：

```ts
if (isActive) {
  persistence.setAnnotations([]);
  setSelection(null);
  setHighlightedAnnotationId(null);
}
```

关闭活动 tab 时直接 `setAnnotations([])` 清空整个数组，导致所有 tab 的批注在内存中丢失。

#### 2.4.2 清除暂存时全局移除 stash annotations

原 `src/hooks/usePersistence.ts`：

```ts
const handleClearStashes = useCallback(() => {
  setStashes((prev) => prev.filter((s) => !visibleTabIds.has(s.source.tabId)));
  setAnnotations((prev) => prev.filter((a) => a.type !== "stash"));
}, [visibleTabIds]);
```

`stashes` 已按 `visibleTabIds` 过滤，但 annotations 是按 `a.type !== "stash"` 全局移除——会同时删掉其他 tab 的 stash 标记。

#### 2.4.3 handleGotoStash 的 tab 切换竞态

原 `src/App.tsx`：

```ts
const handleGotoStash = useCallback(
  (stash: StashItem) => {
    tabs.gotoTabPage(stash.source.tabId, stash.source.page);
    pdfViewerRef.current?.goToPage(stash.source.page);
  },
  [tabs]
);
```

如果 stash 属于另一个 tab，`gotoTabPage` 会切换 `activeTabId`，但 `pdfViewerRef.current` 仍指向旧 viewer（或新 viewer 尚未挂载完成）。

---

## 3. 改造目标（已达成）

- 修复当前确定性的数据破坏 bug（关闭 tab 清空 annotations、清除 stash 跨 tab 删除）。
- 每个 tab 在内存中拥有独立的运行时状态：当前页面、缩放、阅读模式、滚动位置、文本选区、高亮标记。
- annotations / sessions / stashes 按 `fileHash` 分桶存储，不再使用单一全局数组。
- 切换 tab 时无闪现、无残留，分屏时左右视图完全隔离。
- 保持现有持久化格式不变（磁盘上的 `{hash}.json` 和 sessions 文件格式不变）。
- 大文件切 tab 不重新读取磁盘（引入 PDF bytes cache）。

---

## 4. 改造方案与实际实现

### 4.1 扩展 `PdfTab` 数据结构

文件：`src/hooks/useTabs.ts`

在 `PdfTab` 中增加了每个 tab 独立的运行时状态字段：

```ts
export interface PdfTab {
  id: string;
  filePath: string;
  fileName: string;
  fileHash: string;
  pageNum?: number;
  scale?: number;
  viewMode?: "single" | "continuous";
  // 新增
  scrollTop?: number; // 连续滚动模式下的滚动偏移
  selection?: SelectionState | null; // 当前 tab 的文本选区
  highlightedAnnotationId?: string | null; // 当前 tab 高亮的解读标记
  pendingGotoPage?: number; // 跨 tab 跳转目标页
}
```

说明：

- `scrollTop` 只在 `viewMode === "continuous"` 时有意义；单页模式可忽略。
- `selection` 的类型复用 `src/services/selection.ts` 中的 `SelectionState`。
- `pendingGotoPage` 用于解决 `handleGotoStash` 跨 tab 跳转的竞态：切换 tab 后由新 `PdfViewer` 读取并执行跳转，然后清空该字段。

### 4.2 将全局 selection 下放到 tab

文件：`src/App.tsx`、`src/hooks/useTabs.ts`

实现步骤：

1. 删除 `App.tsx` 中的全局 `selection` 状态。
2. 在 `useTabs` 中提供：
   - `setTabSelection(tabId: string, selection: SelectionState | null)`
   - `clearTabSelection(tabId: string)`
3. `PdfViewer` 已经接收 `tabId: string` prop，`App.tsx` 中 `handleSelection` 根据传入的 `tabId` 写入对应 tab 的 selection。
4. 切换 tab 时，从目标 `PdfTab.selection` 恢复选区；关闭 tab 时清理对应选区。
5. `SelectionToolbar` 的 `selection` prop 改为从 `activeTab.selection` 读取。

**SelectionState 屏幕坐标处理**：

- `SelectionToolbar` 使用 `selection.x / selection.y`（屏幕坐标）定位工具条。
- 把 selection 存入 `PdfTab` 后，切换 tab 再恢复时这些屏幕坐标已经失效（滚动位置、窗口大小都可能变化）。
- **处理方式**：
  - 存入 tab 时保留完整 `SelectionState`（包括 `x`、`y`）。
  - 恢复后若屏幕坐标失效，`SelectionToolbar` 可能定位异常；当前实现优先保证页码/滚动隔离正确，选区恢复的精确坐标定位作为后续优化项。

分屏处理：

- 主/次两个 viewer 分别使用 `activeTab.selection` 和 `secondaryTab.selection`。
- 右侧面板归属见 4.8。

### 4.3 annotations / sessions / stashes 按 fileHash 分桶

文件：`src/hooks/usePersistence.ts`

#### 4.3.1 内部存储结构

将单一数组改为按 `fileHash` 分桶：

```ts
const [annotationsByHash, setAnnotationsByHash] = useState<
  Record<string, Annotation[]>
>({});
```

`sessions` 和 `stashes` 维持数组，但提供按 fileHash / tabId 过滤的导出。

#### 4.3.2 加载逻辑

- `activeTab` 变化时，只加载/更新对应 `fileHash` 的 bucket：
  ```ts
  setAnnotationsByHash((prev) => ({
    ...prev,
    [fileHash]: loadedAnnotations,
  }));
  ```
- 不再需要 `prev.filter((a) => a.fileHash !== fileHash)` 这种全数组过滤。
- 避免中间态 `activeTab === null` 导致的全局清空。

#### 4.3.3 与 `loadedFileHashesRef` 的交互

当某个 `fileHash` 的全部 annotations 消失时，从 `loadedFileHashesRef` 中移除，以便下次重新打开时重新加载。分桶后同步调整：当 `annotationsByHash[fileHash]` 为空数组时，从 `Record` 中 `delete` 该 key，同时从 `loadedFileHashesRef.current` 中移除该 hash。

#### 4.3.4 导出给 UI 的数据

```ts
const visibleTabAnnotations = useMemo(() => {
  const result: Annotation[] = [];
  for (const hash of visibleFileHashes) {
    result.push(...(annotationsByHash[hash] || []));
  }
  return result;
}, [annotationsByHash, visibleFileHashes]);
```

`App.tsx` 传 `visibleTabAnnotations` 给 `PdfViewer`，而不是全量 annotations。

### 4.4 给 PdfViewer 增加按 tab 区分的 key，并引入 PDF bytes cache

文件：`src/App.tsx`、`src/components/PdfViewer.tsx`

#### 4.4.1 key 方案

使用 `tab.id` 而不是 `filePath` 作为 `key`，避免同一文件打开多个 tab 时状态串扰：

```tsx
<PdfViewer
  key={tabs.activeTab?.id ?? "no-tab"}
  ref={pdfViewerRef}
  filePath={tabs.activeTab?.filePath ?? ""}
  // ...
/>
```

#### 4.4.2 PDF bytes cache

为避免每次切 tab 都重新 `invoke("read_pdf_bytes")`，在 `App.tsx` 中维护：

```ts
const pdfCacheRef = useRef<Map<string, Uint8Array>>(new Map());
```

- `PdfViewer` 接收 `cachedBytes?: Uint8Array` prop；若 cache 中存在则直接使用，否则自行加载并调用 `onPdfLoaded(filePath, bytes)` 回写 cache。
- 每个 `PdfViewer` 实例自己持有独立的 `PDFDocumentProxy`，避免共享 PDF.js transport state 导致 `sendWithPromise` 为 null 等错误。
- 使用缓存 bytes 时先 `cachedBytes.slice()` 复制一份再交给 PDF.js worker，防止 worker detach 共享的 ArrayBuffer。
- 关闭 tab 时，若该 `filePath` 不再被任何打开 tab 引用，从 cache 中删除对应 bytes（无需 destroy）。

### 4.5 连续滚动位置保存与恢复

文件：`src/components/PdfViewer.tsx`、`src/hooks/useTabs.ts`

实现：

1. `PdfViewer` 在连续滚动模式下通过滚动监听上报 `container.scrollTop`。
2. `onStateChange` 的回调参数扩展为包含 `scrollTop`：
   ```ts
   export interface PdfViewerState {
     pageNum: number;
     scale: number;
     viewMode: "single" | "continuous";
     scrollTop?: number;
   }
   ```
3. `useTabs.handleViewerStateChange` 把 `scrollTop` 写回对应 `PdfTab`。
4. `PdfViewer` 挂载后通过一个 goto effect 恢复位置：若存在 `pendingGotoPage` 则先 `goToPage(pending)` 定位到页，再在连续模式下覆盖 `container.scrollTop` 为保存的精确偏移；否则直接恢复 `scrollTop`。因 `PdfViewer` 用 `key={tab.id}`，tab 切换会重新挂载，恢复逻辑自然按 tab 隔离。
5. **恢复只执行一次（`hasRestoredRef`）**：goto effect 依赖 `pageViewports`，会在 viewport 预加载、`pageNum` 变化时多次重跑。用 `hasRestoredRef` 守护，首次恢复后置 `true`，后续重跑直接 return，避免同 tab 内跳转被陈旧的 `scrollTop`（如初始 `goToPage(1)` 产生的 0）重置回顶部。
6. **jump lock 释放时上报最终位置（`onStateChangeRef`）**：`goToPage` 的 jump lock（150ms 防抖 / 300ms 兜底）释放后，主动通过 `onStateChangeRef`（ref 持有最新 `onStateChange`，避免闭包 stale）上报 `{ pageNum, scale, viewMode, scrollTop: container.scrollTop }`。否则程序化跳转后的 `scrollTop` 要等用户再次滚动才上报，切 tab 时恢复的是旧值。此处不用 `dispatchEvent("scroll")`，因为它会触发 `computeAndSyncPage` 重算可见页并改写 `pageNum`，在 webkit 下导致页码回归。

#### 已修复的竞态

- **同 tab 跳转被重置回顶**：恢复 effect 未加 `hasRestoredRef` 守护前，`pageViewports`/`pageNum` 变化会反复触发 `scrollTop` 恢复，用 `goToPage(1)` 产生的 `scrollTop=0` 覆盖用户的 `goToPage(5)`，导致 `pdf-page-jump` 12 个 E2E 全 fail。
- **tab 切换后页码变 1**：jump lock 释放后未上报 `scrollTop`，`tab.scrollTop` 停在旧值 0，切回时恢复 0 回顶，页码显示成可见的第 1 页；用户拖动后 scroll 监听才修正。补上 `onStateChangeRef` 上报后修复。

### 4.6 highlightedAnnotationId 下放到 tab

文件：`src/App.tsx`、`src/hooks/useTabs.ts`

- 删除 `App.tsx` 中的全局 `highlightedAnnotationId` 状态。
- 在 `PdfTab` 中增加 `highlightedAnnotationId`。
- `handleExplainClick` 根据当前 viewer 所属的 tabId 写入对应 tab。
- 切换 tab 时恢复目标 tab 的 `highlightedAnnotationId`，2 秒超时后自动清空。

### 4.7 修复 handleCloseTab 和 handleClearStashes 的数据破坏 bug

文件：`src/App.tsx`、`src/hooks/usePersistence.ts`

- **关闭活动 tab**：删除 `persistence.setAnnotations([])`，改为分桶后该 tab 对应的 bucket 自然随 tab 关闭而不再显示。若该 `fileHash` 不再被任何打开 tab 引用，从 `annotationsByHash` 中删除该 bucket。
- **关闭活动 tab 时恢复下一 tab 的页码**：`useTabs.handleCloseTab` 在移除 tab 的同时，把下一个活动 tab 的 `pageNum` 写入 `pendingGotoPage`，保证切换后页码正确恢复。
- **清除暂存**：按当前可见 tab 的 `tabId` 过滤 stashes，并按对应 `fileHash` bucket 精确删除 stash annotations，不会波及其他 tab。

### 4.8 分屏时右侧面板的归属

当前代码中右侧面板原本显示 `visibleTabStashes` / `visibleTabSessions`（active + secondary 两个 tab 的合并数据）。

改造后实施方案 B：右侧面板只显示“聚焦的 viewer”对应的 tab 数据。

实现：

- `App.tsx` 新增状态 `focusedViewer: "primary" | "secondary"`，默认 primary。
- 点击左/右 PDF 区域时切换 `focusedViewer`。
- `usePersistence` 新增 `focusedTab: PdfTab | null` prop，导出：
  - `focusedTabStashes`：按 `focusedTab.id` 过滤。
  - `focusedTabSessions`：按 `focusedTab.fileHash` 过滤（兼容重新打开同一文件后旧 session 的 `tabId` 已失效的情况）。
- 右侧面板使用 `focusedTabStashes` / `focusedTabSessions`。
- `handleGotoStash` 在跳转时同步更新 `focusedViewer`，保证右侧面板与跳转目标一致。

### 4.9 修复 handleGotoStash 跨 tab 竞态

文件：`src/App.tsx`、`src/hooks/useTabs.ts`

改造后：

1. `gotoTabPage` 把目标页写入对应 tab 的 `pendingGotoPage` 字段。
2. 如果目标 tab 当前不是 active tab，则切换 `activeTabId`。
3. 新 tab 对应的 `PdfViewer` 在挂载后读取 `pendingGotoPage`，执行 `goToPage`，然后清空该字段。
4. 不再直接调用 `pdfViewerRef.current?.goToPage`。

### 4.10 其他 PdfViewer 内部状态

以下状态保持“切换 tab 时重置”（通过 `key` 自然实现），无需提升到 tab：

- `outlineOpen`
- `searchOpen`、`searchQuery`、`searchMatches`、`searchActiveIndex`
- `scaleInput`、`pageInput` 编辑态

若未来需要“记住每个 tab 的搜索关键词”，可再扩展 `PdfTab`。

---

## 5. 改造步骤清单（已执行）

1. **修复确定性 bug（最高优先级）**
   - `App.tsx`：删除关闭活动 tab 时的 `persistence.setAnnotations([])`。
   - `usePersistence.ts`：修复 `handleClearStashes` 全局移除 stash annotations 的问题。

2. **扩展 `PdfTab` 类型**（`useTabs.ts`）
   - 新增 `scrollTop`、`selection`、`highlightedAnnotationId`、`pendingGotoPage`。

3. **annotations 按 fileHash 分桶**
   - 修改 `usePersistence.ts` 内部状态结构。
   - 修改加载/保存逻辑，同步调整 `loadedFileHashesRef` 清理逻辑。
   - 暴露 `visibleTabAnnotations`。
   - `App.tsx` 只传 `visibleTabAnnotations` 给 `PdfViewer`。

4. **引入 PDF bytes cache**
   - 在 `App.tsx` 中维护 `Map<filePath, Uint8Array>`。
   - `PdfViewer` 优先使用 cache，加载完成后回写 cache；每个 viewer 持有独立 PDFDocumentProxy。

5. **给 `PdfViewer` 加 `key={tab.id}`**
   - 切换 tab 时重新挂载，内部状态自然隔离。
   - 配合 PDF bytes cache 避免重复读取磁盘。

6. **保存/恢复滚动位置**
   - 扩展 `PdfViewerState`。
   - 在 `PdfViewer` 滚动事件中上报 `scrollTop`。
   - 初始化时优先执行 `pendingGotoPage`，无跳转时恢复 `scrollTop`。

7. **实现 tab 级 selection**
   - 删除 `App.tsx` 全局 `selection`。
   - 在 `useTabs` 中增加 selection 读写方法。
   - `PdfViewer` 传入 `tabId`，`handleSelection` 按 tabId 写入。
   - `SelectionToolbar` 使用 `activeTab.selection`。

8. **highlightedAnnotationId 下放到 tab**
   - 删除 `App.tsx` 全局状态。
   - 写入/恢复对应 tab 字段。

9. **修复 handleGotoStash 跨 tab 竞态**
   - 改为通过 `pendingGotoPage` 延迟到新 `PdfViewer` 挂载后执行。

10. **明确分屏右侧面板归属**
    - 实施方案 B：新增 `focusedViewer`，右侧面板只显示聚焦 viewer 对应的 tab 数据。

11. **补充/更新测试**
    - 单元测试：
      - `useTabs` 的 `activateTab`、`handleCloseTab` 页码恢复逻辑。
      - `usePersistence` 的分桶加载、关闭 tab 不丢其他 tab 数据、`focusedTabStashes`/`focusedTabSessions`。
      - `App.test.tsx` 分屏下点击 viewer 切换右侧面板焦点。
      - `PdfViewer.state.test.tsx` 的 cache、scrollTop 恢复、`pendingGotoPage` 执行。
    - E2E：`e2e/multi-tab-state.spec.ts` 覆盖多 tab 页码隔离、关闭 active tab 保留状态、批注不串 tab。

---

## 6. 影响面评估

| 范围                                                      | 影响     | 说明                                                                                                                |
| --------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| 磁盘数据格式                                              | 无影响   | 继续按 `fileHash` 保存 `{hash}.json` 和 sessions 文件。                                                             |
| `Annotation` / `StashItem` / `InterpretationSession` 类型 | 无影响   | 不改数据结构。                                                                                                      |
| `PdfViewer` API                                           | 中影响   | 增加 `tabId` prop，`initialState/onStateChange` 增加 `scrollTop/pendingGotoPage`，`cachedBytes` 替代 `cachedPdf`。  |
| `useTabs` API                                             | 中影响   | 新增 selection/highlight/pendingGotoPage 相关方法。                                                                 |
| `usePersistence` API                                      | 中影响   | 内部改为分桶，对外暴露 `visibleTabAnnotations`、`focusedTabStashes`、`focusedTabSessions`；新增 `focusedTab` prop。 |
| UI 行为                                                   | 明显改善 | 切换 tab 不再闪现、串状态；关闭 tab 不再丢数据；分屏右侧面板焦点清晰。                                              |
| 性能                                                      | 基本中性 | `key={tab.id}` 会重新挂载 `PdfViewer`，但 PDF bytes cache 避免重复读取磁盘；大文件仍需重新 `getDocument` 解析。     |

---

## 7. 测试要点（已覆盖）

- 打开两个不同 PDF，在 tab A 翻到第 N 页；切换到 tab B 翻到其他页；切回 tab A 应仍在第 N 页。
- 连续滚动模式下，在 tab A 滚动到中间某位置；切换 tab 后再切回，应恢复到近似滚动位置。
- 在 tab A 做翻译/解读标记；切换到 tab B，不应看到 tab A 的标记闪现。
- 在 tab A 添加若干 stash；在 tab B 添加 stash；在 tab A 清除暂存，tab B 的 stash 标记应不受影响。
- 关闭当前活动 tab 后，其他 tab 的 annotations 应仍然存在，且页码正确恢复。
- 分屏模式下，左右两个 PDF 各自独立翻页、选区、标记，互不干扰。
- 分屏模式下点击左右 viewer，右侧面板应切换显示对应 tab 的 stash/session。
- 关闭 tab A 后再重新打开同一文件，应能正确从磁盘恢复 annotations 和 sessions。

---

## 8. 相关代码位置速查

- `src/hooks/useTabs.ts` — `PdfTab` 定义、tab 切换与状态变更、`handleCloseTab` 页码恢复
- `src/hooks/usePersistence.ts` — 分桶 annotations、`visibleTabAnnotations`、`focusedTabStashes`/`focusedTabSessions`、`handleClearStashes`
- `src/App.tsx` — `pdfCacheRef`、PDF 面板点击切换 `focusedViewer`、右侧面板数据绑定、`handleGotoStash`
- `src/components/PdfViewer.tsx` — `cachedBytes` 加载、scrollTop 上报与恢复、`pendingGotoPage` 执行
- `src/components/PdfAnnotations.tsx` — 渲染层过滤 annotations
- `src/components/SelectionToolbar.tsx` — 浮动工具条
- `e2e/multi-tab-state.spec.ts` — 多 tab 状态隔离 E2E
