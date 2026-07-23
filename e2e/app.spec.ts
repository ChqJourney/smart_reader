import { test, expect } from "@playwright/test";

test.describe("App E2E", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      // No real Tauri backend in E2E. check_api_key must report "configured"
      // or the first-run SetupWizard opens and overlays the UI under test.
      // Everything else keeps rejecting, same as without a mock.
      (window as any).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string) => {
          if (cmd === "check_api_key") return true;
          throw new Error(`Unhandled Tauri invoke command: ${cmd}`);
        },
      };
    });
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
    // The mock reports every platform's API key as configured (to keep the
    // first-run wizard closed), so the key input shows the "configured"
    // placeholder instead of "sk-...".
    const dialog = page.getByRole("dialog", { name: "设置" });
    await expect(dialog).toBeVisible();
    await expect(
      page.getByPlaceholder("已配置（输入新 key 覆盖）")
    ).toBeVisible();

    await page.getByRole("button", { name: "取消" }).click();
    await expect(dialog).not.toBeVisible();
  });
});
