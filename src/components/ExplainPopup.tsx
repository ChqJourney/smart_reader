import { useTranslation } from "react-i18next";
import { useRef } from "react";
import { Annotation } from "../services/annotations";
import Icon from "./Icon";
import { useClampedPopupPosition } from "../hooks/useClampedPopupPosition";
import "./ExplainPopup.css";

interface ExplainPopupProps {
  annotation: Annotation;
  scale: number;
  onGotoSession: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export default function ExplainPopup({
  annotation,
  scale,
  onGotoSession,
  onDelete,
  onClose,
}: ExplainPopupProps) {
  const { t } = useTranslation();
  const popupRef = useRef<HTMLDivElement>(null);
  const left = annotation.position.x * scale;
  const top = annotation.position.y * scale;
  // Clamp inside the page wrapper; re-clamp on wrapper resize (tab activation
  // / async viewport load / zoom). translate(-50%, 12px).
  const pos = useClampedPopupPosition(popupRef, left, top);

  return (
    <div
      ref={popupRef}
      className="explain-popup"
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label={t("explain.popupLabel")}
    >
      <div className="explain-popup-header">
        <span className="explain-popup-title">
          <Icon name="explain" size={14} />
          {t("explain.title")}
        </span>
        <div className="explain-popup-actions">
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={t("common.close")}
            title={t("common.close")}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>
      <div className="explain-popup-body">
        <div className="explain-popup-label">{t("common.sourceText")}</div>
        <div className="explain-popup-source">{annotation.text}</div>
      </div>
      <div className="explain-popup-footer">
        <button onClick={onGotoSession}>{t("session.viewSession")}</button>
        <button className="danger" onClick={onDelete}>
          {t("common.delete")}
        </button>
      </div>
    </div>
  );
}
