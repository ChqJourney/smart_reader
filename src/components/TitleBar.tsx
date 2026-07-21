import { useTranslation } from "react-i18next";
import { useCallback, useState, useRef, useEffect } from "react";
import Icon from "./Icon";
import RecentFilesBar, { type RecentFilesBarProps } from "./RecentFilesBar";
import "./TitleBar.css";

interface TitleBarProps {
  /** Props forwarded to the recent-files dropdown. */
  recentFiles: RecentFilesBarProps;
  onOpenPdf: () => void;
  onOpenSettings: () => void;
}

// Window controls (min / max / close) are only meaningful inside the Tauri
// runtime. In a standalone dev server or unit tests the window API is
// unavailable, so we load it lazily and silently swallow failures.
const withWindow = (
  action: (win: import("@tauri-apps/api/window").Window) => Promise<unknown>
) => {
  import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => {
      void action(getCurrentWindow()).catch(() => {});
    })
    .catch(() => {});
};

export default function TitleBar({
  recentFiles,
  onOpenPdf,
  onOpenSettings,
}: TitleBarProps) {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);
  const mountedRef = useRef(false);

  // Sync maximized state so the icon can toggle between maximize/restore.
  useEffect(() => {
    mountedRef.current = true;
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        const win = getCurrentWindow();
        win.isMaximized().then((v) => {
          if (mountedRef.current) setMaximized(v);
        });
        // Listen for native resize events (dragging to screen edge etc.)
        const unlisten = win.onResized(async () => {
          if (mountedRef.current) setMaximized(await win.isMaximized());
        });
        return () => { mountedRef.current = false; void unlisten.then((fn) => fn?.()); };
      })
      .catch(() => {});
    return () => { mountedRef.current = false; };
  }, []);

  const handleMinimize = useCallback(
    () => withWindow((win) => win.minimize()),
    []
  );
  const handleToggleMaximize = useCallback(
    () => withWindow((win) =>
      maximized ? win.unmaximize() : win.toggleMaximize()
    ),
    [maximized]
  );
  const handleClose = useCallback(
    () => withWindow((win) => win.close()),
    []
  );

  return (
    <div className="titlebar">
      {/* ── Brand (draggable) ─────────────────────────── */}
      <div className="titlebar-brand" data-tauri-drag-region>
        <img src="/logo.svg" alt="" className="titlebar-logo-img" draggable={false} />
        <span className="titlebar-brand-name">SpecReader AI</span>
      </div>

      {/* ── Divider ───────────────────────────────────── */}
      <div className="titlebar-divider" />

      {/* ── Recent Files ─────────────────────────────── */}
      <div className="titlebar-center">
        <RecentFilesBar {...recentFiles} />
      </div>

      {/* ── Spacer (drag region) ─────────────────────── */}
      <div className="titlebar-spacer" data-tauri-drag-region />

      {/* ── Right Actions ────────────────────────────── */}
      <div className="titlebar-actions">
        <button
          data-testid="open-pdf-btn"
          className="titlebar-open-btn"
          onClick={onOpenPdf}
          aria-label={t("app.openPdf")}
          title={t("app.openPdf")}
        >
          <Icon name="open" size={14} />
          <span>{t("app.openPdf")}</span>
        </button>
        <button
          className="titlebar-settings-btn"
          onClick={onOpenSettings}
          aria-label={t("app.openSettings")}
          title={t("app.openSettings")}
        >
          <Icon name="settings" size={16} />
        </button>
      </div>

      {/* ── Window Controls (platform order) ─────────── */}
      <div className="titlebar-wc">
        <button
          className="wc-btn"
          onClick={handleMinimize}
          aria-label={t("app.minimize")}
          title={t("app.minimize")}
        >
          <Icon name="minimize" size={11} />
        </button>
        <button
          className="wc-btn"
          onClick={handleToggleMaximize}
          aria-label={t("app.toggleMaximize")}
          title={t("app.toggleMaximize")}
        >
          <Icon name={maximized ? "restore" : "maximize"} size={11} />
        </button>
        <button
          className="wc-btn wc-close"
          onClick={handleClose}
          aria-label={t("app.close")}
          title={t("app.close")}
        >
          <Icon name="close" size={11} />
        </button>
      </div>
    </div>
  );
}
