import { test, expect } from "@playwright/test";
import { setupTauriMock } from "./tauri-mock";

// 间隔拉长到 120ms，让「流式逐段出现」的中间态断言有稳定的时间窗。
const CHUNKS = ["解读结果：", "这是第 1 页的内容。", "解释完毕。"];
const FULL_TEXT = CHUNKS.join("");

test.describe("PDF selection → interpret (streaming)", () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMock(page, {
      pdfs: [{ path: "/test/sample.pdf", fixture: "sample.pdf" }],
      streamChunks: CHUNKS,
      streamIntervalMs: 120,
    });
    await page.goto("/");
  });

  test("interpret action opens the session chatbox and streams the answer", async ({
    page,
  }) => {
    await page.getByTestId("open-pdf-btn").click();

    // 等渲染与文本层数据就绪（沿用 pdf-selection-translate.spec.ts 的做法：
    // 点击坐标依赖 sample.pdf 默认 150% 缩放下的 "PAGE 1" 文本位置）。
    const overlay = page.locator(".pdf-selection-overlay").first();
    await expect(overlay).toBeVisible();
    await page.waitForTimeout(2000);
    await overlay.click({ position: { x: 467, y: 540 } });

    const toolbar = page.locator(".selection-toolbar");
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole("button", { name: "解读", exact: true }).click();

    // 发起解读后右侧面板直接进入新会话 chatbox（返回列表按钮出现）。
    const panel = page.locator(".ai-chat-panel");
    await expect(panel.locator(".session-back-btn")).toBeVisible();

    const assistant = panel.locator(
      ".ai-chat-message.assistant .ai-chat-content"
    );
    // 流式逐段出现：先见到首段，再逐步拼成完整内容。
    await expect(assistant).toContainText(CHUNKS[0]);
    await expect(assistant).toContainText(FULL_TEXT);

    // PDF 上生成了解读标记。
    await expect(page.locator(".annotation-marker").first()).toBeVisible();
  });
});
