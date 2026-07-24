import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";

/**
 * Regression tests for three large-document (>50 pages, i.e. beyond the
 * viewport-preload window) bugs:
 *  1. fit-to-width shifted the page left (stale-scale off-screen pages
 *     inflated scrollWidth and the fit-center logic centered the content
 *     instead of the current page).
 *  2. repeated zoom / fit-to-width made the page jump and the page number
 *     flicker (zoom restore read one-commit-stale geometry; page detection
 *     had no dead zone at page boundaries).
 *  3. rapid tab switching reset the tab to page 1 (the restore window was
 *     unsuppressed, so a scroll/resize event clobbered the tab record before
 *     the restore completed).
 */

const LONG_PDF_PATH = path.join(
  import.meta.dirname,
  "fixtures",
  "sample-long.pdf"
);
const SAMPLE_PDF_PATH = path.join(
  import.meta.dirname,
  "fixtures",
  "sample.pdf"
);

async function setupLargeDocTauriMock(page: import("@playwright/test").Page) {
  const longBytes = Array.from(fs.readFileSync(LONG_PDF_PATH));
  const sampleBytes = Array.from(fs.readFileSync(SAMPLE_PDF_PATH));
  const paths = ["/test/sample-long.pdf", "/test/sample.pdf"];
  const hashes = ["hash-long", "hash-sample"];

  await page.addInitScript(
    ({ longBytes, sampleBytes, paths, hashes }) => {
      const longBuffer = new Uint8Array(longBytes).buffer;
      const sampleBuffer = new Uint8Array(sampleBytes).buffer;
      let openIndex = 0;

      (window as any).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args?: Record<string, unknown>) => {
          if (cmd === "plugin:dialog|open") {
            const index = openIndex % paths.length;
            openIndex += 1;
            return paths[index];
          }
          if (cmd === "read_pdf_bytes") {
            const filePath = (args as { filePath: string } | undefined)
              ?.filePath;
            return filePath === paths[1] ? sampleBuffer : longBuffer;
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
            const filePath = (args as { filePath: string } | undefined)
              ?.filePath;
            const index = paths.indexOf(filePath ?? "");
            return index >= 0 ? hashes[index] : "test-hash";
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
    { longBytes, sampleBytes, paths, hashes }
  );
}

/** The page whose top edge is closest to the container top (same rule as the app). */
async function getVisiblePage(
  page: import("@playwright/test").Page
): Promise<number | null> {
  return page.evaluate(() => {
    const container = document.querySelector(
      ".pdf-canvas-container.continuous"
    ) as HTMLElement | null;
    if (!container) return null;

    const containerRect = container.getBoundingClientRect();
    const wrappers = Array.from(
      document.querySelectorAll(".pdf-page-wrapper")
    ) as HTMLElement[];

    let bestPage = 1;
    let bestDistance = Infinity;

    wrappers.forEach((wrapper, index) => {
      const rect = wrapper.getBoundingClientRect();
      if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom)
        return;

      const distance = Math.abs(rect.top - containerRect.top);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestPage = index + 1;
      }
    });

    return bestPage;
  });
}

async function getScrollLeft(
  page: import("@playwright/test").Page
): Promise<number> {
  return page.evaluate(() => {
    const container = document.querySelector(
      ".pdf-canvas-container.continuous"
    ) as HTMLElement | null;
    return container ? container.scrollLeft : -1;
  });
}

async function waitForPdfLoaded(page: import("@playwright/test").Page) {
  const pageInput = page.getByLabel("页码");
  await expect(pageInput).toBeVisible();
  await expect(pageInput).toBeEnabled();
}

async function jumpToPage(
  page: import("@playwright/test").Page,
  target: number,
  settleTimeout = 1500
) {
  // 工具栏页码按钮 → 打开跳页面板 → 输入页码回车
  await page.getByLabel("页码").click();
  const jumpInput = page.getByLabel("跳转到页");
  await jumpInput.fill(String(target));
  await jumpInput.press("Enter");
  await page.waitForTimeout(settleTimeout);
}

