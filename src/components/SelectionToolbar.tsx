import { useEffect, useRef } from "react";
import { SelectionAction, ACTION_LABELS } from "../services/llm";
import Icon from "./Icon";

interface SelectionToolbarProps {
  selection: { text: string; x: number; y: number } | null;
  onAction: (action: SelectionAction, text: string) => void;
  onAddToStash?: (text: string) => void;
  onDismiss: () => void;
}

export default function SelectionToolbar({ selection, onAction, onAddToStash, onDismiss }: SelectionToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selection) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
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
        aria-label="加入暂存"
        title="加入暂存"
      >
        <Icon name="stash" size={16} />
        <span>加入暂存</span>
      </button>
      <button
        className="icon-btn"
        onClick={() => handleClick("explain")}
        aria-label={ACTION_LABELS.explain}
        title={ACTION_LABELS.explain}
      >
        <Icon name="explain" size={16} />
        <span>{ACTION_LABELS.explain}</span>
      </button>
      <button
        className="icon-btn"
        onClick={() => handleClick("translate")}
        aria-label={ACTION_LABELS.translate}
        title={ACTION_LABELS.translate}
      >
        <Icon name="translate" size={16} />
        <span>{ACTION_LABELS.translate}</span>
      </button>
    </div>
  );
}
