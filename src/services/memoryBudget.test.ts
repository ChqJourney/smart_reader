import { describe, expect, it } from "vitest";
import {
  ALIVE_VIEWER_BUDGET,
  BITMAP_BYTES_PER_ALIVE_VIEWER,
  BudgetContext,
  BudgetTab,
  RECENT_ACTIVITY_WINDOW_MS,
  getByteBudget,
  projectUsage,
  selectHibernateCandidates,
} from "./memoryBudget";

const MB = 1024 * 1024;
const NOW = 1_000_000_000;
/** 每个存活 viewer 的位图记账（52MB），测试内简写。 */
const BITMAP = BITMAP_BYTES_PER_ALIVE_VIEWER;

function makeTab(partial: Partial<BudgetTab> & { id: string }): BudgetTab {
  return {
    filePath: `/pdfs/${partial.id}.pdf`,
    fileSize: 10 * MB,
    lastActivatedAt: NOW - RECENT_ACTIVITY_WINDOW_MS - 1000,
    ...partial,
  };
}

function makeCtx(partial?: Partial<BudgetContext>): BudgetContext {
  return { activeTabId: null, now: NOW, ...partial };
}

const BYTE_BUDGET = 400 * MB;

describe("getByteBudget", () => {
  it("按平台返回预算", () => {
    expect(getByteBudget("Mozilla/5.0 (Macintosh; Intel Mac OS X)")).toBe(
      400 * MB
    );
    expect(getByteBudget("Mozilla/5.0 (Windows NT 10.0)")).toBe(800 * MB);
    expect(getByteBudget("Mozilla/5.0 (X11; Linux x86_64)")).toBe(400 * MB);
  });
});

describe("projectUsage", () => {
  it("按 filePath 去重、系数 ×2、排除休眠 tab", () => {
    const tabs = [
      makeTab({ id: "a", filePath: "/same.pdf", fileSize: 10 * MB }),
      makeTab({ id: "b", filePath: "/same.pdf", fileSize: 10 * MB }),
      makeTab({ id: "c", filePath: "/other.pdf", fileSize: 5 * MB }),
      makeTab({ id: "d", filePath: "/sleeping.pdf", hibernated: true }),
    ];
    expect(projectUsage(tabs)).toEqual({
      bytes: (10 + 5) * MB * 2 + 3 * BITMAP,
      aliveViewers: 3,
    });
  });

  it("fileSize 未知按 0 记账（位图仍按 viewer 记账）", () => {
    const tabs = [makeTab({ id: "a", fileSize: undefined })];
    expect(projectUsage(tabs).bytes).toBe(BITMAP);
  });

  it("newFile 计入预测；与存活 tab 同路径时不重复计", () => {
    const tabs = [makeTab({ id: "a", filePath: "/same.pdf" })];
    expect(
      projectUsage(tabs, { filePath: "/new.pdf", fileSize: 20 * MB })
    ).toEqual({ bytes: (10 + 20) * MB * 2 + 2 * BITMAP, aliveViewers: 2 });
    expect(
      projectUsage(tabs, { filePath: "/same.pdf", fileSize: 99 * MB })
    ).toEqual({ bytes: 10 * MB * 2 + BITMAP, aliveViewers: 1 });
  });
});

