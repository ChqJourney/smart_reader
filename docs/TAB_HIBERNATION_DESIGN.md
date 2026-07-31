# Tab 休眠设计：取消 10 个 PDF 打开上限

> 状态：已实施（v1）
> 关联：`src/hooks/useTabs.ts`（休眠调度）、`src/services/memoryBudget.ts`（预算记账）、`src/App.tsx`（pdfCacheRef / keep-alive / HibernatedPlaceholder）、`src/hooks/usePdfDocument.ts`、`src/hooks/useTabRestore.ts`
>
> 实施偏差（与下文设计稿的差异）：
>
> 1. 设计假设「文件大小在 addTab 读 bytes 时已知」，实际 addTab 只读 hash 不读字节——新增后端命令 `get_pdf_file_size`（fs metadata）在 addTab 时取得 fileSize；
> 2. `useTabs` 通过 `getHibernationContext` 注入 getter 获取 secondaryTabId / 流式会话 tab（App 以 ref 回填，避免 useTabs → usePersistence 循环依赖）；`usePersistence` 未改动——流式 tab 由 App 从已暴露的 `persistence.sessions` 直接推导（设计稿 §10 中「暴露查询」一项随之取消）；
> 3. 100 硬上限为纯防御（拒绝 + 记日志），`tabs.maxTabsHint` i18n key 已按设计删除。

## 1. 背景与目标

当前 `useTabs.ts` 用 `MAX_TABS = 10` 硬限制同时打开的 PDF 数量。这个限制保护的是三处随 tab 数线性增长的资源：

| 资源                                                       | 位置                                             | 量级                                           |
| ---------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| PDF 原始字节缓存（无上限、无淘汰）                         | `App.tsx` `pdfCacheRef`                          | 每 tab ≈ 2×文件大小（cache 一份 + pdfjs 一份） |
| 常驻 pdfjs `PDFDocumentProxy` + 冻结保留的视口 canvas 位图 | `usePdfDocument.ts` / `PdfViewer.tsx` keep-alive | 每 tab 数 MB ~ 数十 MB                         |
| 连续模式全页 DOM + 每页一个 IntersectionObserver           | `PdfViewer.tsx` / `PdfPage.tsx`                  | O(N × 总页数) 个 DOM 节点与 observer           |

超过 WebView 内存上限后不是「打不开」，而是整个 app 被系统杀掉（macOS WKWebView jetsam / Windows WebView2 OOM），所有 tab 的进行中工作一起丢失。

**目标**：

- 取消固定个数上限，用户可以打开任意多个 PDF；
- 内存有确定性硬顶，不依赖用户自律；
- 用户永远不被「请关掉部分 pdf」打断——超限时代价由系统自动转移到最久未用的隐藏 tab 上；
- 唤醒一个被休眠的 tab 是透明、低延迟的（目标 < 1s，典型 < 300ms）。

非目标：单 viewer 内部的 DOM 虚拟化（连续模式全页挂载是独立问题，休眠把它的总量限制在「存活 viewer 数 × 页数」内，可接受）。

## 2. 核心思路：休眠（hibernate）而不是拦截

超限时不拦截用户操作，而是**自动休眠最久未激活的隐藏 tab**：

- **休眠**：卸载该 tab 的 PdfViewer（销毁 pdfjs document、释放 canvas 位图与全页 DOM）、从 `pdfCacheRef` 删除其字节缓存；tab 外壳（标签页、标题、状态记录）保留。
- **唤醒**：用户切回该 tab 时按「冷启动打开 + 状态恢复」路径重新挂载 viewer。

关键依据：**恢复路径已经存在且经过充分测试**。`useTabRestore` 的挂载恢复本来就覆盖 pageNum / scale / viewMode / scrollTop / pendingGotoPage 的完整恢复（最近文件重开、关闭 tab 顶替激活走的就是这条路）；`usePdfDocument` 在 `cachedBytes` 缺失时本来就回退 `read_pdf_bytes` 重新读盘。唤醒一个休眠 tab ≈ 走一遍「首次打开该文件」的现有代码路径，增量工作集中在「卸载」这一半和休眠调度。

## 3. Tab 生命周期状态机

```
            addTab                activateTab
   不存在 ────────► alive-active ◄──────────┐
                      │                     │
              切走（其他 tab 激活）          │
                      ▼                     │
              alive-hidden（keep-alive，     │
               display:none，全状态常驻）    │
                      │                     │
            超预算时被 LRU 选中休眠          │
                      ▼                     │
                 hibernated ────────────────┘
                 （仅 tab 记录存在，         唤醒 = 重新挂载 viewer，
                  无 viewer / 无字节缓存）    useTabRestore 恢复现场
```

