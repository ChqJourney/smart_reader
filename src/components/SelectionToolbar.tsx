import { useTranslation } from "react-i18next";
import { useEffect, useRef } from "react";
import { SelectionAction } from "../services/llm";
import Icon from "./Icon";
import "./SelectionToolbar.css";

interface SelectionToolbarProps {
  selection: { text: string; x: number; y: number } | null;
  onAction: (action: SelectionAction, text: string) => void;
  onAddToStash?: (text: string) => void;
  onDismiss: () => void;
}

export default function SelectionToolbar({
  selection,
  onAction,
  onAddToStash,
  onDismiss,
}: SelectionToolbarProps) {
  const { t } = useTranslation();
  const toolbarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selection) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (
        toolbarRef.current &&
        !toolbarRef.current.contains(e.target as Node)
      ) {
        onDismiss();
      }
    };

    // Delay to avoid dismissing on the same click that created the selection
    const timeoutId = setTimeout(() => {
      window.addEventListener("mousedown", handleMouseDown);
    }, 50);

    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener("mousedown", handleMouseDown);
    };
  }, [selection, onDismiss]);

  const handleClick = (action: SelectionAction) => {
    if (selection?.text) {
      onAction(action, selection.text);
      onDismiss();
    }
  };

  const handleAddToStashClick = () => {
    if (selection?.text) {
      onAddToStash?.(selection.text);
      onDismiss();
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  if (!selection) return null;

  return (
    <div
      ref={toolbarRef}
      className="selection-toolbar"
      style={{
        left: selection.x,
        top: selection.y - 8,
        transform: "translate(-50%, -100%)",
      }}
      onMouseDown={handleMouseDown}
    >
      <button
        className="icon-btn"
        onClick={handleAddToStashClick}
        aria-label={t("stash.add")}
        title={t("stash.add")}
      >
        <Icon name="stash" size={16} />
        <span>{t("stash.add")}</span>
      </button>
      <button
        className="icon-btn"
        onClick={() => handleClick("explain")}
        aria-label={t("action.explain")}
        title={t("action.explain")}
      >
        <Icon name="explain" size={16} />
        <span>{t("action.explain")}</span>
      </button>
      <button
        className="icon-btn"
        onClick={() => handleClick("translate")}
        aria-label={t("action.translate")}
        title={t("action.translate")}
      >
        <Icon name="translate" size={16} />
        <span>{t("action.translate")}</span>
      </button>
    </div>
  );
}
