import { test, expect } from "@playwright/test";
import { setupTauriMock, getVisiblePage } from "./tauri-mock";

// sample.pdf 共 10 页，每页只有 "PAGE N" 一个 text item。
test.describe("PDF full-text search", () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMock(page, {
      pdfs: [{ path: "/test/sample.pdf", fixture: "sample.pdf" }],
    });
    await page.goto("/");
    await page.getByTestId("open-pdf-btn").click();
    await expect(page.getByLabel("页码")).toBeVisible();
  });

  test("search finds the unique match, highlights it and scrolls to its page", async ({
    page,
  }) => {
    await page.keyboard.press("Control+f");
    const input = page.locator(".pdf-search-input");
    await expect(input).toBeVisible();
    await input.fill("PAGE 3");

    // 计数与高亮出现（250ms 防抖 + 全量建索引由断言轮询覆盖）。
    await expect(page.locator(".pdf-search-count")).toHaveText(
      "第 1 / 共 1 个"
    );
    await expect(page.locator(".pdf-search-highlight")).toHaveCount(1);
    await expect(page.locator(".pdf-search-highlight.active")).toBeVisible();

    // 命中后自动滚动到匹配页。
    await expect(page.getByLabel("页码")).toHaveText("3");
    expect(await getVisiblePage(page)).toBe(3);
  });

  test("Enter / Shift+Enter navigate between matches", async ({ page }) => {
    await page.keyboard.press("Control+f");
    const input = page.locator(".pdf-search-input");
    await expect(input).toBeVisible();
    await input.fill("PAGE");

    await expect(page.locator(".pdf-search-count")).toHaveText(
      "第 1 / 共 10 个"
    );

    await input.press("Enter");
    await expect(page.locator(".pdf-search-count")).toHaveText(
      "第 2 / 共 10 个"
    );
    await expect(page.getByLabel("页码")).toHaveText("2");
    expect(await getVisiblePage(page)).toBe(2);

    await input.press("Shift+Enter");
    await expect(page.locator(".pdf-search-count")).toHaveText(
      "第 1 / 共 10 个"
    );
    await expect(page.getByLabel("页码")).toHaveText("1");
    expect(await getVisiblePage(page)).toBe(1);
  });

  test("query with no match shows the empty state", async ({ page }) => {
    await page.keyboard.press("Control+f");
    const input = page.locator(".pdf-search-input");
    await expect(input).toBeVisible();
    await input.fill("NONEXISTENT-TERM");

    await expect(page.locator(".pdf-search-count")).toHaveText("无匹配结果");
    await expect(page.locator(".pdf-search-highlight")).toHaveCount(0);
  });
});
