import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";

/**
 * 批次 3 新增 spec 共用的 Tauri mock（addInitScript 注入
 * `window.__TAURI_INTERNALS__.invoke`）。既有 spec（pdf-page-jump /
 * pdf-selection-translate）仍各自内联 mock，本 helper 只服务新文件。
 *
 * 与既有内联版相比的差异：
 * - 支持多 PDF：`plugin:dialog|open` 按 pdfs 顺序依次返回路径；
 *   `read_pdf_bytes` / `get_pdf_file_size` 按 args.filePath 取字节；
 *   `get_pdf_hash` 按路径派生 hash，避免 useTabs 的同 hash 去重把两个
 *   不同路径的同内容文件并成一个 tab（并排对照用例需要两个真 tab）。
 * - 补了 `transformCallback` 回调注册表，`new Channel()`（llm.ts 的
 *   chat_completions_stream 桥接）在 mock 环境下可用。
 * - 可选 chat_completions_stream 流式 mock：按间隔逐段推 chunk，
 *   再推 usage 与 done 后 resolve（invoke 必须最后 settle，见
 *   pdf-selection-translate.spec.ts 的注释——提前 resolve 会让前端
 *   排空队列提前收尾）。
 */

export interface MockPdf {
  /** 打开链路使用的虚拟文件路径（dialog 返回值 / 去重与记账依据）。 */
  path: string;
  /** e2e/fixtures 下的文件名。 */
  fixture: string;
}

export interface TauriMockOptions {
  pdfs: MockPdf[];
  /** load_settings 返回值的覆盖字段（前端 normalizeSettings 会与默认值合并）。 */
  settingsOverrides?: Record<string, unknown>;
  /** 提供则启用 chat_completions_stream 流式 mock。 */
  streamChunks?: string[];
  streamIntervalMs?: number;
}

export async function setupTauriMock(page: Page, options: TauriMockOptions) {
  const fixturesDir = path.join(import.meta.dirname, "fixtures");
  const pdfs = options.pdfs.map((p) => ({
    path: p.path,
    bytes: Array.from(fs.readFileSync(path.join(fixturesDir, p.fixture))),
  }));

  await page.addInitScript(
    ({ pdfs, settingsOverrides, streamChunks, streamIntervalMs }) => {
      // 并排对照的一次性引导气泡（.split-coachmark）会在开 2 个 tab 时出现，
      // 提前标记已读，避免干扰 tab 栏交互与断言。
      try {
        localStorage.setItem("specreader-split-coachmark-seen", "1");
      } catch {
        // ignore：localStorage 不可用时气泡本身 pointer-events:none，不影响用例。
      }

      // Tauri Channel 回调注册表：Channel 构造 / onmessage setter 经
      // transformCallback 注册回调；测试里由 invoke mock 直接调用
      // Channel 实例的 onmessage 推流事件。
      let nextCallbackId = 1;
      const callbacks = new Map<number, (raw: unknown) => void>();

      const bytesByPath = new Map(pdfs.map((p) => [p.path, p.bytes]));
      const dialogQueue = pdfs.map((p) => p.path);

      const invoke = async (
        cmd: string,
        args?: Record<string, unknown>
      ): Promise<unknown> => {
        if (cmd === "plugin:dialog|open") {
          return dialogQueue.length > 0 ? dialogQueue.shift() : null;
        }
        if (cmd === "authorize_pdf_path") return undefined;
        if (cmd === "read_pdf_bytes") {
          const bytes =
            bytesByPath.get(args?.filePath as string) ?? pdfs[0].bytes;
          return new Uint8Array(bytes).buffer;
        }
        if (cmd === "get_pdf_hash") return `hash-${args?.filePath}`;
        if (cmd === "get_pdf_file_size") {
          const bytes =
            bytesByPath.get(args?.filePath as string) ?? pdfs[0].bytes;
          return bytes.length;
        }
        if (cmd === "load_pdf_data") return { annotations: [], sessionIds: [] };
        if (cmd === "save_pdf_data") return undefined;
        if (cmd === "load_session") return null;
        if (cmd === "save_session") return undefined;
        if (cmd === "delete_session") return undefined;
        if (cmd === "load_settings") {
          return {
            llm: {
              baseUrl: "http://localhost:9876/v1",
              apiKey: "",
              model: "gpt-4o-mini",
            },
            targetLanguage: "中文",
            ...(settingsOverrides ?? {}),
          };
        }
        if (cmd === "save_settings") return undefined;
        if (cmd === "load_recent_files") return [];
        if (cmd === "save_recent_files") return undefined;
        if (cmd === "check_files_exist") {
          const paths = (args?.paths as string[]) ?? [];
          return paths.map(() => true);
        }
        if (cmd === "check_dictionary") {
          return { exists: false, path: "", size: null };
        }
        // 佯装 Key 已配置，避免首次启动 SetupWizard 遮挡被测 UI。
        if (cmd === "check_api_key") return true;
        if (cmd === "delete_api_key") return undefined;
        if (cmd === "cancel_chat_completions") return undefined;
        if (cmd === "chat_completions_stream") {
          if (!streamChunks) return undefined;
          // args.onEvent 是前端 new Channel() 的实例（mock 环境不做 IPC
          // 序列化，对象原样到达），调用其 onmessage 即推流事件给前端。
          const channel = args?.onEvent as {
            onmessage: (msg: unknown) => void;
          };
          const chunks = streamChunks;
          const interval = streamIntervalMs;
          return new Promise<void>((resolve) => {
            let i = 0;
            const push = () => {
              if (i < chunks.length) {
                channel.onmessage({ type: "chunk", content: chunks[i++] });
                setTimeout(push, interval);
                return;
              }
              channel.onmessage({
                type: "usage",
                usage: {
                  promptTokens: 128,
                  completionTokens: chunks.join("").length,
                  totalTokens: 128 + chunks.join("").length,
                },
              });
              channel.onmessage({ type: "done" });
              // invoke 在全部事件送达后才 resolve：前端把 invoke settle 视为
              // “不会再有新事件”，提前 resolve 会截断流。
              resolve();
            };
            setTimeout(push, interval);
          });
        }
        console.warn("Unhandled Tauri invoke command:", cmd, args);
        return undefined;
      };

      (window as any).__TAURI_INTERNALS__ = {
        invoke,
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
    {
      pdfs,
      settingsOverrides: options.settingsOverrides ?? null,
      streamChunks: options.streamChunks ?? null,
      streamIntervalMs: options.streamIntervalMs ?? 50,
    }
  );
}

/**
 * 返回连续滚动容器内当前视觉主导页（与组件自身判定一致：可见页中顶边
 * 距容器顶最近者）。复制自 pdf-page-jump.spec.ts 的同名函数。
 */
export async function getVisiblePage(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const container = document.querySelector(
      ".pdf-canvas-container.continuous"
    ) as HTMLElement | null;
    if (!container) return null;

    const containerRect = container.getBoundingClientRect();
    const wrappers = Array.from(
      document.querySelectorAll(".pdf-page-wrapper")
    ) as HTMLElement[];

    let bestPage = 1;
    let bestDistance = Infinity;

    wrappers.forEach((wrapper, index) => {
      const rect = wrapper.getBoundingClientRect();
      if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom)
        return;

      const distance = Math.abs(rect.top - containerRect.top);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestPage = index + 1;
      }
    });

    return bestPage;
  });
}
