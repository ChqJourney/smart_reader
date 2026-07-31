import { useMemo, useState } from "react";
import { Annotation } from "../services/annotations";
import { InterpretationSession } from "../services/sessions";
import { AppSettings } from "../services/settings";
import AnnotationMarker from "./AnnotationMarker";
import CommentPopup from "./CommentPopup";
import InterpretPopup from "./InterpretPopup";
import TranslatePopup from "./TranslatePopup";

interface PdfAnnotationsProps {
  annotations: Annotation[];
  pageNum: number;
  scale: number;
  fileHash: string;
  /** Source document name, forwarded to popups that build LLM prompts. */
  fileName?: string;
  highlightedId?: string | null;
  /** 已加载的解读会话：解读类标记的内联结果与「生成中」态按 sessionId 查找。 */
  sessions?: InterpretationSession[];
  onUpdate: (id: string, patch: Partial<Omit<Annotation, "id">>) => void;
  onDelete: (id: string) => void;
  onExplainClick: (id: string) => void;
  /** 重新解读指定会话（标记弹层入口，流式中由弹层禁用） */
  onReinterpret?: (sessionId: string) => void;
  settings: AppSettings;
}

export default function PdfAnnotations({
  annotations,
  pageNum,
  scale,
  fileHash,
  fileName,
  highlightedId,
  sessions,
  onUpdate,
  onDelete,
  onExplainClick,
  onReinterpret,
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
        const linkedSession = annotation.sessionId
          ? sessions?.find((s) => s.id === annotation.sessionId)
          : undefined;

        return (
          <div key={annotation.id}>
            <AnnotationMarker
              annotation={annotation}
              scale={scale}
              highlighted={highlightedId === annotation.id}
              pending={linkedSession?.isStreaming}
              onClick={() => {
                if (annotation.type === "translate") {
                  onUpdate(annotation.id, { hidden: !annotation.hidden });
                } else if (
                  annotation.type === "explain" ||
                  annotation.type === "comment" ||
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
                fileName={fileName}
                onUpdate={(patch) => onUpdate(annotation.id, patch)}
                onHide={() => onUpdate(annotation.id, { hidden: true })}
                onClose={() => onDelete(annotation.id)}
              />
            )}
            {annotation.type === "comment" && openPopupId === annotation.id && (
              <CommentPopup
                annotation={annotation}
                scale={scale}
                onUpdate={(patch) => onUpdate(annotation.id, patch)}
                onHide={() => setOpenPopupId(null)}
                onClose={() => {
                  setOpenPopupId(null);
                  onDelete(annotation.id);
                }}
              />
            )}
            {(annotation.type === "explain" || isInterpretedStash) &&
              openPopupId === annotation.id && (
                <InterpretPopup
                  annotation={annotation}
                  scale={scale}
                  variant={
                    annotation.type === "explain"
                      ? "explain"
                      : "interpretedStash"
                  }
                  session={linkedSession}
                  onGotoSession={() => {
                    setOpenPopupId(null);
                    onExplainClick(annotation.id);
                  }}
                  onReinterpret={
                    linkedSession && onReinterpret
                      ? () => onReinterpret(linkedSession.id)
                      : undefined
                  }
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
