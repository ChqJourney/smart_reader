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

  test("preview content zooms via Ctrl+wheel and header buttons", async ({
    page,
  }) => {
    await page.getByTestId("open-pdf-btn").click();
    await expect(page.getByLabel("页码")).toBeVisible();

    await page.getByLabel("页码").click();
    const jumpInput = page.getByLabel("跳转到页");
    await jumpInput.fill("2");
    await jumpInput.press("Enter");
    await expect(page.getByLabel("页码")).toHaveText("2");

    const indicator = page
      .locator('.pdf-page-wrapper[data-page="2"] .pdf-link-indicator')
      .first();
    await indicator.scrollIntoViewIfNeeded();
    const box = (await indicator.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const popup = page.locator(".link-preview-popup");
    await expect(popup).toBeVisible({ timeout: 6000 });
    await expect(popup.locator(".link-preview-status")).toBeHidden({
      timeout: 6000,
    });

    const canvas = popup.locator(".link-preview-body canvas");
    const canvasWidth = () =>
      canvas.evaluate((el) => (el as HTMLCanvasElement).width);
    const widthBefore = await canvasWidth();
    expect(widthBefore).toBeGreaterThan(0);

    // 移入预览窗（进入窗口取消宽限关闭计时），Ctrl+滚轮放大两档（1.2²=1.44x）。
    const bodyBox = (await popup.locator(".link-preview-body").boundingBox())!;
    await page.mouse.move(
      bodyBox.x + bodyBox.width / 2,
      bodyBox.y + bodyBox.height / 2,
      { steps: 3 }
    );
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -240);
    await page.keyboard.up("Control");
    await expect.poll(canvasWidth).toBeGreaterThan(widthBefore * 1.3);

    // 放大后内容横向溢出：左键拖拽内容区平移（手型，scrollLeft 从 0 增大）。
    const body = popup.locator(".link-preview-body");
    const centerX = bodyBox.x + bodyBox.width / 2;
    const centerY = bodyBox.y + bodyBox.height / 2;
    await page.mouse.move(centerX, centerY);
    await page.mouse.down();
    await page.mouse.move(centerX - 80, centerY, { steps: 4 });
    await page.mouse.up();
    await expect
      .poll(() => body.evaluate((el) => el.scrollLeft))
      .toBeGreaterThan(0);

    // 头部「-」按钮缩回一档（1.44/1.2=1.2x），再缩一档回到 fit-to-width。
    const zoomOut = popup.getByRole("button", {
      name: "缩小（Ctrl/Cmd+滚轮）",
    });
    await zoomOut.click();
    const zoomedWidth = await canvasWidth();
    expect(zoomedWidth).toBeGreaterThan(widthBefore * 1.1);
    await zoomOut.click();
    await expect
      .poll(async () =>
        canvas.evaluate((el) => (el as HTMLCanvasElement).style.width === "")
      )
      .toBe(true);
  });
});