describe("selectHibernateCandidates", () => {
  it("预算内不选任何候选", () => {
    const tabs = [makeTab({ id: "a" }), makeTab({ id: "b" })];
    expect(
      selectHibernateCandidates(tabs, makeCtx(), undefined, BYTE_BUDGET)
    ).toEqual([]);
  });

  it("按 LRU（lastActivatedAt 升序）选择最少数量的候选", () => {
    const tabs = [
      makeTab({ id: "newest", lastActivatedAt: NOW - 10 * 60 * 1000 }),
      makeTab({ id: "oldest", lastActivatedAt: NOW - 60 * 60 * 1000 }),
      makeTab({ id: "middle", lastActivatedAt: NOW - 30 * 60 * 1000 }),
    ];
    // 3×10MB×2 文件 + 3×52MB 位图 = 216MB，预算 150MB：休眠 1 个最老的
    // （144MB）即可回落。
    const selected = selectHibernateCandidates(
      tabs,
      makeCtx(),
      undefined,
      150 * MB
    );
    expect(selected).toEqual(["oldest"]);
  });

  it("保护 active / secondary tab", () => {
    const tabs = [
      makeTab({ id: "active" }),
      makeTab({ id: "secondary" }),
      makeTab({ id: "victim" }),
    ];
    const selected = selectHibernateCandidates(
      tabs,
      makeCtx({ activeTabId: "active", secondaryTabId: "secondary" }),
      undefined,
      150 * MB // 需休眠 1 个
    );
    expect(selected).toEqual(["victim"]);
  });

  it("保护 5 分钟保护窗口内的 tab", () => {
    const tabs = [
      makeTab({ id: "recent", lastActivatedAt: NOW - 60 * 1000 }),
      makeTab({ id: "old" }),
    ];
    // 2 tab 记账 144MB，预算 100MB：recent 受保护，只能休眠 old（72MB）回落。
    const selected = selectHibernateCandidates(
      tabs,
      makeCtx(),
      undefined,
      100 * MB
    );
    expect(selected).toEqual(["old"]);
  });

  it("保护有流式会话的 tab", () => {
    const tabs = [makeTab({ id: "streaming" }), makeTab({ id: "idle" })];
    const selected = selectHibernateCandidates(
      tabs,
      makeCtx({ streamingTabIds: new Set(["streaming"]) }),
      undefined,
      100 * MB
    );
    expect(selected).toEqual(["idle"]);
  });

  it("跳过与其他存活 tab 共享路径的 tab（休眠不释放字节）", () => {
    const tabs = [
      makeTab({ id: "shared1", filePath: "/same.pdf" }),
      makeTab({ id: "shared2", filePath: "/same.pdf" }),
      makeTab({ id: "unique", filePath: "/unique.pdf" }),
    ];
    // 文件去重后 40MB + 3×52MB 位图 = 196MB，预算 150MB：
    // shared1/shared2 不可选，休眠 unique（124MB）回落。
    const selected = selectHibernateCandidates(
      tabs,
      makeCtx(),
      undefined,
      150 * MB
    );
    expect(selected).toEqual(["unique"]);
  });

  it("跳过与新文件共享路径的 tab", () => {
    const tabs = [
      makeTab({ id: "samePath", filePath: "/new.pdf" }),
      makeTab({ id: "other", filePath: "/other.pdf" }),
    ];
    const selected = selectHibernateCandidates(
      tabs,
      makeCtx(),
      { filePath: "/new.pdf", fileSize: 10 * MB },
      // newFile 与 samePath 同路径去重后记账 40MB 文件 + 2×52MB 位图 =
      // 144MB，超预算；休眠 samePath 不释放字节，只能休眠 other。
      100 * MB
    );
    expect(selected).toEqual(["other"]);
  });

  it("单文件超预算：候选耗尽后放行（返回已选中的全部）", () => {
    const tabs = [makeTab({ id: "only", fileSize: 10 * MB })];
    const selected = selectHibernateCandidates(
      tabs,
      makeCtx({ activeTabId: "only" }),
      { filePath: "/huge.pdf", fileSize: 500 * MB },
      BYTE_BUDGET
    );
    expect(selected).toEqual([]);
  });

  it("存活 viewer 数超限即使字节充足也触发休眠", () => {
    const tabs = Array.from({ length: ALIVE_VIEWER_BUDGET + 2 }, (_, i) =>
      makeTab({
        id: `t${i}`,
        fileSize: 1 * MB,
        // i 越小越老：t0 最久未激活
        lastActivatedAt: NOW - RECENT_ACTIVITY_WINDOW_MS - 60_000 + i * 1000,
      })
    );
    // t0 最老。存活 17 > 15，需休眠 2 个回落到 15。
    // 位图记账后默认 400MB 预算下 ~8 个 viewer 即触字节线，本用例注入
    // 足够大的字节预算，专测 viewer 数预算线本身。
    const selected = selectHibernateCandidates(
      tabs,
      makeCtx(),
      undefined,
      2048 * MB
    );
    expect(selected).toEqual(["t0", "t1"]);
  });

  it("小文件多 tab：位图记账使字节预算提前触发休眠", () => {
    // 文件本身仅 8×1MB×2 = 16MB，远低于 400MB 预算；
    // 但每存活 viewer 位图记账 52MB，8×(2+52) = 432MB 超预算，
    // 休眠 1 个最老 tab 后 7×54 = 378MB 回落。
    const tabs = Array.from({ length: 8 }, (_, i) =>
      makeTab({
        id: `t${i}`,
        fileSize: 1 * MB,
        lastActivatedAt: NOW - RECENT_ACTIVITY_WINDOW_MS - 60_000 + i * 1000,
      })
    );
    const selected = selectHibernateCandidates(
      tabs,
      makeCtx(),
      undefined,
      BYTE_BUDGET
    );
    expect(selected).toEqual(["t0"]);
  });

  it("唤醒场景：被唤醒 tab 作为 active 受到保护", () => {
    const tabs = [
      makeTab({ id: "waking", hibernated: false }),
      makeTab({ id: "victim" }),
    ];
    const selected = selectHibernateCandidates(
      tabs,
      makeCtx({ activeTabId: "waking" }),
      undefined,
      100 * MB
    );
    expect(selected).toEqual(["victim"]);
  });
});
