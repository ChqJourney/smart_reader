import { test, expect, type Page } from "@playwright/test";
import { setupTauriMock } from "./tauri-mock";

// 两个不同路径指向不同 fixture，get_pdf_hash 按路径派生 hash，
// 因此会打开两个独立的 tab（同 hash 会被 useTabs 去重合并）。
const PDFS = [
  { path: "/test/sample-a.pdf", fixture: "sample.pdf" },
  { path: "/test/sample-b.pdf", fixture: "sample-links.pdf" },
];

async function openTwoPdfs(page: Page) {
  const openBtn = page.getByTestId("open-pdf-btn");
  await openBtn.click();
  // 等第一个 viewer 就绪再开第二个，保证两个 tab 稳定建立。
  await expect(page.getByLabel("页码")).toBeVisible();
  await openBtn.click();
  await expect(page.locator(".tab-item")).toHaveCount(2);
  // 等第二个 viewer 挂载恢复完成（含状态回写）再操作，避免 viewer 初始化
  // 期间的 tab 状态写入与后续拖拽手势交错。注意必须用 :visible ——
  // keep-alive 下非激活 tab 的 viewer 仍在 DOM 中（display:none），
  // .first() 会抓到隐藏 overlay。
  await expect(
    page.locator(".pdf-selection-overlay:visible").first()
  ).toBeVisible();
}

test.describe("PDF split view", () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMock(page, { pdfs: PDFS });
    await page.goto("/");
  });

  test("tab bar button enters split view with both viewers rendered, exit restores single view", async ({
    page,
  }) => {
    await openTwoPdfs(page);

    await page.locator(".split-view-enter").click();

    // 两个 viewer 并排并存，各自渲染出内容；右侧 AiChatPanel 合并显示（双屏共用一个面板）。
    const panels = page.locator(".pdf-panel.expanded");
    await expect(panels).toHaveCount(2);
    await expect(
      panels.nth(0).locator(".pdf-canvas-container.continuous")
    ).toBeVisible();
    await expect(
      panels.nth(1).locator(".pdf-canvas-container.continuous")
    ).toBeVisible();
    await expect(panels.nth(0).locator("canvas").first()).toBeVisible();
    await expect(panels.nth(1).locator("canvas").first()).toBeVisible();
    await expect(page.locator(".ai-chat-panel")).toHaveCount(1);
    await expect(page.locator(".ai-chat-panel")).toBeVisible();

    // 退出并排：恢复单屏，只剩激活 tab 的 viewer 可见（另一个 keep-alive 隐藏）。
    await page.locator(".split-view-exit").click();
    await expect(page.locator(".split-view-enter")).toBeVisible();
    await expect(
      page.locator(".pdf-canvas-container.continuous:visible")
    ).toHaveCount(1);
    await expect(page.locator(".pdf-panel.viewer-hidden")).toHaveCount(1);
  });

  // 拖拽用例保持「单一连续手势」：mousedown → 拖入阅读区 → 释放。
  // 不在中途反复拖进拖出——每次遮罩显隐都伴随 App 重渲染，多段手势会
  // 放大撞上 tab 状态回写（重渲染误摘拖拽监听）的窗口。
  test("dragging an inactive tab into the reading area shows the drop overlay and drop enters split view", async ({
    page,
  }) => {
    await openTwoPdfs(page);

    // 第二个 tab 为激活态，第一个是非激活的可拖拽来源。
    const inactiveTab = page.locator(".tab-item:not(.active)");
    await expect(inactiveTab).toHaveCount(1);
    const tabBox = (await inactiveTab.boundingBox())!;
    const mainBox = (await page.locator(".app-main").boundingBox())!;
    const dropPoint = {
      x: mainBox.x + mainBox.width / 3,
      y: mainBox.y + mainBox.height / 2,
    };

    const overlay = page.locator(".split-drop-overlay");
    await page.mouse.move(
      tabBox.x + tabBox.width / 2,
      tabBox.y + tabBox.height / 2
    );
    await page.mouse.down();

    // 拖入阅读区：出现 drop-zone 遮罩（移动需超过 5px 阈值才进入拖拽态）。
    await page.mouse.move(dropPoint.x, dropPoint.y, { steps: 5 });
    await expect(overlay).toBeVisible();

    // 在阅读区内释放：进入并排对照，遮罩消失。
    await page.mouse.up();
    await expect(overlay).toBeHidden();
    await expect(page.locator(".split-view-exit")).toBeVisible();
    await expect(page.locator(".pdf-panel.expanded")).toHaveCount(2);
  });

  test("releasing the dragged tab outside the reading area cancels the drag", async ({
    page,
  }) => {
    await openTwoPdfs(page);

    const inactiveTab = page.locator(".tab-item:not(.active)");
    await expect(inactiveTab).toHaveCount(1);
    const tabBox = (await inactiveTab.boundingBox())!;
    const mainBox = (await page.locator(".app-main").boundingBox())!;
    const tabC = {
      x: tabBox.x + tabBox.width / 2,
      y: tabBox.y + tabBox.height / 2,
    };

    const overlay = page.locator(".split-drop-overlay");
    await page.mouse.move(tabC.x, tabC.y);
    await page.mouse.down();

    // 拖入阅读区出现遮罩后，拖回 tab 栏（阅读区外）释放 = 取消。
    await page.mouse.move(
      mainBox.x + mainBox.width / 3,
      mainBox.y + mainBox.height / 2,
      { steps: 5 }
    );
    await expect(overlay).toBeVisible();
    await page.mouse.move(tabC.x, tabC.y, { steps: 5 });
    await page.mouse.up();

    await expect(overlay).toBeHidden();
    await expect(page.locator(".split-view-exit")).toBeHidden();
    // 取消路径不激活被拖 tab（mouseup 在阅读区外，onClick 不触发）。
    await expect(inactiveTab).toHaveCount(1);
  });
});
