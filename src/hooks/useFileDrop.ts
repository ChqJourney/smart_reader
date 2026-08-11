import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import type { Event } from "@tauri-apps/api/event";
import { getBasename } from "../utils/path";
import { info } from "../services/logs";

/**
 * 系统级文件拖放（tauri.conf.json 的 dragDropEnabled 默认开启）：
 * 把 PDF 文件从文件管理器拖进窗口即打开。
 *
 * 为什么不用 HTML5 DnD：开启系统拖放后 WebView2 / WKWebView 会接管页面内
 * 所有 HTML5 拖放事件，文件拖放只能走后端转发的 onDragDropEvent；
 * 副作用是页面内原有的 HTML5 tab 拖拽失效（已改为鼠标拖拽实现，见 App.tsx）。
 *
 * 打开链路复用 useTabs.openPdfByPath（内部已含路径授权、hash、去重与休眠
 * 调度），成功后补写最近文件列表。非 PDF 文件静默忽略并记日志。
 *
 * listener 只注册一次：openPdfByPath / addRecentFile 随 App 渲染变化，
 * 用 ref 持有最新引用，避免重复注册产生重复 tab（与 App.tsx 的 open-pdf
 * listener 同一模式）。非 Tauri 环境（浏览器 dev / 测试）静默跳过。
 */
export interface UseFileDropOptions {
  openPdfByPath: (path: string) => Promise<{ filePath: string } | null>;
  addRecentFile: (filePath: string, fileName: string) => void;
}

export interface UseFileDropResult {
  /** 文件正悬停在窗口上（用于显示拖放遮罩）。 */
  isFileDragOver: boolean;
}

const PDF_EXT = /\.pdf$/i;

/**
 * 遮罩看门狗：慢网盘等场景下原生 leave/drop 事件可能延迟甚至丢失，
 * 导致「松开以打开 PDF」遮罩常驻。拖拽悬停期间 over 事件会持续到达，
 * 事件流停顿超过该阈值即认为拖拽已结束，强制隐藏遮罩。
 */
const OVERLAY_WATCHDOG_MS = 1500;

export function useFileDrop({
  openPdfByPath,
  addRecentFile,
}: UseFileDropOptions): UseFileDropResult {
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openPdfByPathRef = useRef(openPdfByPath);
  const addRecentFileRef = useRef(addRecentFile);
  useEffect(() => {
    openPdfByPathRef.current = openPdfByPath;
    addRecentFileRef.current = addRecentFile;
  }, [openPdfByPath, addRecentFile]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const clearWatchdog = () => {
      if (watchdogRef.current !== null) {
        clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
    };
    const armWatchdog = () => {
      clearWatchdog();
      watchdogRef.current = setTimeout(() => {
        setIsFileDragOver(false);
      }, OVERLAY_WATCHDOG_MS);
    };
    const hideOverlay = () => {
      clearWatchdog();
      setIsFileDragOver(false);
    };

    const handleDragDropEvent = (event: Event<DragDropEvent>) => {
      const payload = event.payload;
      if (payload.type === "enter") {
        setIsFileDragOver(true);
        armWatchdog();
      } else if (payload.type === "leave") {
        hideOverlay();
      } else if (payload.type === "drop") {
        hideOverlay();
        const pdfPaths = payload.paths.filter((p) => PDF_EXT.test(p));
        const ignored = payload.paths.length - pdfPaths.length;
        if (ignored > 0) {
          info(`[useFileDrop] 忽略 ${ignored} 个非 PDF 拖放文件`);
        }
        for (const path of pdfPaths) {
          void openPdfByPathRef.current(path).then((tab) => {
            if (tab) {
              addRecentFileRef.current(path, getBasename(path));
            }
          });
        }
      } else if (payload.type === "over") {
        // over 事件不做按位置分屏，只用于喂看门狗；同值 setState 不触发
        // 重渲染，悬停中保持遮罩可见、事件流停顿后由看门狗兜底隐藏。
        setIsFileDragOver(true);
        armWatchdog();
      }
    };

    // 窗口失焦（如拖拽中 Alt-Tab 切走）同样可能丢 leave 事件，兜底隐藏。
    window.addEventListener("blur", hideOverlay);

    try {
      getCurrentWebview()
        .onDragDropEvent(handleDragDropEvent)
        .then((unsub) => {
          if (cancelled) {
            unsub();
            return;
          }
          unlisten = unsub;
        })
        .catch(() => {
          // ignore: 非 Tauri 环境下事件桥不可用
        });
    } catch {
      // ignore: 非 Tauri 环境下 getCurrentWebview 直接抛错
    }

    return () => {
      cancelled = true;
      clearWatchdog();
      window.removeEventListener("blur", hideOverlay);
      unlisten?.();
    };
  }, []);

  return { isFileDragOver };
}
