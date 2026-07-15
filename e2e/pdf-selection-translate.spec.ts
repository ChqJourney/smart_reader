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
    ({ bytes }) => {
      const arrayBuffer = new Uint8Array(bytes).buffer;

      // Tauri Channel callback registry — Channel.__construct__ calls
      // transformCallback to register its onmessage handler, and the backend
      // later invokes that callback id to deliver stream events. In tests we
      // drive the channel directly from the mocked invoke handler below.
      let nextCallbackId = 1;
      const callbacks = new Map<number, (raw: unknown) => void>();

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
                baseUrl: "http://localhost:9876/v1",
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
          if (cmd === "chat_completions_stream") {
            // LLM streaming is now proxied through the Rust backend via a
            // Tauri Channel. args.onEvent is the Channel instance; calling
            // its onmessage handler delivers stream events to the frontend.
            const channel = args?.onEvent as {
              onmessage: (msg: unknown) => void;
            };
            setTimeout(() => {
              channel.onmessage({ type: "chunk", content: "翻译结果：" });
              channel.onmessage({ type: "chunk", content: "第1页" });
              channel.onmessage({ type: "done" });
            }, 0);
            return undefined;
          }
          console.warn("Unhandled Tauri invoke command:", cmd, args);
          return undefined;
        },
        transformCallback: (callback: (raw: unknown) => void) => {
          const id = nextCallbackId++;
          callbacks.set(id, callback);
          return id;
        },
        unregisterCallback: (id: number) => {
          callbacks.delete(id);
        },
      };
    },
    { bytes: pdfBytes }
  );
}

test.describe("PDF text selection → translate", () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMock(page);
    await page.goto("/");
  });

  test("selects text and creates a translation popup", async ({ page }) => {
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
