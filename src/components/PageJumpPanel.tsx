import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./PageJumpPanel.css";

interface PageJumpPanelProps {
  pageNum: number;
  numPages: number;
  /** 提交目标页码（调用方负责 clamp 与关闭面板）。 */
  onSubmit: (page: number) => void;
  onClose: () => void;
}

/**
 * Cmd/Ctrl+G 跳页面板：手动输入页码，回车跳转。
 * 打开时自动聚焦并选中当前页码；Enter 提交，Escape / 点击外部关闭。
 */
export default function PageJumpPanel({
  pageNum,
  numPages,
  onSubmit,
  onClose,
}: PageJumpPanelProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(String(pageNum));
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开即聚焦并全选，方便直接敲数字覆盖。
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // 点击面板外部关闭。
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [onClose]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const page = parseInt(value, 10);
      if (!Number.isNaN(page)) {
        onSubmit(page);
      } else {
        onClose();
      }
    } else if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div ref={panelRef} className="page-jump-panel">
      <span className="page-jump-label">{t("pdf.jumpToPage")}</span>
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        className="page-jump-input"
        value={value}
        onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))}
        onKeyDown={handleKeyDown}
        aria-label={t("pdf.jumpToPage")}
        title={t("pdf.jumpToPageHint")}
      />
      <span className="page-jump-total">/ {numPages}</span>
    </div>
  );
}
