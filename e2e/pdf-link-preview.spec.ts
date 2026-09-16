import { test, expect } from "@playwright/test";
import { setupTauriMock } from "./tauri-mock";

test.describe("PDF clause link hover preview", () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMock(page, {
      pdfs: [{ path: "/test/sample-links.pdf", fixture: "sample-links.pdf" }],
      // 链接悬停预览默认关闭，需在设置里开启（这里直接覆盖 load_settings）。
      settingsOverrides: { linkPreviewEnabled: true },
    });
    await page.goto("/");
  });

  test("hovering an internal link opens a preview popup with the target page rendered, moving away closes it", async ({
    page,
  }) => {
    await page.getByTestId("open-pdf-btn").click();
    await expect(page.getByLabel("页码")).toBeVisible();

    // sample-links.pdf 的引用链接在第 2-3 页，先跳到第 2 页。
    await page.getByLabel("页码").click();
    const jumpInput = page.getByLabel("跳转到页");
    await jumpInput.fill("2");
    await jumpInput.press("Enter");
    await expect(page.getByLabel("页码")).toHaveText("2");

    // 链接命中区域渲染为 .pdf-link-indicator（pointer-events:none），实际
    // 悬停检测发生在 .pdf-selection-overlay 的 mousemove 上，因此按指示器
    // 中心坐标移动鼠标即可。
    const indicator = page
      .locator('.pdf-page-wrapper[data-page="2"] .pdf-link-indicator')
      .first();
    await indicator.scrollIntoViewIfNeeded();
    await expect(indicator).toBeVisible();
    const box = (await indicator.boundingBox())!;

    // 悬停 2 秒（LINK_PREVIEW_HOVER_DELAY_MS）后弹出预览；用 web-first
    // 断言的轮询覆盖这段真实等待，不裸 sleep。
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const popup = page.locator(".link-preview-popup");
    await expect(popup).toBeVisible({ timeout: 6000 });
    await expect(popup.locator(".link-preview-title")).toHaveText(/第 \d+ 页/);

    // 预览内部渲染了目标页 canvas：loading 提示消失即渲染完成。
    await expect(popup.locator(".link-preview-status")).toBeHidden({
      timeout: 6000,
    });
    const canvasPixels = await popup
      .locator(".link-preview-body canvas")
      .evaluate((el) => (el as HTMLCanvasElement).width);
    expect(canvasPixels).toBeGreaterThan(0);

    // 鼠标移开链接（向左移到同页非链接区域）：400ms 宽限期后弹窗自动关闭。
    // 向左移不会穿过弹窗（弹窗锚点在链接右下方）。
    await page.mouse.move(box.x - 150, box.y + box.height / 2, { steps: 3 });
    await expect(popup).toBeHidden({ timeout: 3000 });
  });
});