- `alive-active`：当前激活 tab；分屏时副屏 tab 视为同等存活（`alive-visible`）。
- `alive-hidden`：今天的 keep-alive 隐藏 tab，行为不变。
- `hibernated`：新增状态。`PdfTab` 增加字段 `hibernated?: boolean`（默认 undefined = false，无需迁移）。

关闭 tab 在任意状态下行为不变（休眠 tab 直接删记录即可）。

## 4. 预算模型与记账

休眠调度依赖**确定性记账**，不依赖 `performance.memory`（仅 Chromium 可用、受 GC 影响跳变、WKWebView 不支持）。

### 4.1 两条预算线（任一超限即触发休眠）

1. **字节预算 `BYTE_BUDGET`**：记账值 = Σ（存活 tab 的文件大小 × 2）（pdfCacheRef 一份 + pdfjs 一份的经验系数）。
   - 建议初值：macOS 400MB，Windows 800MB（WKWebView jetsam 更激进），实测后校准（见 §9）。
2. **存活 viewer 数上限 `ALIVE_VIEWER_BUDGET`**：存活 viewer（active + hidden + 分屏两屏）总数上限。
   - 管的是字节记账管不到的开销：pdfjs 解析态、canvas 位图、O(页数) 的 DOM 与 IntersectionObserver（50 个 1MB 小文件碰不到字节线，但 50 套 DOM/observer 照样拖垮交互）。
   - 建议初值 15，实测后校准。

### 4.2 记账实现

- 文件大小在 `addTab` 读 bytes / `handlePdfLoaded` 缓存时已知（`Uint8Array.byteLength`），把 `fileSize` 记入 `PdfTab`（休眠后仍保留，用于唤醒前重新记账）。
- 同一路径多 tab 共享一份缓存（`pdfCacheRef` 以 filePath 为 key）：记账按 filePath 去重，只计一份。
- 维护一个轻量 `MemoryBudget` 模块（建议放 `src/services/memoryBudget.ts`，纯函数 + 单例状态，便于单测）：
  - `projectUsage(tabs, newFile?)`：预测加入新文件后的记账值；
  - `selectHibernateCandidates(tabs, ctx)`：返回需要休眠的 tab id 列表（见 §5）；
  - 常量 `BYTE_BUDGET` / `ALIVE_VIEWER_BUDGET` 与平台判定（`@tauri-apps/api/os` 或 ua）。

## 5. 休眠流程

### 5.1 触发时机

只有一个触发点：**`addTab` 即将创建新 tab 时**（useTabs.ts 原 MAX_TABS 检查的位置，替换之）。

- 打开前预测：`projectUsage` 加入新文件后是否超任一预算；
- 超限 → 按 §5.2 选择候选休眠，直到预测值回到预算内；
- 不超限 → 什么都不做。

不做后台定时巡检、不在切 tab 时休眠：预算只在「新增」时可能恶化，单点触发足够，行为可预测、易测试。

### 5.2 候选选择（LRU + 保护规则）

按 `lastActivatedAt` 升序遍历**非活跃** tab，依次选为休眠候选，直到预测用量回落。以下 tab **不可被选**：

1. 当前 active tab；分屏时的 secondary tab（可见即存活）；
2. `lastActivatedAt` 距今 < 5 分钟的 tab（刚用过的 tab 大概率马上切回，避免「刚切走就被卸载」的抖动——也把 useScrollPageSync 的 scrollTop 防抖上报窗口让过去，保证快照是最新的）；
3. 有进行中流式会话的 tab（见 §7.3，v1 保守处理，直接排除）；
4. 新 tab 自身引用的文件已被其他存活 tab 打开（共享缓存，休眠它不释放字节）。

若候选耗尽仍超预算（例如单文件就超 `BYTE_BUDGET`）：**放行**。预算是体验保障不是访问控制，单个巨型文件必须能打开，此时靠 OS/WebView 自己的内存管理兜底。

### 5.3 执行休眠

对选中的 tab：

1. 快照确认：`PdfTab` 记录中的 pageNum / scale / viewMode / scrollTop 由 `handleViewerStateChange` 持续回写，休眠前无需额外采集（5 分钟保护窗口保证防抖已落盘）。`recentFiles.updateLastPage` 顺手回写一次（与关闭 tab 时一致），休眠 tab 意外丢失也能从最近文件恢复页码。
2. 置 `tab.hibernated = true`。
3. React 渲染层据此卸载 viewer（见 §6.1），unmount 触发 `usePdfDocument` 的 cleanup → `loadedPdf.destroy()`，pdfjs document、canvas 位图、全页 DOM、IntersectionObserver 一并释放。
4. 若没有其他存活 tab 引用同 filePath，从 `pdfCacheRef` 删除字节缓存。
5. 记日志：`tabHibernated: tabId=... reason=budget freedBytes≈...`。

