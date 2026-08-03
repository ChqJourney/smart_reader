import { useTranslation } from "react-i18next";
import { useState } from "react";
import { useModal } from "../hooks/useModal";
import { parsePageRange, PrintOptions } from "../services/printPdf";
import { error as logError } from "../services/logs";
import Icon from "./Icon";
import "./PrintModal.css";

type RangeMode = "all" | "current" | "custom";

interface PrintModalProps {
  numPages: number;
  currentPage: number;
  /** 生成打印 PDF 并用系统阅读器打开；抛错时由弹窗展示友好文案 */
  onPrint: (options: PrintOptions) => Promise<void>;
  /** 生成打印 PDF 并弹系统保存对话框导出 */
  onExport: (options: PrintOptions) => Promise<void>;
  onClose: () => void;
}

export default function PrintModal({
  numPages,
  currentPage,
  onPrint,
  onExport,
  onClose,
}: PrintModalProps) {
  const { t } = useTranslation();
  const [rangeMode, setRangeMode] = useState<RangeMode>("all");
  const [customRange, setCustomRange] = useState("");
  const [includeTranslations, setIncludeTranslations] = useState(true);
  const [includeComments, setIncludeComments] = useState(true);
  const [busy, setBusy] = useState<"print" | "export" | null>(null);
  const [failed, setFailed] = useState(false);

  const { contentRef } = useModal({
    open: true,
    onClose,
    closeOnEscape: busy === null,
  });

  // 自定义范围非法时不阻断输入，仅禁用动作按钮
  const customPages =
    rangeMode === "custom" ? parsePageRange(customRange, numPages) : null;
  const rangeValid = rangeMode !== "custom" || customPages !== null;

  const resolveOptions = (): PrintOptions => ({
    includeTranslations,
    includeComments,
    pages:
      rangeMode === "all"
        ? undefined
        : rangeMode === "current"
          ? [currentPage]
          : (customPages ?? undefined),
  });

  const run = async (kind: "print" | "export") => {
    if (busy || !rangeValid) return;
    setBusy(kind);
    setFailed(false);
    try {
      const options = resolveOptions();
      if (kind === "print") {
        await onPrint(options);
      } else {
        await onExport(options);
      }
      onClose();
    } catch (err) {
      // 原始报错只进日志，UI 展示统一友好文案
      logError(`Print ${kind} failed: ${err}`);
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-overlay">
      <div
        ref={contentRef}
        className="modal-content print-modal"
        role="dialog"
        aria-label={t("print.title")}
      >
        <h3>{t("print.title")}</h3>

        <div className="print-modal-section">
          <span className="print-modal-label">{t("print.rangeLabel")}</span>
          <label className="print-modal-option">
            <input
              type="radio"
              name="print-range"
              checked={rangeMode === "all"}
              onChange={() => setRangeMode("all")}
            />
            {t("print.rangeAll", { numPages })}
          </label>
          <label className="print-modal-option">
            <input
              type="radio"
              name="print-range"
              checked={rangeMode === "current"}
              onChange={() => setRangeMode("current")}
            />
            {t("print.rangeCurrent", { page: currentPage })}
          </label>
          <label className="print-modal-option">
            <input
              type="radio"
              name="print-range"
              checked={rangeMode === "custom"}
              onChange={() => setRangeMode("custom")}
            />
            {t("print.rangeCustom")}
          </label>
          {rangeMode === "custom" && (
            <input
              type="text"
              className={`print-modal-range-input${rangeValid ? "" : " invalid"}`}
              value={customRange}
              onChange={(e) => setCustomRange(e.target.value)}
              placeholder={t("print.rangePlaceholder")}
              aria-label={t("print.rangeCustom")}
              autoFocus
            />
          )}
          {rangeMode === "custom" && !rangeValid && (
            <span className="print-modal-range-error">
              {t("print.rangeInvalid")}
            </span>
          )}
        </div>

        <div className="print-modal-section">
          <span className="print-modal-label">{t("print.includeLabel")}</span>
          <label className="print-modal-option">
            <input
              type="checkbox"
              checked={includeTranslations}
              onChange={(e) => setIncludeTranslations(e.target.checked)}
            />
            {t("print.includeTranslations")}
          </label>
          <label className="print-modal-option">
            <input
              type="checkbox"
              checked={includeComments}
              onChange={(e) => setIncludeComments(e.target.checked)}
            />
            {t("print.includeComments")}
          </label>
        </div>

        {failed && <p className="print-modal-error">{t("print.failed")}</p>}

        <div className="modal-actions">
          <button onClick={onClose} disabled={busy !== null}>
            {t("common.cancel")}
          </button>
          <button
            onClick={() => run("export")}
            disabled={busy !== null || !rangeValid}
          >
            {busy === "export" ? t("print.generating") : t("print.export")}
          </button>
          <button
            className="print-modal-primary"
            onClick={() => run("print")}
            disabled={busy !== null || !rangeValid}
          >
            <Icon name="print" size={14} />
            {busy === "print" ? t("print.generating") : t("print.print")}
          </button>
        </div>
      </div>
    </div>
  );
}
