import { useTranslation } from "react-i18next";
import { useState } from "react";
import { useModal } from "../hooks/useModal";
import "./CustomInterpretModal.css";

interface CustomInterpretModalProps {
  stashCount: number;
  onSubmit: (prompt: string) => void;
  onClose: () => void;
}

export default function CustomInterpretModal({
  stashCount,
  onSubmit,
  onClose,
}: CustomInterpretModalProps) {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState("");
  // 仅允许通过「取消」/「发送」关闭：禁用 Escape，遮罩点击不关闭。
  const { contentRef } = useModal({
    open: true,
    onClose,
    closeOnEscape: false,
  });

  const handleSubmit = () => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setPrompt("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="modal-overlay">
      <div ref={contentRef} className="modal-content">
        <h3>{t("customInterpret.title")}</h3>
        <p className="modal-hint">
          {t("customInterpret.hint", { count: stashCount })}
        </p>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("customInterpret.placeholder")}
          rows={4}
          autoFocus
        />
        <div className="modal-actions">
          <button onClick={onClose}>{t("common.cancel")}</button>
          <button onClick={handleSubmit} disabled={!prompt.trim()}>
            {t("common.send")}
          </button>
        </div>
      </div>
    </div>
  );
}
