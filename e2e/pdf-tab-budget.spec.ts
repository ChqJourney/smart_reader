import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";

/**
 * Tab 休眠（hibernation）e2e：内存预算触发休眠 + 唤醒恢复回归，
 * 以及 per-tab 内存成本测量（docs/TAB_HIBERNATION_DESIGN.md §9）。
 *
 * 5 分钟保护窗口在 e2e 里等不起：init script 包一层 Date.now，
 * 每次 get_pdf_hash（即每开一个新 tab）把假时间拨快 6 分钟，
 * 让先开的 tab 越过 RECENT_ACTIVITY_WINDOW 成为合法休眠候选。
 */

const SAMPLE_PDF_PATH = path.join(
  import.meta.dirname,
  "fixtures",
  "sample.pdf"
);

interface MockOptions {
  /** get_pdf_file_size 的返回值（MB），决定字节预算何时超限。 */
  fileSizeMB: number;
  /** 每开一个新 tab 假时间拨快的分钟数（0 = 不拨快，全部在保护窗口内）。 */
  advanceMinutesPerOpen: number;
  /** 要打开的 tab 路径数量（循环使用）。 */
  tabCount: number;
}

async function setupBudgetTauriMock(
  page: import("@playwright/test").Page,
  { fileSizeMB, advanceMinutesPerOpen, tabCount }: MockOptions
) {
  const pdfBytes = Array.from(fs.readFileSync(SAMPLE_PDF_PATH));
  const paths = Array.from(
    { length: tabCount },
    (_, i) => `/test/budget-${i}.pdf`
  );

  await page.addInitScript(
    ({ bytes, paths, fileSizeMB, advanceMinutesPerOpen }) => {
      let openIndex = 0;

      // 假时间：每开一个新 tab 拨快 N 分钟，越过 5 分钟休眠保护窗口。
      let fakeOffsetMs = 0;
      const realNow = Date.now.bind(Date);
      Date.now = () => realNow() + fakeOffsetMs;

      (window as any).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args?: Record<string, unknown>) => {
          if (cmd === "plugin:dialog|open") {
            const index = openIndex % paths.length;
            openIndex += 1;
            return paths[index];
          }
          if (cmd === "read_pdf_bytes") {
            // 每次调用返回全新 buffer：pdfjs 加载时会 detach 传入的
            // ArrayBuffer，共享同一 buffer 会让后续读取抛
            // "Construct on a detached ArrayBuffer"（真实后端每次重新读盘）。
            return new Uint8Array(bytes).buffer;
          }
          if (cmd === "load_pdf_data") {
            return { annotations: [], sessionIds: [] };
          }
          if (cmd === "save_pdf_data") {
            return undefined;
          }
          if (cmd === "load_settings") {
            return {
              llm: {
                baseUrl: "https://api.openai.com/v1",
                apiKey: "",
                model: "gpt-4o-mini",
              },
              targetLanguage: "中文",
              hoverTranslate: false,
            };
          }
          if (cmd === "load_recent_files") {
            return [];
          }
          if (cmd === "get_pdf_hash") {
            fakeOffsetMs += advanceMinutesPerOpen * 60 * 1000;
            const filePath = (args as { filePath: string } | undefined)
              ?.filePath;
            return `hash-${filePath}`;
          }
          if (cmd === "get_pdf_file_size") {
            return fileSizeMB * 1024 * 1024;
          }
          if (cmd === "authorize_pdf_path") {
            return undefined;
          }
          // Pretend a key exists so the first-run SetupWizard does not open
          // and overlay the UI under test.
          if (cmd === "check_api_key") return true;
          console.warn("Unhandled Tauri invoke command:", cmd, args);
          return undefined;
        },
      };
    },
    { bytes: pdfBytes, paths, fileSizeMB, advanceMinutesPerOpen }
  );
}

/** keep-alive：非激活 tab 的 viewer 常驻 DOM，查询统一 scope 到可见面板。 */
function activePanel(page: import("@playwright/test").Page) {
  return page.locator(".pdf-panel:not(.viewer-hidden)");
}

async function waitForPdfLoaded(page: import("@playwright/test").Page) {
  const pageInput = activePanel(page).getByLabel("页码");
  await expect(pageInput).toBeVisible();
  await expect(pageInput).toBeEnabled();
  await page.waitForTimeout(1000);
}

async function jumpToPage(
  page: import("@playwright/test").Page,
  target: number
) {
  const pageButton = activePanel(page).getByLabel("页码");
  await expect(pageButton).toBeEnabled();
  await pageButton.click();
  const jumpInput = activePanel(page).getByLabel("跳转到页");
  await jumpInput.fill(String(target));
  await jumpInput.press("Enter");
  await page.waitForTimeout(1500);
}

