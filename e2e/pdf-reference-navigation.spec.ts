import { expect, test } from "@playwright/test";
import { setupTauriMock } from "./tauri-mock";

const SCALE = 1.5;
const PAGE_TOP_STEP = 792 * SCALE + 24;

function expectedScrollTop(page: number, pdfY: number) {
  return (page - 1) * PAGE_TOP_STEP + pdfY * SCALE - 80;
}

async function getScrollTop(page: import("@playwright/test").Page) {
  return page.evaluate(
    () =>
      (
        document.querySelector(
          ".pdf-canvas-container.continuous"
        ) as HTMLElement
      ).scrollTop
  );
}

async function mockAnchoredSession(
  page: import("@playwright/test").Page,
  ownerPath: string,
  sourcePath: string,
  content: string
) {
  const sourceName = sourcePath.split("/").pop()!;
  const ownerName = ownerPath.split("/").pop()!;
  const session = {
    id: "session-cross-file",
    sources: [
      {
        id: "stash-cross-file",
        source: {
          tabId: "tab-old",
          fileName: sourceName,
          filePath: sourcePath,
          fileHash: `hash-${sourcePath}`,
          page: 3,
          pdfX: 50,
          pdfY: 60,
        },
        text: "selected text",
        createdAt: 1000,
      },
    ],
    messages: [
      { id: "msg-user", role: "user", content: "请解读", createdAt: 1000 },
      { id: "msg-ai", role: "assistant", content, createdAt: 1001 },
    ],
    isStreaming: false,
    action: "explain",
    anchorFileHash: `hash-${ownerPath}`,
    anchorFileName: ownerName,
    createdAt: 1000,
    updatedAt: 1001,
  };

  await page.addInitScript(
    ({ ownerPath, session }) => {
      const internals = (window as any).__TAURI_INTERNALS__;
      const originalInvoke = internals.invoke;
      (window as any).__dialogMessages = [];
      internals.invoke = async (
        command: string,
        args?: Record<string, unknown>
      ) => {
        if (command === "load_pdf_data" && args?.filePath === ownerPath) {
          return { annotations: [], sessionIds: [session.id] };
        }
        if (command === "load_session" && args?.sessionId === session.id) {
          return session;
        }
        if (command === "plugin:dialog|message") {
          (window as any).__dialogMessages.push(args?.message);
        }
        return originalInvoke(command, args);
      };
    },
    { ownerPath, session }
  );
}

