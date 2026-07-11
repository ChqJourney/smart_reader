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
  const pageInput = page.getByLabel("页码");
  await pageInput.fill(String(target));
  await pageInput.press("Enter");
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

    await expect(pageInput).toHaveValue("5");
    expect(await getVisiblePage(page)).toBe(5);
  });

  test("jumping from a scrolled position lands on the right page", async ({
    page,
  }) => {
    await page.getByTestId("open-pdf-btn").click();

    const pageInput = page.getByLabel("页码");
    await expect(pageInput).toBeVisible();

    await jumpToPage(page, 8);
    await expect(pageInput).toHaveValue("8");
    expect(await getVisiblePage(page)).toBe(8);

    await jumpToPage(page, 3);
    await expect(pageInput).toHaveValue("3");
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

    await expect(pageInput).toHaveValue("2");
    expect(await getVisiblePage(page)).toBe(2);
  });

  test("jump remains accurate with a large viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.getByTestId("open-pdf-btn").click();

    const pageInput = page.getByLabel("页码");
    await expect(pageInput).toBeVisible();

    await jumpToPage(page, 5);
    await expect(pageInput).toHaveValue("5");
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

    await expect(pageInput).toHaveValue("5");
    expect(await getVisiblePage(page)).toBe(5);
  });

  test("page input must not drift after the jump lock releases", async ({
    page,
  }) => {
    await page.getByTestId("open-pdf-btn").click();

    const pageInput = page.getByLabel("页码");
    await expect(pageInput).toBeVisible();
    await expect(pageInput).toHaveValue("1");

    const target = 5;
    await pageInput.fill(String(target));
    await pageInput.press("Enter");

    // Poll the input value for several seconds. After it first reaches the
    // requested page it must never drift to a different page; any drift
    // indicates the visible-page detector raced with the jump.
    const sequence: string[] = [];
    const start = Date.now();
    while (Date.now() - start < 2500) {
      const value = await pageInput.inputValue();
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