/**
 * On a large document the first jump lands approximately (pages above the
 * target may still have placeholder heights while their viewports self-load).
 * Jumping again after the self-load storm settles lands exactly.
 */
async function jumpToPageExactly(
  page: import("@playwright/test").Page,
  target: number
) {
  await jumpToPage(page, target, 2500);
  await jumpToPage(page, target, 1500);
  await expect
    .poll(() => getVisiblePage(page), { timeout: 10000 })
    .toBe(target);
}

test.describe("Large document (>50 pages) zoom / fit / tab restore", () => {
  test.beforeEach(async ({ page }) => {
    await setupLargeDocTauriMock(page);
    await page.goto("/");
  });

  test("fit-to-width does not shift the page horizontally", async ({
    page,
  }) => {
    await page.getByTestId("open-pdf-btn").click();
    await waitForPdfLoaded(page);

    // Browse deep into the document, then zoom in so pages are wider than the
    // container — the reported pre-fit state.
    await jumpToPageExactly(page, 40);

    const zoomInButton = page.getByLabel("放大");
    await zoomInButton.click();
    await page.waitForTimeout(600);
    await zoomInButton.click();
    await page.waitForTimeout(1000);

    // Fit to width: zooms back out. Pages outside the preload window still
    // hold larger-scale sizes; the fit must not let them push the current
    // page sideways.
    await page.getByLabel("适合宽度").click();
    await page.waitForTimeout(2000);

    // The fitted page fills the container exactly, so no horizontal offset.
    expect(await getScrollLeft(page)).toBeLessThanOrEqual(2);
    // And we are still on the same page.
    expect(await getVisiblePage(page)).toBe(40);
  });

  test("repeated zoom at depth keeps the page number stable", async ({
    page,
  }) => {
    await page.getByTestId("open-pdf-btn").click();
    await waitForPdfLoaded(page);

    await jumpToPageExactly(page, 30);

    const zoomInButton = page.getByLabel("放大");
    const zoomOutButton = page.getByLabel("缩小");
    await zoomInButton.click();
    await page.waitForTimeout(500);
    await zoomInButton.click();
    await page.waitForTimeout(800);
    await zoomOutButton.click();
    await page.waitForTimeout(500);
    await zoomOutButton.click();

    // Poll the page input for 2.5s: once it reaches 30 it must never drift
    // to a neighbouring page (the boundary flip-flop regression).
    const pageInput = page.getByLabel("页码");
    const sequence: string[] = [];
    const start = Date.now();
    while (Date.now() - start < 2500) {
      const value = (await pageInput.textContent()) ?? "";
      if (sequence[sequence.length - 1] !== value) {
        sequence.push(value);
      }
      await page.waitForTimeout(50);
    }

    const targetIndex = sequence.indexOf("30");
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    expect(sequence.slice(targetIndex + 1)).toEqual([]);
    expect(await getVisiblePage(page)).toBe(30);
  });

  test("rapid tab switching still restores the deep page", async ({ page }) => {
    // Tab 1: long document, deep page.
    await page.getByTestId("open-pdf-btn").click();
    await waitForPdfLoaded(page);
    await jumpToPageExactly(page, 40);

    // Tab 2: small document.
    await page.getByTestId("open-pdf-btn").click();
    await expect(
      page.locator(".tab-item", { hasText: "sample.pdf" })
    ).toBeVisible();
    await waitForPdfLoaded(page);

    // Switch to tab 1 and away again quickly — inside the restore window,
    // where an unsuppressed page-sync would clobber the tab record to page 1.
    await page.locator(".tab-item", { hasText: "sample-long.pdf" }).click();
    await page.waitForTimeout(120);
    await page.locator(".tab-item", { hasText: "sample.pdf" }).click();
    await page.waitForTimeout(400);

    // Final switch back: the restore must land on page 40, not page 1.
    await page.locator(".tab-item", { hasText: "sample-long.pdf" }).click();

    const pageInput = page.getByLabel("页码");
    await expect(pageInput).toHaveText("40", { timeout: 15000 });
    await expect.poll(() => getVisiblePage(page), { timeout: 15000 }).toBe(40);
  });
});
