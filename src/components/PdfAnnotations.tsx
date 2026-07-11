import { useMemo, useState } from "react";
import { Annotation } from "../services/annotations";
import { AppSettings } from "../services/settings";
import AnnotationMarker from "./AnnotationMarker";
import ExplainPopup from "./ExplainPopup";
import StashInterpretedPopup from "./StashInterpretedPopup";
import TranslatePopup from "./TranslatePopup";

interface PdfAnnotationsProps {
  annotations: Annotation[];
  pageNum: number;
  scale: number;
  fileHash: string;
  highlightedId?: string | null;
  onUpdate: (id: string, patch: Partial<Omit<Annotation, "id">>) => void;
  onDelete: (id: string) => void;
  onExplainClick: (id: string) => void;
  settings: AppSettings;
}

export default function PdfAnnotations({
  annotations,
  pageNum,
  scale,
  fileHash,
  highlightedId,
  onUpdate,
  onDelete,
  onExplainClick,
  settings,
}: PdfAnnotationsProps) {
  const [openPopupId, setOpenPopupId] = useState<string | null>(null);

  const pageAnnotations = useMemo(
    () =>
      annotations.filter(
        (a) =>
          a.position.page === pageNum &&
          (a.fileHash === fileHash || (!a.fileHash && fileHash === ""))
      ),
    [annotations, pageNum, fileHash]
  );

  return (
    <>
      {pageAnnotations.map((annotation) => {
        const isInterpretedStash =
          annotation.type === "stash" &&
          typeof annotation.interpretedGroupSize === "number" &&
          typeof annotation.interpretedIndex === "number";

        return (
          <div key={annotation.id}>
            <AnnotationMarker
              annotation={annotation}
              scale={scale}
              highlighted={highlightedId === annotation.id}
              onClick={() => {
                if (annotation.type === "translate") {
                  onUpdate(annotation.id, { hidden: !annotation.hidden });
                } else if (
                  annotation.type === "explain" ||
                  isInterpretedStash
                ) {
                  setOpenPopupId((current) =>
                    current === annotation.id ? null : annotation.id
                  );
                }
              }}
              onMove={(dx, dy) =>
                onUpdate(annotation.id, {
                  position: {
                    ...annotation.position,
                    x: annotation.position.x + dx / scale,
                    y: annotation.position.y + dy / scale,
                  },
                })
              }
            />
            {annotation.type === "translate" && !annotation.hidden && (
              <TranslatePopup
                annotation={annotation}
                scale={scale}
                settings={settings}
                onUpdate={(patch) => onUpdate(annotation.id, patch)}
                onHide={() => onUpdate(annotation.id, { hidden: true })}
                onClose={() => onDelete(annotation.id)}
              />
            )}
            {annotation.type === "explain" && openPopupId === annotation.id && (
              <ExplainPopup
                annotation={annotation}
                scale={scale}
                onGotoSession={() => {
                  setOpenPopupId(null);
                  onExplainClick(annotation.id);
                }}
                onDelete={() => {
                  setOpenPopupId(null);
                  onDelete(annotation.id);
                }}
                onClose={() => setOpenPopupId(null)}
              />
            )}
            {isInterpretedStash && openPopupId === annotation.id && (
              <StashInterpretedPopup
                annotation={annotation}
                scale={scale}
                onGotoSession={() => {
                  setOpenPopupId(null);
                  onExplainClick(annotation.id);
                }}
                onDelete={() => {
                  setOpenPopupId(null);
                  onDelete(annotation.id);
                }}
                onClose={() => setOpenPopupId(null)}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
