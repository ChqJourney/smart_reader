import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";

const SAMPLE_PDF_PATH = path.join(
  import.meta.dirname,
  "fixtures",
  "sample.pdf"
);
const SHORT_PAGES_PDF_PATH = path.join(
  import.meta.dirname,
  "fixtures",
  "sample-short-pages.pdf"
);
const JUMP_SETTLE_TIMEOUT = 1500;

async function setupTauriMock(
  page: import("@playwright/test").Page,
  pdfPath: string = SAMPLE_PDF_PATH
) {
  const pdfBytes = Array.from(fs.readFileSync(pdfPath));

  await page.addInitScript(
    ({ bytes, returnPath }) => {
      const arrayBuffer = new Uint8Array(bytes).buffer;
      (window as any).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args?: Record<string, unknown>) => {
          if (cmd === "plugin:dialog|open") {
            return returnPath;
          }
          if (cmd === "read_pdf_bytes") {
            return arrayBuffer;
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
            };
          }
          if (cmd === "load_recent_files") {
            return [];
          }
          if (cmd === "get_pdf_hash") {
            return "test-hash";
          }
          // Pretend a key exists so the first-run SetupWizard does not open
          // and overlay the UI under test.
          if (cmd === "check_api_key") return true;
          console.warn("Unhandled Tauri invoke command:", cmd, args);
          return undefined;
        },
      };
    },
    { bytes: pdfBytes, returnPath: "/test/sample.pdf" }
  );
}

/**
 * Determine which page is visually dominant in the continuous-mode container.
 * This matches the component's own logic: the visible page whose top edge is
 * closest to the top of the viewport is considered the current page.
 */
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

async function jumpToPage(
  page: import("@playwright/test").Page,
  target: number,
  settleTimeout = JUMP_SETTLE_TIMEOUT
) {
  // 工具栏页码按钮 → 打开跳页面板 → 输入页码回车
  await page.getByLabel("页码").click();
  const jumpInput = page.getByLabel("跳转到页");
  await jumpInput.fill(String(target));
  await jumpInput.press("Enter");
  await page.waitForTimeout(settleTimeout);
}

test.describe("PDF continuous mode page jump", () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMock(page);
    await page.goto("/");
  });

  test("jumping to a page scrolls to the correct page", async ({ page }) => {
    await page.getByTestId("open-pdf-btn").click();

    const pageInput = page.getByLabel("页码");
    await expect(pageInput).toBeVisible();

    await jumpToPage(page, 5);

    await expect(pageInput).toHaveText("5");
    expect(await getVisiblePage(page)).toBe(5);
  });

  test("jumping from a scrolled position lands on the right page", async ({
    page,
  }) => {
    await page.getByTestId("open-pdf-btn").click();

    const pageInput = page.getByLabel("页码");
    await expect(pageInput).toBeVisible();

    await jumpToPage(page, 8);
    await expect(pageInput).toHaveText("8");
    expect(await getVisiblePage(page)).toBe(8);

    await jumpToPage(page, 3);
    await expect(pageInput).toHaveText("3");
    expect(await getVisiblePage(page)).toBe(3);
  });

  test("multiple sequential jumps settle on the final requested page", async ({
    page,
  }) => {
    await page.getByTestId("open-pdf-btn").click();

    const pageInput = page.getByLabel("页码");
    await expect(pageInput).toBeVisible();

    await jumpToPage(page, 8, 400);
    await jumpToPage(page, 3, 400);
    await jumpToPage(page, 6, 400);
    await jumpToPage(page, 2, 1000);

    await expect(pageInput).toHaveText("2");
    expect(await getVisiblePage(page)).toBe(2);
  });

  test("jump remains accurate with a large viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.getByTestId("open-pdf-btn").click();

    const pageInput = page.getByLabel("页码");
    await expect(pageInput).toBeVisible();

    await jumpToPage(page, 5);
    await expect(pageInput).toHaveText("5");
    expect(await getVisiblePage(page)).toBe(5);
  });

  test("jump lands correctly on short pages in a large viewport", async ({
    page,
  }) => {
    await setupTauriMock(page, SHORT_PAGES_PDF_PATH);
    await page.goto("/");

    // A large viewport that fits more than one short page is the scenario where
    // the old centre-biased visible-page detector would report the wrong page.
    await page.setViewportSize({ width: 1280, height: 1300 });
    await page.getByTestId("open-pdf-btn").click();

    const pageInput = page.getByLabel("页码");
    await expect(pageInput).toBeVisible();

    await jumpToPage(page, 5);

    await expect(pageInput).toHaveText("5");
    expect(await getVisiblePage(page)).toBe(5);
  });

  test("page input must not drift after the jump lock releases", async ({
    page,
  }) => {
    await page.getByTestId("open-pdf-btn").click();

    const pageInput = page.getByLabel("页码");
    await expect(pageInput).toBeVisible();
    await expect(pageInput).toHaveText("1");

    const target = 5;
    await pageInput.click();
    const jumpInput = page.getByLabel("跳转到页");
    await jumpInput.fill(String(target));
    await jumpInput.press("Enter");

    // Poll the input value for several seconds. After it first reaches the
    // requested page it must never drift to a different page; any drift
    // indicates the visible-page detector raced with the jump.
    const sequence: string[] = [];
    const start = Date.now();
    while (Date.now() - start < 2500) {
      const value = (await pageInput.textContent()) ?? "";
      if (sequence[sequence.length - 1] !== value) {
        sequence.push(value);
      }
      await page.waitForTimeout(50);
    }

    const targetIndex = sequence.indexOf(String(target));
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    const afterTarget = sequence.slice(targetIndex + 1);
    expect(afterTarget).toEqual([]);
    expect(await getVisiblePage(page)).toBe(target);
  });
});

