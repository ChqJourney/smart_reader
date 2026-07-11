import { test, expect } from "@playwright/test";

test.describe("App E2E", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("renders the main layout", async ({ page }) => {
    await expect(page.getByLabel("最近打开的文件")).toBeVisible();
    await expect(page.getByTestId("open-pdf-btn")).toBeVisible();
  });

  test("toggles PDF panel", async ({ page }) => {
    const hidePdfButton = page.getByTitle("隐藏 PDF 面板");
    await expect(hidePdfButton).toBeVisible();

    await hidePdfButton.click();
    await expect(hidePdfButton).not.toBeVisible();
    await expect(page.getByTitle("显示 PDF")).toBeVisible();

    await page.getByTitle("显示 PDF").click();
    await expect(page.getByTitle("隐藏 PDF 面板")).toBeVisible();
  });

  test("toggles AI panel", async ({ page }) => {
    const hideAiButton = page.getByTitle("隐藏面板");
    await expect(hideAiButton).toBeVisible();

    await hideAiButton.click();
    await expect(hideAiButton).not.toBeVisible();
    await expect(page.getByTitle("显示 AI 助手")).toBeVisible();

    await page.getByTitle("显示 AI 助手").click();
    await expect(page.getByTitle("隐藏面板")).toBeVisible();
  });

  test("opens and closes settings", async ({ page }) => {
    await page.getByRole("button", { name: "打开设置" }).click();
    await expect(
      page.getByPlaceholder("https://api.openai.com/v1")
    ).toBeVisible();
    await expect(page.getByPlaceholder("sk-...")).toBeVisible();

    await page.getByRole("button", { name: "取消" }).click();
    await expect(
      page.getByPlaceholder("https://api.openai.com/v1")
    ).not.toBeVisible();
  });
});