## 6. 唤醒流程

### 6.1 渲染分支改造

`App.tsx` 的 keep-alive map（`App.tsx:1185` 起）按 tab 状态分两支：

```tsx
tabs.tabs.map((tab) => (
  <div key={tab.id} className={...}>
    {tab.hibernated ? (
      <HibernatedPlaceholder fileName={tab.fileName} />   // 见 §8
    ) : (
      <PdfViewer ... />                                    // 现状不变
    )}
  </div>
))
```

唤醒 = `activateTab` 时若 `tab.hibernated`，置回 `false` → PdfViewer 重新挂载 → 走现有冷启动路径：

1. `cachedBytes` 缺失 → `usePdfDocument` 回退 `read_pdf_bytes` 读盘，`onPdfLoaded` 重新填入 `pdfCacheRef`（需重新走 §5 预算检查：唤醒同样可能挤占预算 → 在唤醒路径上复用同一套「选候选休眠」逻辑，把唤醒的 tab 视为 active 保护起来）。
2. `activateTab` 已设置 `pendingGotoPage = tab.pageNum`，`useTabRestore` 挂载恢复 pageNum / scale / viewMode / scrollTop —— 与最近文件重开完全一致。
3. 恢复期间显示现有的 `isLoading` 占位，无需新 UI。

`activateTab` 置 `hibernated=false` 与设置 `pendingGotoPage` 必须在**同一次 setTabs** 里完成，保证挂载时 initialState 已就绪。

### 6.2 唤醒延迟预算

典型标准 PDF（10~~30MB）：读盘 + `getDocument` + 首屏渲染 ≈ 100~~500ms，与「从最近文件重开」体感一致，可接受。不需要为唤醒做专门的预热/预取（保持简单，实测不达标再说）。

## 7. 边界与交互

### 7.1 分屏（split view）

- active 与 secondary 两个 tab 永远视为存活，不参与休眠候选。
- 进入分屏时若目标 tab 处于 hibernated：先唤醒（同 §6.1），`autoFitToWidth` 在挂载恢复完成后照常执行。
- 退出分屏回到单视图时，两个 viewer 换树分支重挂载是现状行为，不受影响。

### 7.2 同一路径 / 同一 hash 多 tab

`pdfCacheRef` 按 filePath 共享；休眠其中一个 tab 时，只要还有存活 tab 引用同路径就**不删缓存、不计释放**（§5.2 规则 4 已避免选它）。

### 7.3 流式会话（Agent loop 进行中）

`runSessionStream`（usePersistence）不依赖 viewer 挂载（Agent Tools 的 `getPdfBytes` 有 `read_pdf_bytes` 回退），理论上休眠不中断流。但 v1 保守处理：有 `isStreaming` 会话的 tab 不做休眠候选（§5.2 规则 3），避免「解读结果写回时目标 viewer 已卸载」这类时序corner case。流结束后该 tab 自然变为可休眠。

### 7.4 Agent Tools / pdfToolsRegistry

`syncOpenPdfs` 的授权边界是「打开的 tab」，休眠 tab 仍是打开的 tab，注册表**不变**。工具执行期需要字节时走 `read_pdf_bytes` 回退，天然兼容。

### 7.5 搜索 / 选区 / 批注

- 搜索索引（useSearchDomain）是按需瞬态的，休眠时随 viewer 卸载丢弃，唤醒后用户重新搜索即可，无状态需要保留。
- 休眠 tab 的残留选区（`tab.selection`）在休眠时一并清空。
- 批注 / 解读会话按 fileHash 持久化，与 viewer 生命周期无关，唤醒后照常渲染。

### 7.6 删除 MAX_TABS

`useTabs.ts` 的 `MAX_TABS` 检查与 `tabs.maxTabsHint` 提示整体删除（i18n key 两边 locales 同步清理），由预算检查取代。保留一个**极端兜底硬上限 100**（防脚本/误触无限开 tab 把 tab 栏和状态数组打爆，与体验无关，纯防御）。

## 8. UI 表现

- **tab 栏**：休眠 tab 正常显示，不置灰、不加标记（休眠是内部实现细节，用户无需感知；加标记反而引发「我的文件是不是出问题了」的疑惑）。
- **占位组件 `HibernatedPlaceholder`**：休眠 tab 在 keep-alive 树里的占位。由于休眠 tab 必然不是 active，占位永远 display:none，实际上只是一个空 div——保留它是为了 key 稳定和语义清晰，零成本。
- **唤醒过程**：复用 viewer 现有的 `isLoading` 加载占位，无新 UI。

