/**
 * Tab 休眠的内存预算记账与 LRU 候选选择（纯函数，便于单测）。
 *
 * 设计见 docs/TAB_HIBERNATION_DESIGN.md §4/§5：
 * - 两条预算线任一超限即触发休眠：字节预算（Σ存活文件大小×2）与
 *   存活 viewer 数上限；
 * - 记账确定性、不依赖 performance.memory；
 * - 候选耗尽仍超预算时放行（预算是体验保障不是访问控制）。
 */

/** 字节记账经验系数：pdfCacheRef 一份 + pdfjs 一份。 */
const BYTES_PER_FILE_MULTIPLIER = 2;

/** 字节预算：macOS WKWebView jetsam 更激进，取更保守的值（实测后再校准）。 */
const BYTE_BUDGET_MACOS = 400 * 1024 * 1024;
const BYTE_BUDGET_WINDOWS = 800 * 1024 * 1024;
const BYTE_BUDGET_DEFAULT = BYTE_BUDGET_MACOS;

/** 存活 viewer（active + hidden + 分屏两屏）总数上限。 */
export const ALIVE_VIEWER_BUDGET = 15;

/** 刚激活不足该时长的 tab 不可被休眠（避免「刚切走就被卸载」的抖动，
 *  同时让 scrollTop 防抖上报窗口过去，保证快照是最新的）。 */
export const RECENT_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;

/** 预算视角下的 tab 最小字段集（与 useTabs 的 PdfTab 结构兼容）。 */
export interface BudgetTab {
  id: string;
  filePath: string;
  hibernated?: boolean;
  /** 文件字节数；未知时按 0 记账。 */
  fileSize?: number;
  lastActivatedAt?: number;
}

export interface BudgetContext {
  activeTabId: string | null;
  /** 分屏副屏 tab（可见即存活）。 */
  secondaryTabId?: string | null;
  /** 有进行中流式会话的 tab，v1 保守处理不做休眠候选。 */
  streamingTabIds?: ReadonlySet<string>;
  /** 当前时间戳（注入便于测试）。 */
  now: number;
}

export interface BudgetUsage {
  /** 记账字节数：Σ（存活 tab 文件大小 × 2），按 filePath 去重。 */
  bytes: number;
  /** 存活 viewer 数（非休眠 tab 数）。 */
  aliveViewers: number;
}

/** 即将加入的新文件（addTab 的新 tab 或唤醒的休眠 tab）。 */
export interface IncomingFile {
  filePath: string;
  fileSize?: number;
}

function detectByteBudget(userAgent?: string): number {
  const ua = (
    userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "")
  ).toLowerCase();
  if (ua.includes("windows")) return BYTE_BUDGET_WINDOWS;
  if (ua.includes("mac")) return BYTE_BUDGET_MACOS;
  return BYTE_BUDGET_DEFAULT;
}

/** 当前平台的字节预算。userAgent 可注入以便测试。 */
export function getByteBudget(userAgent?: string): number {
  return detectByteBudget(userAgent);
}

/**
 * 预测加入 newFile 后的记账值。同一路径多 tab 共享一份字节缓存，
 * 记账按 filePath 去重只计一份。
 */
export function projectUsage(
  tabs: readonly BudgetTab[],
  newFile?: IncomingFile
): BudgetUsage {
  const bytesByPath = new Map<string, number>();
  let aliveViewers = 0;
  for (const tab of tabs) {
    if (tab.hibernated) continue;
    aliveViewers += 1;
    if (!bytesByPath.has(tab.filePath)) {
      bytesByPath.set(tab.filePath, tab.fileSize ?? 0);
    }
  }
  if (newFile && !bytesByPath.has(newFile.filePath)) {
    bytesByPath.set(newFile.filePath, newFile.fileSize ?? 0);
    aliveViewers += 1;
  }
  let bytes = 0;
  for (const size of bytesByPath.values()) {
    bytes += size * BYTES_PER_FILE_MULTIPLIER;
  }
  return { bytes, aliveViewers };
}

export function exceedsBudget(usage: BudgetUsage, byteBudget: number): boolean {
  return usage.bytes > byteBudget || usage.aliveViewers > ALIVE_VIEWER_BUDGET;
}

/**
 * 选择需要休眠的 tab id 列表，使加入 newFile 后的预测用量回落到预算内。
 * 按 lastActivatedAt 升序（LRU）依次选取；以下 tab 不可被选：
 * 1. 当前 active tab / 分屏 secondary tab（可见即存活）；
 * 2. lastActivatedAt 距今不足 RECENT_ACTIVITY_WINDOW_MS；
 * 3. 有进行中流式会话；
 * 4. filePath 被其他存活 tab 共享（休眠它不释放字节）。
 * 候选耗尽仍超预算时返回已选中的部分（调用方放行）。
 */
export function selectHibernateCandidates(
  tabs: readonly BudgetTab[],
  ctx: BudgetContext,
  newFile?: IncomingFile,
  byteBudget: number = detectByteBudget()
): string[] {
  // 唤醒场景由调用方把被唤醒 tab 作为 active 传入保护。
  const protectedIds = new Set<string>(
    [ctx.activeTabId, ctx.secondaryTabId].filter(
      (id): id is string => typeof id === "string"
    )
  );
  const streaming = ctx.streamingTabIds ?? new Set<string>();

  // 统计存活 tab 对每个 filePath 的引用数，引用数 > 1 的 tab 休眠不释放字节。
  const aliveRefCount = new Map<string, number>();
  for (const tab of tabs) {
    if (tab.hibernated) continue;
    aliveRefCount.set(tab.filePath, (aliveRefCount.get(tab.filePath) ?? 0) + 1);
  }
  if (newFile) {
    aliveRefCount.set(
      newFile.filePath,
      (aliveRefCount.get(newFile.filePath) ?? 0) + 1
    );
  }

  const eligible = tabs
    .filter((tab) => {
      if (tab.hibernated) return false;
      if (protectedIds.has(tab.id)) return false;
      if (streaming.has(tab.id)) return false;
      if (
        tab.lastActivatedAt !== undefined &&
        ctx.now - tab.lastActivatedAt < RECENT_ACTIVITY_WINDOW_MS
      ) {
        return false;
      }
      if ((aliveRefCount.get(tab.filePath) ?? 0) > 1) return false;
      return true;
    })
    .sort((a, b) => (a.lastActivatedAt ?? 0) - (b.lastActivatedAt ?? 0));

  const selected: string[] = [];
  const hibernatedIds = new Set<string>();
  const usageAfter = (extra?: IncomingFile): BudgetUsage =>
    projectUsage(
      tabs.map((tab) =>
        hibernatedIds.has(tab.id) ? { ...tab, hibernated: true } : tab
      ),
      extra
    );

  for (const candidate of eligible) {
    if (!exceedsBudget(usageAfter(newFile), byteBudget)) break;
    hibernatedIds.add(candidate.id);
    selected.push(candidate.id);
  }
  return selected;
}