test.describe("Tab hibernation（休眠/唤醒回归）", () => {
  test("字节预算超限休眠最久未用 tab，切回唤醒后页码恢复", async ({
    page,
  }, testInfo) => {
    // 每个文件记账 600MB（300MB×2），任何平台预算下开第 3 个都会休眠第 1 个。
    await setupBudgetTauriMock(page, {
      fileSizeMB: 300,
      advanceMinutesPerOpen: 6,
      tabCount: 3,
    });
    await page.goto("/");

    // 打开 tab1 并跳到第 3 页（休眠前的阅读位置）
    await page.getByTestId("open-pdf-btn").click();
    await waitForPdfLoaded(page);
    await jumpToPage(page, 3);
    await expect(activePanel(page).getByLabel("页码")).toHaveText("3");

    // 开 tab2（tab1 是 active 受保护）、tab3（tab1 被休眠）
    await page.getByTestId("open-pdf-btn").click();
    await expect(
      page.locator(".tab-item", { hasText: "budget-1.pdf" })
    ).toBeVisible();
    await page.getByTestId("open-pdf-btn").click();
    await expect(
      page.locator(".tab-item", { hasText: "budget-2.pdf" })
    ).toBeVisible();

    // tab 外壳全部保留（不置灰不标记），viewer 卸载 1 个
    await expect(page.locator(".tab-item")).toHaveCount(3);
    await expect(page.locator(".hibernated-placeholder")).toHaveCount(1);

    // 切回 tab1：透明唤醒，走冷启动恢复路径
    const wakeStart = Date.now();
    await page.locator(".tab-item", { hasText: "budget-0.pdf" }).click();
    const pageInput = activePanel(page).getByLabel("页码");
    await expect(pageInput).toHaveText("3", { timeout: 5000 });
    const wakeMs = Date.now() - wakeStart;
    testInfo.annotations.push({
      type: "wake-latency-ms",
      description: String(wakeMs),
    });
    console.log(`[tab-budget] wake latency: ${wakeMs}ms`);

    // 唤醒同样挤占预算：tab2 被休眠顶替，占位仍为 1
    await expect(page.locator(".hibernated-placeholder")).toHaveCount(1);
    // 页码恢复与休眠前一致
    await expect(pageInput).toHaveText("3");
  });

  test("存活 viewer 数上限触发休眠，tab 数量不受限", async ({ page }) => {
    // 小文件碰不到字节线；第 16 / 17 个 tab 触发 viewer 数预算休眠。
    await setupBudgetTauriMock(page, {
      fileSizeMB: 1,
      advanceMinutesPerOpen: 6,
      tabCount: 17,
    });
    await page.goto("/");

    for (let i = 0; i < 17; i++) {
      await page.getByTestId("open-pdf-btn").click();
      await expect(
        page.locator(".tab-item", { hasText: `budget-${i}.pdf` })
      ).toBeVisible();
    }

    await expect(page.locator(".tab-item")).toHaveCount(17);
    // 存活 viewer 收敛到 15：第 16、17 次打开各休眠 1 个最久未用 tab
    await expect(page.locator(".hibernated-placeholder")).toHaveCount(2);

    // 切回最早打开的 tab：唤醒恢复，占位数量不变（他人被顶替休眠）
    await page.locator(".tab-item", { hasText: "budget-0.pdf" }).click();
    await expect(activePanel(page).getByLabel("页码")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator(".hibernated-placeholder")).toHaveCount(2);
  });
});

test.describe("Tab budget measurement（per-tab 成本测量）", () => {
  test("循环开 tab 记录 usedJSHeapSize 与切 tab 耗时", async ({
    page,
  }, testInfo) => {
    // 不拨快假时间 + 开 12 个（低于 15 存活上限）：全程无休眠干扰，
    // 测的是纯 keep-alive 的 per-tab 成本。Playwright 跑 Chromium 仅用于
    // 相对趋势；绝对值以打包后真实 WebView 手动 soak 为准。
    await setupBudgetTauriMock(page, {
      fileSizeMB: 1,
      advanceMinutesPerOpen: 0,
      tabCount: 12,
    });
    await page.goto("/");

    const samples: Array<{ tab: number; heapMB: number | null }> = [];
    for (let i = 0; i < 12; i++) {
      await page.getByTestId("open-pdf-btn").click();
      await expect(
        page.locator(".tab-item", { hasText: `budget-${i}.pdf` })
      ).toBeVisible();
      await page.waitForTimeout(500);
      const heapBytes = await page.evaluate(
        () =>
          (performance as unknown as { memory?: { usedJSHeapSize: number } })
            .memory?.usedJSHeapSize ?? null
      );
      samples.push({
        tab: i + 1,
        heapMB: heapBytes === null ? null : Math.round(heapBytes / 2 ** 20),
      });
    }

    // 切 tab 耗时：点击 → 两帧渲染完成
    const switchStart = Date.now();
    await page.locator(".tab-item", { hasText: "budget-0.pdf" }).click();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        )
    );
    const switchMs = Date.now() - switchStart;

    const report = { samples, switchMs };
    console.log(`[tab-budget] measurement: ${JSON.stringify(report)}`);
    await testInfo.attach("tab-budget-measurement", {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });

    // 测量 spec 不设硬阈值（校准常量用）；仅保证流程本身生效
    await expect(page.locator(".tab-item")).toHaveCount(12);
    await expect(page.locator(".hibernated-placeholder")).toHaveCount(0);
  });
});
