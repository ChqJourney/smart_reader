import { useTranslation } from "react-i18next";
import { useModal } from "../hooks/useModal";
import type { PdfReferenceTarget } from "../services/pdfReferences";
import Icon from "./Icon";
import "./ReferenceCandidatesModal.css";

interface ReferenceCandidatesModalProps {
  candidates: PdfReferenceTarget[];
  onSelect: (target: PdfReferenceTarget) => void;
  onClose: () => void;
}

export default function ReferenceCandidatesModal({
  candidates,
  onSelect,
  onClose,
}: ReferenceCandidatesModalProps) {
  const { t } = useTranslation();
  const { contentRef } = useModal({ open: true, onClose });

  return (
    <div className="reference-candidates-overlay">
      <div
        ref={contentRef}
        className="reference-candidates-modal"
        role="dialog"
        aria-label={t("citations.chooseTarget")}
      >
        <div className="reference-candidates-header">
          <h3>{t("citations.chooseTarget")}</h3>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={t("common.close")}
            title={t("common.close")}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="reference-candidates-list">
          {candidates.map((target) => (
            <button
              key={`${target.page}:${target.pdfY}:${target.caption}`}
              className="reference-candidate"
              onClick={() => onSelect(target)}
            >
              <span className="reference-candidate-page">
                {t("citations.targetPage", { page: target.page })}
              </span>
              <span className="reference-candidate-caption">
                {target.caption}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
