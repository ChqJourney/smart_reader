import { test, expect } from "@playwright/test";
import { setupTauriMock } from "./tauri-mock";

// sample-outline.pdf：5 页 612×792，每页 10 行文本（行基线 user-space y =
// 720 - row*60），大纲条目用 /XYZ dest 指向 3p line 6 / 4p line 1 / 5p line 8。
// 默认 scale=1.5、JUMP_TARGET_TOP_MARGIN=80、PAGE_SPACING=24：
//   pageTop(p) = (p-1) * (792*1.5 + 24) = (p-1) * 1212
//   pdfY = 792 - destY（scale=1 viewport 转换，含 Y 轴翻转）
//   期望 scrollTop = pageTop + pdfY*1.5 - 80
const SCALE = 1.5;
const PAGE_TOP_STEP = 792 * SCALE + 24;

function expectedScrollTop(page: number, row: number): number {
  const destY = 720 - row * 60; // 大纲 dest 指向该行基线（user space）
  const pdfY = 792 - destY;
  return (page - 1) * PAGE_TOP_STEP + pdfY * SCALE - 80;
}

async function getScrollTop(page: import("@playwright/test").Page) {
  return page.evaluate(
    () =>
      (document.querySelector(".pdf-canvas-container.continuous") as HTMLElement)
        .scrollTop
  );
}

test.describe("PDF outline jump", () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMock(page, {
      pdfs: [{ path: "/test/sample-outline.pdf", fixture: "sample-outline.pdf" }],
    });
    await page.goto("/");
    await page.getByTestId("open-pdf-btn").click();
    await expect(page.getByLabel("页码")).toBeVisible();
  });

  test("clicking an outline item scrolls precisely to the target line", async ({
    page,
  }) => {
    await page.getByLabel("目录").click();
    await page.getByText("goto p4 line 1").click();

    await expect(page.getByLabel("页码")).toHaveText("4");
    // 旧行为（只到页首）scrollTop = 3636；精确跳转应为 3754。
    expect(await getScrollTop(page)).toBeCloseTo(expectedScrollTop(4, 1), -1);
  });

  test("outline jump to a mid-page line lands on that line, not the page top", async ({
    page,
  }) => {
    await page.getByLabel("目录").click();
    await page.getByText("goto p3 line 6").click();

    await expect(page.getByLabel("页码")).toHaveText("3");
    // line 6 在页内 432pt 处：只跳页首会得到 2424，精确跳转应为 2992。
    expect(await getScrollTop(page)).toBeCloseTo(expectedScrollTop(3, 6), -1);
  });
});
