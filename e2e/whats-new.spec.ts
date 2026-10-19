import { test, expect } from "@playwright/test";

// 「本次更新内容」弹窗：settings.lastSeenVersion 落后于当前版本时弹出，
// 内容取自打包的 CHANGELOG.md 对应版本段落；关闭后把当前版本写回 settings。
test.describe("What's New modal", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const savedSettings: unknown[] = [];
      (window as any).__savedSettings = savedSettings;
      (window as any).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args?: any) => {
          if (cmd === "check_api_key") return true;
          // 当前版本 1.3.0（CHANGELOG 中存在的版本），上次已读 0.0.1
          if (cmd === "plugin:app|version") return "1.3.0";
          if (cmd === "load_settings") {
            return {
              llm: {
                baseUrl: "https://api.deepseek.com/v1",
                apiKey: "",
                model: "deepseek-flash",
              },
              targetLanguage: "中文",
              lastSeenVersion: "0.0.1",
            };
          }
          if (cmd === "save_settings") {
            savedSettings.push(args?.settings);
            return null;
          }
          throw new Error(`Unhandled Tauri invoke command: ${cmd}`);
        },
      };
    });
    await page.goto("/");
  });

  test("shows changelog for the new version and records it as seen", async ({
    page,
  }) => {
    const dialog = page.getByRole("dialog", {
      name: "本次更新内容（v1.3.0）",
    });
    await expect(dialog).toBeVisible();
    // 内容来自 CHANGELOG.md 的 1.3.0 段落
    await expect(dialog).toContainText("大纲点击");

    await dialog.getByRole("button", { name: "知道了" }).click();
    await expect(dialog).not.toBeVisible();

    // 关闭后把当前版本写入 settings，下次启动不再弹
    await expect
      .poll(async () => {
        const saved = await page.evaluate(
          () => (window as any).__savedSettings as any[]
        );
        return saved.at(-1)?.lastSeenVersion;
      })
      .toBe("1.3.0");
  });

  test("does not show the modal when version is unchanged", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as any).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string) => {
          if (cmd === "check_api_key") return true;
          if (cmd === "plugin:app|version") return "1.3.0";
          if (cmd === "load_settings") {
            return {
              llm: {
                baseUrl: "https://api.deepseek.com/v1",
                apiKey: "",
                model: "deepseek-flash",
              },
              targetLanguage: "中文",
              lastSeenVersion: "1.3.0",
            };
          }
          throw new Error(`Unhandled Tauri invoke command: ${cmd}`);
        },
      };
    });
    await page.reload();
    // 给弹窗逻辑留出一拍，确认不出现
    await page.waitForTimeout(500);
    await expect(
      page.getByRole("dialog", { name: /本次更新内容/ })
    ).not.toBeVisible();
  });
});
