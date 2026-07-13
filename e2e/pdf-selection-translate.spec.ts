import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";

const SAMPLE_PDF_PATH = path.join(
  import.meta.dirname,
  "fixtures",
  "sample.pdf"
);

const MOCK_LLM_BASE_URL = "http://localhost:9876/v1";

async function setupTauriMock(
  page: import("@playwright/test").Page,
  pdfPath: string = SAMPLE_PDF_PATH
) {
  const pdfBytes = Array.from(fs.readFileSync(pdfPath));

  await page.addInitScript(
    ({ bytes, baseUrl }) => {
      const arrayBuffer = new Uint8Array(bytes).buffer;
      (window as any).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args?: Record<string, unknown>) => {
          if (cmd === "plugin:dialog|open") {
            return "/test/sample.pdf";
          }
          if (cmd === "read_pdf_bytes") {
            return arrayBuffer;
          }
          if (cmd === "load_pdf_data") {
            return { annotations: [], sessionIds: [] };
          }
          if (cmd === "save_pdf_data") {
            return undefined;
          }
          if (cmd === "load_settings") {
            return {
              llm: {
                baseUrl: baseUrl,
                apiKey: "test-api-key",
                model: "gpt-4o-mini",
              },
              targetLanguage: "中文",
            };
          }
          if (cmd === "load_recent_files") {
            return [];
          }
          if (cmd === "get_pdf_hash") {
            return "test-hash";
          }
          if (cmd === "check_dictionary") {
            return { exists: false, path: "", size: null };
          }
          console.warn("Unhandled Tauri invoke command:", cmd, args);
          return undefined;
        },
      };
    },
    { bytes: pdfBytes, baseUrl: MOCK_LLM_BASE_URL }
  );
}

function buildSseResponse(chunks: string[]) {
  return chunks.join("");
}

test.describe("PDF text selection → translate", () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMock(page);
    await page.goto("/");
  });

  test("selects text and creates a translation popup", async ({ page }) => {
    await page.route(`${MOCK_LLM_BASE_URL}/chat/completions`, async (route) => {
      const chunks = [
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "翻译结果：" } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "第1页" } }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ];
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: buildSseResponse(chunks),
      });
    });

    await page.getByTestId("open-pdf-btn").click();

    // Wait for the PDF page to render and its text layer to be ready.
    const overlay = page.locator(".pdf-selection-overlay").first();
    await expect(overlay).toBeVisible();
    await page.waitForTimeout(2000);

    // Click on the rendered "PAGE 1" text (deterministic position for the
    // sample.pdf fixture at the default 150% scale).
    await overlay.click({ position: { x: 467, y: 540 } });

    const toolbar = page.locator(".selection-toolbar");
    await expect(toolbar).toBeVisible();

    await toolbar.getByRole("button", { name: "翻译" }).click();

    await expect(page.locator(".annotation-marker.translate")).toBeVisible();
    const popup = page.locator(".translate-popup");
    await expect(popup).toBeVisible();
    await expect(page.locator(".translate-popup-body")).toContainText(
      "翻译结果：第1页"
    );
  });
});
