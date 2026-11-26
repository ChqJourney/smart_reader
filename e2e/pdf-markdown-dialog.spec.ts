import { expect, test } from "@playwright/test";
import { setupTauriMock } from "./tauri-mock";

test.describe("AI reply markdown dialogs", () => {
  test("keeps the expanded SVG scroll position stable", async ({ page }) => {
    await setupTauriMock(page, {
      pdfs: [{ path: "/test/sample.pdf", fixture: "sample.pdf" }],
      streamChunks: [
        '<svg viewBox="0 0 100 1600" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="1600" fill="red" /></svg>',
        ...Array.from({ length: 10 }, (_, index) => `\n\n后续说明 ${index}`),
      ],
      streamIntervalMs: 200,
    });
    await page.goto("/");
    await page.getByTestId("open-pdf-btn").click();
    const input = page.getByPlaceholder("就当前文档向 AI 提问…");
    await input.fill("画图");
    await input.press("Enter");
    await page.getByRole("button", { name: "放大 SVG" }).click();

    const stage = page.locator(".markdown-svg-dialog-stage");
    await expect(stage).toBeVisible();
    await stage.hover();
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(300);
    const scrolled = await stage.evaluate((element) => element.scrollTop);
    expect(scrolled).toBeGreaterThan(0);
    await page.waitForTimeout(1500);
    expect(await stage.evaluate((element) => element.scrollTop)).toBe(scrolled);
  });
});
