import { Annotation } from "../services/annotations";
import Icon from "./Icon";

interface StashInterpretedPopupProps {
  annotation: Annotation;
  scale: number;
  onGotoSession: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export default function StashInterpretedPopup({
  annotation,
  scale,
  onGotoSession,
  onDelete,
  onClose,
}: StashInterpretedPopupProps) {
  const left = annotation.position.x * scale;
  const top = annotation.position.y * scale;

  return (
    <div
      className="explain-popup stash-interpreted-popup"
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="已解读暂存"
    >
      <div className="explain-popup-header">
        <span className="explain-popup-title">
          <Icon name="explain" size={14} />
          已解读暂存
        </span>
        <div className="explain-popup-actions">
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>
      <div className="explain-popup-body">
        <div className="explain-popup-label">原文片段</div>
        <div className="explain-popup-source">{annotation.text}</div>
      </div>
      <div className="explain-popup-footer">
        <button onClick={onGotoSession}>查看解读</button>
        <button className="danger" onClick={onDelete}>删除</button>
      </div>
    </div>
  );
}
