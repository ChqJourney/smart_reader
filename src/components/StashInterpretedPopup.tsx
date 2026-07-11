import { useTranslation } from "react-i18next";
import { Annotation } from "../services/annotations";
import Icon from "./Icon";
import "./ExplainPopup.css";

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
  const { t } = useTranslation();
  const left = annotation.position.x * scale;
  const top = annotation.position.y * scale;

  return (
    <div
      className="explain-popup stash-interpreted-popup"
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label={t("marker.interpretedStash")}
    >
      <div className="explain-popup-header">
        <span className="explain-popup-title">
          <Icon name="explain" size={14} />
          {t("marker.interpretedStash")}
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
