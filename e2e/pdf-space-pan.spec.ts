import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";

const SAMPLE_PDF_PATH = path.join(
  import.meta.dirname,
  "fixtures",
  "sample.pdf"
);

async function setupTauriMock(page: import("@playwright/test").Page) {
  const pdfBytes = Array.from(fs.readFileSync(SAMPLE_PDF_PATH));
  await page.addInitScript(
    ({ bytes, returnPath }) => {
      const arrayBuffer = new Uint8Array(bytes).buffer;
      (window as any).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string) => {
          if (cmd === "plugin:dialog|open") return returnPath;
          if (cmd === "read_pdf_bytes") return arrayBuffer;
          if (cmd === "load_pdf_data")
            return { annotations: [], sessionIds: [] };
          if (cmd === "save_pdf_data") return undefined;
          if (cmd === "load_settings")
            return {
              llm: {
                baseUrl: "https://api.openai.com/v1",
                apiKey: "",
                model: "gpt-4o-mini",
              },
              targetLanguage: "中文",
            };
          if (cmd === "load_recent_files") return [];
          if (cmd === "get_pdf_hash") return "test-hash";
          // Pretend a key exists so the first-run SetupWizard does not open
          // and overlay the UI under test.
          if (cmd === "check_api_key") return true;
          return undefined;
        },
      };
    },
    { bytes: pdfBytes, returnPath: "/test/sample.pdf" }
  );
}

async function openPdf(page: import("@playwright/test").Page) {
  await page.getByTestId("open-pdf-btn").click();
  await expect(page.getByLabel("页码")).toBeVisible({ timeout: 15000 });
  await expect(page.getByLabel("缩放比例")).toBeEnabled({ timeout: 15000 });
}

test.describe("Space pan (hand tool)", () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMock(page);
    await page.goto("/");
  });

  test("continuous mode: Space+drag pans the document", async ({ page }) => {
    await openPdf(page);
    const container = page.locator(".pdf-canvas-container.continuous");
    await expect(container).toBeVisible();
    await page.waitForTimeout(500);

    const box = (await container.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    const before = await container.evaluate((el) => el.scrollTop);

    await page.mouse.move(cx, cy);
    await page.keyboard.down("Space");
    await page.mouse.down();
    // 光标上移 → 内容跟随光标 → 视口下移（scrollTop 增大）。
    await page.mouse.move(cx, cy - 200, { steps: 10 });

    // 回归点：pan 拖动中不得画出自定义选区框。
    await expect(page.locator(".pdf-selection-rect")).toHaveCount(0);

    await page.mouse.up();
    await page.keyboard.up("Space");

    const after = await container.evaluate((el) => el.scrollTop);
    expect(after).toBeGreaterThan(before + 100);

    // 松手后也不得误报选区（浮动工具条不出现）。
    await expect(page.locator(".selection-toolbar")).toHaveCount(0);
  });

  test("single mode: pan position sticks after mouse release while Space is still held", async ({
    page,
  }) => {
    await openPdf(page);

    // 切换到单页模式并放大到 300%，确保页面溢出容器（pan 的前提）。
    await page.getByLabel("切换为单页阅读").click();
    const scaleInput = page.getByLabel("缩放比例");
    await scaleInput.fill("300");
    await scaleInput.press("Enter");
    const container = page.locator(".pdf-canvas-container");
    await expect(container).toBeVisible();
    // 等缩放重排完成：内容确实溢出才继续。
    await expect
      .poll(async () =>
        container.evaluate(
          (el) => el.scrollHeight > el.clientHeight && el.scrollWidth > 0
        )
      )
      .toBe(true);

    const box = (await container.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await page.mouse.move(cx, cy);
    await page.keyboard.down("Space");
    await page.mouse.down();
    await page.mouse.move(cx, cy - 150, { steps: 10 });
    await page.mouse.up();

    const rightAfterDrag = await container.evaluate((el) => el.scrollTop);
    expect(rightAfterDrag).toBeGreaterThan(50);

    // 回归点：Space 仍按住时，松手后滚动位置不得弹回原位。
    await page.waitForTimeout(600);
    const whileSpaceHeld = await container.evaluate((el) => el.scrollTop);
    expect(Math.abs(whileSpaceHeld - rightAfterDrag)).toBeLessThanOrEqual(2);

    await page.keyboard.up("Space");
    await page.waitForTimeout(200);
    const afterRelease = await container.evaluate((el) => el.scrollTop);
    expect(Math.abs(afterRelease - rightAfterDrag)).toBeLessThanOrEqual(2);
  });

  test("without Space, dragging still selects text (no pan)", async ({
    page,
  }) => {
    await openPdf(page);
    const container = page.locator(".pdf-canvas-container.continuous");
    await expect(container).toBeVisible();
    await page.waitForTimeout(500);

    const box = (await container.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    const before = await container.evaluate((el) => el.scrollTop);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 200, { steps: 10 });
    await page.mouse.up();

    const after = await container.evaluate((el) => el.scrollTop);
    expect(after).toBe(before);
  });
});