## 9. 度量与验收

### 9.1 前置：测量 spec（先于实施，校准常量）

新增 Playwright spec（如 `e2e/pdf-tab-budget.spec.ts`）：mock invoke 返回不同大小 PDF，循环开 N 个 tab，每开一个记录 `performance.memory.usedJSHeapSize` 与切 tab 耗时。产出 per-tab 实测成本，据此校准 `BYTE_BUDGET` / `ALIVE_VIEWER_BUDGET` 初值。（Playwright 跑 Chromium，仅用于相对趋势与回归；绝对值以打包后真实 WebView 手动 soak 为准。）

### 9.2 验收指标

| 指标                                  | 目标                                                | 测量                    |
| ------------------------------------- | --------------------------------------------------- | ----------------------- |
| 记账值（Σ文件大小×2）                 | 永远 ≤ BYTE_BUDGET（单文件超限放行除外）            | 单测断言 + 日志         |
| 存活 viewer 数                        | 永远 ≤ ALIVE_VIEWER_BUDGET                          | 单测断言                |
| 唤醒延迟（激活休眠 tab → 首屏可交互） | 典型 < 500ms，10MB 文件 < 1s                        | e2e 计时                |
| 唤醒后状态保真                        | pageNum / scale / viewMode / scrollTop 与休眠前一致 | 单测（useTabs 层）+ e2e |
| 开 50 个 tab 后切活跃 tab             | < 150ms，无感知卡顿                                 | e2e + 手动 soak         |

### 9.3 测试要点

- `memoryBudget.test.ts`：预测记账、LRU 选择、保护规则（active/secondary/5 分钟窗口/流式中/共享路径）、单文件超预算放行。
- `useTabs.test.ts(x)`：addTab 触发休眠、activateTab 唤醒（hibernated 复位与 pendingGotoPage 同拍设置）、关闭休眠 tab、100 硬上限。
- `useTabRestore` 现有测试即唤醒恢复路径的回归保障，需补一个「休眠→唤醒全链路」的组件级测试（mock invoke，断言恢复后 pageNum/scrollTop）。
- e2e：开 20+ tab 触发休眠 → 切回第一个 tab → 断言页码与滚动位置恢复。

## 10. 改动点清单

| 文件                                                     | 改动                                                                                                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/services/memoryBudget.ts`（新增）                   | 预算常量、记账、LRU 候选选择（纯函数）                                                                                                       |
| `src/services/memoryBudget.test.ts`（新增）              | 上述单测                                                                                                                                     |
| `src/hooks/useTabs.ts`                                   | 删 MAX_TABS；`PdfTab` 加 `hibernated` / `fileSize` / `lastActivatedAt`；addTab 接入预算检查与休眠执行；activateTab 唤醒复位；保留 100 硬上限 |
| `src/App.tsx`                                            | keep-alive map 增加 hibernated 分支；休眠时清理 pdfCacheRef 对应条目；唤醒路径复用预算检查                                                   |
| `src/hooks/usePersistence.ts`                            | 暴露「tab 是否有流式会话」查询（供候选过滤）                                                                                                 |
| `src/components/HibernatedPlaceholder.tsx`（新增，可选） | 占位空组件                                                                                                                                   |
| `src/locales/zh-CN.json` / `en.json`                     | 删除 `tabs.maxTabsHint`                                                                                                                      |
| `e2e/pdf-tab-budget.spec.ts`（新增）                     | 测量 + 休眠/唤醒回归                                                                                                                         |
| `AGENTS.md`                                              | 更新「最多 10 个 tab」相关描述为休眠机制                                                                                                     |

`usePdfDocument.ts` / `useTabRestore.ts` / `PdfViewer.tsx` **零改动**——这是本方案的核心论据：唤醒完全复用现有冷启动恢复路径。

## 11. 实施顺序

1. 测量 spec（§9.1），拿到 per-tab 实测成本，定预算常量；
2. `memoryBudget.ts` + 单测（纯逻辑，独立交付）；
3. useTabs 接入（删 MAX_TABS、状态字段、休眠/唤醒编排）+ 单测；
4. App.tsx 渲染分支与缓存清理；
5. e2e 回归 + 打包后真实 WebView 手动 soak（macOS 重点验证 jetsam 边界）。

第 2~4 步可在一个 PR 内完成；第 1 步先行，因为它决定常量取值。
