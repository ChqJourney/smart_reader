import { useMemo } from "react";
import { Annotation } from "../services/annotations";
import AnnotationMarker from "./AnnotationMarker";
import TranslatePopup from "./TranslatePopup";

interface PdfAnnotationsProps {
  annotations: Annotation[];
  pageNum: number;
  scale: number;
  highlightedId?: string | null;
  onUpdate: (id: string, patch: Partial<Omit<Annotation, "id">>) => void;
  onDelete: (id: string) => void;
  onExplainClick: (id: string) => void;
}

export default function PdfAnnotations({
  annotations,
  pageNum,
  scale,
  highlightedId,
  onUpdate,
  onDelete,
  onExplainClick,
}: PdfAnnotationsProps) {
  const pageAnnotations = useMemo(
    () => annotations.filter((a) => a.position.page === pageNum),
    [annotations, pageNum]
  );

  return (
    <>
      {pageAnnotations.map((annotation) => (
        <div key={annotation.id}>
          <AnnotationMarker
            annotation={annotation}
            scale={scale}
            highlighted={highlightedId === annotation.id}
            onClick={() =>
              annotation.type === "translate"
                ? onUpdate(annotation.id, { hidden: !annotation.hidden })
                : onExplainClick(annotation.id)
            }
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
              onUpdate={(patch) => onUpdate(annotation.id, patch)}
              onHide={() => onUpdate(annotation.id, { hidden: true })}
              onClose={() => onDelete(annotation.id)}
            />
          )}
        </div>
      ))}
    </>
  );
}
