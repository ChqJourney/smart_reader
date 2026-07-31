import { useTranslation } from "react-i18next";
import { useState } from "react";
import { useModal } from "../hooks/useModal";
import { StashItem } from "../services/stash";
import "./CustomInterpretModal.css";

interface CustomInterpretModalProps {
  /** 参与解读的候选片段（弹窗内可勾选/取消） */
  stashes: StashItem[];
  /** 预先勾选的片段 id；未提供时默认全选 */
  initialSelectedIds?: Set<string> | null;
  onSubmit: (prompt: string, selected: StashItem[]) => void;
  onClose: () => void;
}

const TEXT_TRUNCATE_LEN = 100;

export default function CustomInterpretModal({
  stashes,
  initialSelectedIds,
  onSubmit,
  onClose,
}: CustomInterpretModalProps) {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState("");
  // 进入弹窗即完成「选择模式」：默认全选（或沿用面板选择模式的勾选），
  // 用户在清单上直接调整，不必先回面板勾选。
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => initialSelectedIds ?? new Set(stashes.map((s) => s.id))
  );
  // 仅允许通过「取消」/「发送」关闭：禁用 Escape，遮罩点击不关闭。
  const { contentRef } = useModal({
    open: true,
    onClose,
    closeOnEscape: false,
  });

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSubmit = () => {
    const trimmed = prompt.trim();
    const selected = stashes.filter((s) => selectedIds.has(s.id));
    if (!trimmed || selected.length === 0) return;
    onSubmit(trimmed, selected);
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
          {t("customInterpret.hint", { count: selectedIds.size })}
        </p>
        <div className="modal-stash-list" role="group">
          {stashes.map((stash) => {
            const checked = selectedIds.has(stash.id);
            const text =
              stash.text.length > TEXT_TRUNCATE_LEN
                ? stash.text.slice(0, TEXT_TRUNCATE_LEN) + "…"
                : stash.text;
            return (
              <label
                key={stash.id}
                className={`modal-stash-item${checked ? " selected" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleSelected(stash.id)}
                  aria-label={t("stash.selectItem")}
                />
                <span className="modal-stash-body">
                  <span className="modal-stash-source">
                    {t("stash.source", {
                      fileName: stash.source.fileName,
                      page: stash.source.page,
                    })}
                  </span>
                  <span className="modal-stash-text">{text}</span>
                </span>
              </label>
            );
          })}
        </div>
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
          <button
            onClick={handleSubmit}
            disabled={!prompt.trim() || selectedIds.size === 0}
          >
            {t("common.send")}
          </button>
        </div>
      </div>
    </div>
  );
}
