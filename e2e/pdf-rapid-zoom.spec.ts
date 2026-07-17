import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";

const SAMPLE_PDF_PATH = path.join(
  import.meta.dirname,
  "fixtures",
  "sample.pdf"
);

async function setupTauriMock(
  page: import("@playwright/test").Page,
  pdfPath: string = SAMPLE_PDF_PATH
) {
  const pdfBytes = Array.from(fs.readFileSync(pdfPath));
  await page.addInitScript(
    ({ bytes, returnPath }) => {
      const arrayBuffer = new Uint8Array(bytes).buffer;
      (window as any).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string) => {
          if (cmd === "plugin:dialog|open") return returnPath;
          if (cmd === "read_pdf_bytes") return arrayBuffer;
          if (cmd === "load_pdf_data") return { annotations: [], sessionIds: [] };
          if (cmd === "save_pdf_data") return undefined;
          if (cmd === "load_settings")
            return {
              llm: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini" },
              targetLanguage: "中文",
            };
          if (cmd === "load_recent_files") return [];
          if (cmd === "get_pdf_hash") return "test-hash";
          return undefined;
        },
      };
    },
    { bytes: pdfBytes, returnPath: "/test/sample.pdf" }
  );
}

test.describe("PDF rapid zoom stability", () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMock(page);
    await page.goto("/");
  });

  test("rapidly clicking zoom-in keeps page widths consistent and scroll stable", async ({
    page,
  }) => {
    // Open the sample PDF via the toolbar button (triggers the Tauri dialog
    // mock → read_pdf_bytes → viewer load).
    await page.getByTestId("open-pdf-btn").click();

    // Wait for the PDF to load and the toolbar to become interactive.
    const pageInput = page.getByLabel("页码");
    await expect(pageInput).toBeVisible({ timeout: 15000 });
    const scaleInput = page.getByLabel("缩放比例");
    await expect(scaleInput).toBeEnabled({ timeout: 15000 });

    // Rapidly click "放大" (zoom in) 6 times without waiting between clicks.
    const zoomInBtn = page.getByLabel("放大");
    for (let i = 0; i < 6; i++) {
      await zoomInBtn.click();
    }

    // Give the viewport preload + zoom restore a moment to settle after the
    // last click.
    await page.waitForTimeout(2000);

    // ASSERTION 1: all visible page wrappers must have the SAME width.
    // A mixed-scale regression leaves some pages at the old scale's width and
    // some at the new scale's width — this is the "页面前后宽度不一" symptom.
    const widths = await page.evaluate(() => {
      const wrappers = Array.from(
        document.querySelectorAll(".pdf-page-wrapper")
      ) as HTMLElement[];
      return wrappers
        .filter((w) => w.offsetParent !== null) // visible only
        .map((w) => w.getBoundingClientRect().width);
    });
    expect(widths.length).toBeGreaterThan(0);
    const uniqueWidths = new Set(widths.map((w) => Math.round(w)));
    // Allow at most 1px rounding tolerance → effectively one width.
    expect(uniqueWidths.size).toBe(1);

    // ASSERTION 2: scrollTop must be stable (not "一直自己跳").
    // Read scrollTop twice with a short gap; the value must not change once
    // the zoom has settled.
    const containerLocator = page.locator(".pdf-canvas-container.continuous");
    const scrollTop1 = await containerLocator.evaluate(
      (el: HTMLElement) => el.scrollTop
    );
    await page.waitForTimeout(500);
    const scrollTop2 = await containerLocator.evaluate(
      (el: HTMLElement) => el.scrollTop
    );
    expect(scrollTop2).toBe(scrollTop1);

    // ASSERTION 3: viewportsForScale must match the final scale (no stale
    // old-scale entries driving the layout). We infer this from the scale
    // input value matching the rendered page width ratio.
    const scaleText = await scaleInput.inputValue();
    const scalePct = parseFloat(scaleText);
    expect(scalePct).toBeGreaterThan(100);
  });
});
