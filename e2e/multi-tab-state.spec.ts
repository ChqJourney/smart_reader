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

async function setupMultiTabTauriMock(page: import("@playwright/test").Page) {
  const sampleBytes = Array.from(fs.readFileSync(SAMPLE_PDF_PATH));
  const shortBytes = Array.from(fs.readFileSync(SHORT_PAGES_PDF_PATH));
  const paths = ["/test/sample.pdf", "/test/sample-short-pages.pdf"];
  const hashes = ["hash-sample", "hash-short-pages"];

  await page.addInitScript(
    ({ sampleBytes, shortBytes, paths, hashes }) => {
      const sampleBuffer = new Uint8Array(sampleBytes).buffer;
      const shortBuffer = new Uint8Array(shortBytes).buffer;
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
            return filePath === paths[1] ? shortBuffer : sampleBuffer;
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
          console.warn("Unhandled Tauri invoke command:", cmd, args);
          return undefined;
        },
      };
    },
    { sampleBytes, shortBytes, paths, hashes }
  );
}

async function waitForPdfLoaded(page: import("@playwright/test").Page) {
  const pageInput = page.getByLabel("页码");
  await expect(pageInput).toBeVisible();
  await expect(pageInput).toBeEnabled();
  await page.waitForTimeout(1000);
}

async function jumpToPage(
  page: import("@playwright/test").Page,
  target: number
) {
  const pageInput = page.getByLabel("页码");
  await expect(pageInput).toBeEnabled();
  await pageInput.click();
  await pageInput.fill(String(target));
  await pageInput.press("Enter");
  await page.waitForTimeout(1500);
}

test.describe("Multi-tab state isolation", () => {
  test.beforeEach(async ({ page }) => {
    await setupMultiTabTauriMock(page);
    await page.goto("/");
  });

  test("page number is isolated between tabs", async ({ page }) => {
    // Open first PDF and jump to page 5.
    await page.getByTestId("open-pdf-btn").click();
    await waitForPdfLoaded(page);
    const pageInput = page.getByLabel("页码");
    await jumpToPage(page, 5);
    await expect(pageInput).toHaveValue("5");

    // Open second PDF and jump to page 3.
    await page.getByTestId("open-pdf-btn").click();
    await expect(
      page.locator(".tab-item", { hasText: "sample-short-pages.pdf" })
    ).toBeVisible();
    await waitForPdfLoaded(page);
    await jumpToPage(page, 3);
    await expect(pageInput).toHaveValue("3");

    // Switch back to the first tab; it should still be on page 5.
    await page.locator(".tab-item", { hasText: "sample.pdf" }).click();
    await waitForPdfLoaded(page);
    await expect(pageInput).toHaveValue("5");

    // Switch to the second tab again; it should still be on page 3.
    await page
      .locator(".tab-item", { hasText: "sample-short-pages.pdf" })
      .click();
    await waitForPdfLoaded(page);
    await expect(pageInput).toHaveValue("3");
  });

  test("closing active tab keeps the other tab's page state", async ({
    page,
  }) => {
    // Open both PDFs.
    await page.getByTestId("open-pdf-btn").click();
    await waitForPdfLoaded(page);
    await jumpToPage(page, 5);

    await page.getByTestId("open-pdf-btn").click();
    await expect(
      page.locator(".tab-item", { hasText: "sample-short-pages.pdf" })
    ).toBeVisible();
    await waitForPdfLoaded(page);
    await jumpToPage(page, 3);

    // Close the active tab (sample-short-pages.pdf).
    const closeButton = page
      .locator(".tab-item", { hasText: "sample-short-pages.pdf" })
      .locator("button[title='关闭标签页']");
    await closeButton.click();

    // The remaining tab should still be on page 5.
    await waitForPdfLoaded(page);
    const pageInput = page.getByLabel("页码");
    await expect(pageInput).toHaveValue("5");
    await expect(
      page.locator(".tab-item", { hasText: "sample.pdf" })
    ).toBeVisible();
  });

  test("annotations do not leak between tabs", async ({ page }) => {
    // Open first PDF and create a stash annotation.
    await page.getByTestId("open-pdf-btn").click();
    await page.waitForTimeout(500);

    // Select some text in the first PDF by clicking the text overlay.
    const overlay = page.locator(".pdf-selection-overlay").first();
    await expect(overlay).toBeVisible();
    await overlay.click({ position: { x: 467, y: 540 } });
    await page.waitForTimeout(200);

    // The selection toolbar should appear.
    const stashButton = page.getByRole("button", { name: /加入暂存/i });
    await expect(stashButton).toBeVisible();
    await stashButton.click();

    // The stash should appear in the right panel.
    await expect(
      page.getByRole("tab", { name: /暂存区 \(1\)/i })
    ).toBeVisible();

    // Open second PDF.
    await page.getByTestId("open-pdf-btn").click();
    await expect(
      page.locator(".tab-item", { hasText: "sample-short-pages.pdf" })
    ).toBeVisible();
    await page.waitForTimeout(500);

    // The second tab should not show the first tab's stash.
    await expect(
      page.getByRole("tab", { name: /暂存区 \(0\)/i })
    ).toBeVisible();

    // Switch back to the first tab; the stash should still be there.
    await page.locator(".tab-item", { hasText: "sample.pdf" }).click();
    await expect(
      page.getByRole("tab", { name: /暂存区 \(1\)/i })
    ).toBeVisible();
  });

  test("selecting text in one tab does not reset another tab's page", async ({
    page,
  }) => {
    // Open first PDF and jump to page 5.
    await page.getByTestId("open-pdf-btn").click();
    await waitForPdfLoaded(page);
    const pageInput = page.getByLabel("页码");
    await jumpToPage(page, 5);
    await expect(pageInput).toHaveValue("5");

    // Open second PDF and jump to page 3.
    await page.getByTestId("open-pdf-btn").click();
    await expect(
      page.locator(".tab-item", { hasText: "sample-short-pages.pdf" })
    ).toBeVisible();
    await waitForPdfLoaded(page);
    await jumpToPage(page, 3);
    await expect(pageInput).toHaveValue("3");

    // Switch back to the first tab and select some text there.
    await page.locator(".tab-item", { hasText: "sample.pdf" }).click();
    await waitForPdfLoaded(page);
    // Tab1 is restored to page 5. Scroll back to the top so the first page's
    // overlay is interactable, then select text. This test verifies that
    // selecting text in one tab does not reset the other tab's page; tab1's
    // own scroll retention is covered by the page-isolation test.
    await page.evaluate(() => {
      const c = document.querySelector(
        ".pdf-canvas-container.continuous"
      ) as HTMLElement | null;
      if (c) c.scrollTop = 0;
    });
    await page.waitForTimeout(500);
    const overlay = page.locator(".pdf-selection-overlay").first();
    await expect(overlay).toBeVisible();
    await overlay.click({ position: { x: 467, y: 540 } });
    await page.waitForTimeout(200);

    // The selection toolbar should appear in the first tab.
    await expect(page.getByRole("button", { name: /加入暂存/i })).toBeVisible();

    // Switch to the second tab; it should still be on page 3 (not reset to 1).
    await page
      .locator(".tab-item", { hasText: "sample-short-pages.pdf" })
      .click();
    await waitForPdfLoaded(page);
    await expect(pageInput).toHaveValue("3");
  });
});