test.describe("PDF jump panel and page rail", () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMock(page);
    await page.goto("/");
  });

  test("Ctrl+G opens the jump panel, Enter jumps and flashes the page number", async ({
    page,
  }) => {
    await page.getByTestId("open-pdf-btn").click();

    const pageInput = page.getByLabel("页码");
    await expect(pageInput).toBeVisible();

    await page.keyboard.press("Control+g");
    const jumpInput = page.getByLabel("跳转到页");
    await expect(jumpInput).toBeVisible();

    await jumpInput.fill("5");
    await jumpInput.press("Enter");

    // 跳转生效、面板关闭、闪卡出现随后消失
    await expect(pageInput).toHaveText("5");
    expect(await getVisiblePage(page)).toBe(5);
    await expect(jumpInput).toBeHidden();

    const flash = page.locator(".pdf-page-flash");
    await expect(flash).toHaveText("5");
    await expect(flash).toBeHidden({ timeout: 2000 });
  });

  test("Escape closes the jump panel without jumping", async ({ page }) => {
    await page.getByTestId("open-pdf-btn").click();

    const pageInput = page.getByLabel("页码");
    await expect(pageInput).toBeVisible();
    await expect(pageInput).toHaveText("1");

    await page.keyboard.press("Control+g");
    const jumpInput = page.getByLabel("跳转到页");
    await expect(jumpInput).toBeVisible();
    await jumpInput.fill("4");
    await page.keyboard.press("Escape");

    await expect(jumpInput).toBeHidden();
    await expect(pageInput).toHaveText("1");
  });

  test("dragging the page rail scrolls to the target page", async ({
    page,
  }) => {
    await page.getByTestId("open-pdf-btn").click();

    const pageInput = page.getByLabel("页码");
    await expect(pageInput).toBeVisible();

    const rail = page.locator(".page-rail");
    await expect(rail).toBeVisible();

    // 总页数从工具栏 "/ N" 读出
    const infoText = await page.locator(".page-info").innerText();
    const total = parseInt(infoText.match(/\/\s*(\d+)/)![1], 10);
    expect(total).toBeGreaterThan(1);

    // 拖到滑轨最底部 → 最后一页；拖动中 tooltip 可见
    const box = (await rail.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 10);
    await page.mouse.down();
    await expect(page.locator(".page-rail-tip")).toBeVisible();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height, {
      steps: 10,
    });
    await page.mouse.up();
    await page.waitForTimeout(JUMP_SETTLE_TIMEOUT);

    await expect(pageInput).toHaveText(String(total));
    expect(await getVisiblePage(page)).toBe(total);

    // 拖回顶部 → 第 1 页
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 10);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(JUMP_SETTLE_TIMEOUT);

    await expect(pageInput).toHaveText("1");
    expect(await getVisiblePage(page)).toBe(1);
  });
});