test.describe("AI reply reference navigation", () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMock(page, {
      pdfs: [
        {
          path: "/test/sample-references.pdf",
          fixture: "sample-references.pdf",
        },
      ],
      streamChunks: [
        "见 Clause 5.2.3、Table 3、Figure 2 和 Table 4。",
        "页码见第 2 页（PDF 第 4 页）、PDF 第 3 页和印刷第 1 页。",
      ],
      streamIntervalMs: 10,
    });
    await page.goto("/");
    await page.getByTestId("open-pdf-btn").click();
    await expect(page.getByLabel("页码")).toBeVisible();
    const input = page.getByPlaceholder("就当前文档向 AI 提问…");
    await input.fill("定位引用");
    await input.press("Enter");
    await expect(
      page.locator(".ai-chat-message.assistant .ai-chat-content")
    ).toContainText("Table 4");
  });

  test("navigates a clause reference to its caption", async ({ page }) => {
    const assistant = page.locator(
      ".ai-chat-message.assistant .ai-chat-content"
    );
    await assistant.getByRole("link", { name: "Clause 5.2.3" }).click();
    await expect(page.getByLabel("页码")).toHaveText("3");
    await expect
      .poll(() => getScrollTop(page))
      .toBeCloseTo(expectedScrollTop(3, 180), -1);
  });

  test("navigates table and figure references to their captions", async ({
    page,
  }) => {
    const assistant = page.locator(
      ".ai-chat-message.assistant .ai-chat-content"
    );
    await assistant.getByRole("link", { name: "Table 3", exact: true }).click();
    await expect
      .poll(() => getScrollTop(page))
      .toBeCloseTo(expectedScrollTop(3, 280), -1);

    await assistant.getByRole("link", { name: "Figure 2" }).click();
    await expect(page.getByLabel("页码")).toHaveText("4");
    await expect
      .poll(() => getScrollTop(page))
      .toBeCloseTo(expectedScrollTop(4, 180), -1);
  });

  test("uses explicit physical pages and maps printed labels", async ({
    page,
  }) => {
    const assistant = page.locator(
      ".ai-chat-message.assistant .ai-chat-content"
    );
    await assistant
      .getByRole("link", { name: "第 2 页（PDF 第 4 页）" })
      .click();
    await expect(page.getByLabel("页码")).toHaveText("4");
    await expect
      .poll(() => getScrollTop(page))
      .toBeCloseTo(3 * PAGE_TOP_STEP, -1);

    await assistant.getByRole("link", { name: "PDF 第 3 页" }).click();
    await expect(page.getByLabel("页码")).toHaveText("3");
    await expect
      .poll(() => getScrollTop(page))
      .toBeCloseTo(2 * PAGE_TOP_STEP, -1);

    await assistant.getByRole("link", { name: "印刷第 1 页" }).click();
    await expect(page.getByLabel("页码")).toHaveText("3");
  });

  test("offers duplicate candidates and jumps to a rotated caption", async ({
    page,
  }) => {
    const assistant = page.locator(
      ".ai-chat-message.assistant .ai-chat-content"
    );
    await assistant.getByRole("link", { name: "Table 4", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "选择跳转位置" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".reference-candidate")).toHaveCount(2);
    await dialog
      .locator(".reference-candidate")
      .filter({ hasText: "Second candidate" })
      .click();

    await expect(page.getByLabel("页码")).toHaveText("5");
    // 90° 旋转页：viewport Y 来自原始 X=72，标题高度 12，pdfY=60。
    await expect
      .poll(() => getScrollTop(page))
      .toBeCloseTo(expectedScrollTop(5, 60), -1);
  });
});

test.describe("AI reply cross-file reference navigation", () => {
  test("activates another open tab and jumps to the cited page", async ({
    page,
  }) => {
    const sourcePath = "/test/sample-references.pdf";
    const ownerPath = "/test/sample.pdf";
    await setupTauriMock(page, {
      pdfs: [
        { path: sourcePath, fixture: "sample-references.pdf" },
        { path: ownerPath, fixture: "sample.pdf" },
      ],
    });
    await mockAnchoredSession(page, ownerPath, sourcePath, "见 PDF 第 4 页。");
    await page.goto("/");
    await page.getByTestId("open-pdf-btn").click();
    await page.getByTestId("open-pdf-btn").click();
    await expect(page.locator(".tab-item")).toHaveCount(2);
    await page.locator(".session-item").click();
    await expect(page.getByRole("link", { name: "PDF 第 4 页" })).toBeVisible();

    await page.locator(".tab-item").filter({ hasText: "sample.pdf" }).click();
    await page.getByRole("link", { name: "PDF 第 4 页" }).click();

    await expect(page.locator(".tab-item.active")).toContainText(
      "sample-references.pdf"
    );
    await expect(
      page.locator(".pdf-panel:not(.viewer-hidden) .page-number-btn")
    ).toHaveText("4");
  });

  test("reports the file name when the cited PDF is not open", async ({
    page,
  }) => {
    const sourcePath = "/test/sample-references.pdf";
    const ownerPath = "/test/sample.pdf";
    await setupTauriMock(page, {
      pdfs: [{ path: ownerPath, fixture: "sample.pdf" }],
    });
    await mockAnchoredSession(page, ownerPath, sourcePath, "见 Clause 5.2.3。");
    await page.goto("/");
    await page.getByTestId("open-pdf-btn").click();
    await page.locator(".session-item").click();
    await page.getByRole("link", { name: "Clause 5.2.3" }).click();

    await expect
      .poll(() => page.evaluate(() => (window as any).__dialogMessages.at(-1)))
      .toContain("sample-references.pdf");
    const message = await page.evaluate(() =>
      (window as any).__dialogMessages.at(-1)
    );
    expect(message).toContain("尚未打开");
    expect(message).not.toContain("未在当前文档中找到");
    await expect(page.locator(".tab-item.active")).toContainText("sample.pdf");
  });
});
