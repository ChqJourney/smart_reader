import { useTranslation } from "react-i18next";
import { useModal } from "../hooks/useModal";
import Icon from "./Icon";
import "./ShortcutsModal.css";

interface ShortcutsModalProps {
  onClose: () => void;
}

/** 一组按键组合；一个组合内多个 token 以「+」连接渲染为 kbd */
type Combo = string[];

interface ShortcutRow {
  labelKey: string;
  combos: Combo[];
}

interface ShortcutGroup {
  titleKey: string;
  rows: ShortcutRow[];
}

/** 按键 token「wheel」按界面语言翻译（滚轮 / Scroll） */
const WHEEL_TOKEN = "wheel";

// 快捷键清单与 PdfViewer / RecentFilesBar / App 中的实际键位保持一致，
// 新增快捷键时需同步此处。
const GROUPS: ShortcutGroup[] = [
  {
    titleKey: "shortcuts.groups.navigation",
    rows: [
      {
        labelKey: "shortcuts.prevNextPage",
        combos: [["PageUp"], ["PageDown"]],
      },
      {
        labelKey: "shortcuts.prevNextPageArrows",
        combos: [["←"], ["→"]],
      },
      { labelKey: "shortcuts.scrollPage", combos: [["↑"], ["↓"]] },
      { labelKey: "shortcuts.firstLast", combos: [["Home"], ["End"]] },
      { labelKey: "shortcuts.gotoPage", combos: [["Ctrl/Cmd", "G"]] },
    ],
  },
  {
    titleKey: "shortcuts.groups.search",
    rows: [
      { labelKey: "shortcuts.openSearch", combos: [["Ctrl/Cmd", "F"]] },
      {
        labelKey: "shortcuts.nextPrevMatch",
        combos: [["Enter"], ["Shift", "Enter"]],
      },
      { labelKey: "shortcuts.closePanels", combos: [["Esc"]] },
    ],
  },
  {
    titleKey: "shortcuts.groups.view",
    rows: [{ labelKey: "shortcuts.zoom", combos: [["Ctrl", WHEEL_TOKEN]] }],
  },
  {
    titleKey: "shortcuts.groups.panels",
    rows: [
      { labelKey: "shortcuts.openPdf", combos: [["Ctrl/Cmd", "O"]] },
      {
        labelKey: "shortcuts.recentFiles",
        combos: [["Ctrl/Cmd", "Shift", "O"]],
      },
      { labelKey: "shortcuts.openInSplit", combos: [["Alt", "Enter"]] },
      { labelKey: "shortcuts.showShortcuts", combos: [["Ctrl/Cmd", "/"]] },
    ],
  },
];

export default function ShortcutsModal({ onClose }: ShortcutsModalProps) {
  const { t } = useTranslation();
  const { contentRef } = useModal({ open: true, onClose });

  const renderToken = (token: string, index: number) => (
    <kbd key={index} className="shortcuts-kbd">
      {token === WHEEL_TOKEN ? t("shortcuts.scrollWheel") : token}
    </kbd>
  );

  const renderCombo = (combo: Combo, index: number) => (
    <span key={index} className="shortcuts-combo">
      {combo.map((token, i) => (
        <span key={i}>
          {i > 0 && <span className="shortcuts-plus">+</span>}
          {renderToken(token, i)}
        </span>
      ))}
    </span>
  );

  return (
    <div className="shortcuts-modal-overlay">
      <div
        ref={contentRef}
        className="shortcuts-modal"
        role="dialog"
        aria-label={t("shortcuts.title")}
      >
        <div className="shortcuts-modal-header">
          <h3>{t("shortcuts.title")}</h3>
          <button
            className="shortcuts-modal-close"
            onClick={onClose}
            aria-label={t("common.close")}
            title={t("common.close")}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="shortcuts-modal-body">
          {GROUPS.map((group) => (
            <section key={group.titleKey} className="shortcuts-group">
              <h4 className="shortcuts-group-title">{t(group.titleKey)}</h4>
              <ul className="shortcuts-group-rows">
                {group.rows.map((row) => (
                  <li key={row.labelKey} className="shortcuts-row">
                    <span className="shortcuts-row-label">
                      {t(row.labelKey)}
                    </span>
                    <span className="shortcuts-row-keys">
                      {row.combos.map((combo, i) => (
                        <span key={i}>
                          {i > 0 && <span className="shortcuts-sep">/</span>}
                          {renderCombo(combo, i)}
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
