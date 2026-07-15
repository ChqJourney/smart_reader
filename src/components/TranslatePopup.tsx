import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { Annotation } from "../services/annotations";
import Icon from "./Icon";
import MarkdownRenderer from "./MarkdownRenderer";
import {
  buildSelectionPrompt,
  buildSystemPrompt,
  ChatMessage,
} from "../services/llm";
import { AppSettings } from "../services/settings";
import { useStreaming } from "../hooks/useStreaming";
import { useClampedPopupPosition } from "../hooks/useClampedPopupPosition";
import "./TranslatePopup.css";

interface TranslatePopupProps {
  annotation: Annotation;
  scale: number;
  settings: AppSettings;
  onUpdate: (patch: Partial<Omit<Annotation, "id">>) => void;
  onHide: () => void;
  onClose: () => void;
}

export default function TranslatePopup({
  annotation,
  scale,
  settings,
  onUpdate,
  onHide,
  onClose,
}: TranslatePopupProps) {
  const { t } = useTranslation();
  const [localContent, setLocalContent] = useState(annotation.content);
  const [isStreaming, setIsStreaming] = useState(annotation.isStreaming);
  const [error, setError] = useState<string | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const accumulatedRef = useRef(localContent);
  const onUpdateRef = useRef(onUpdate);

  // Keep a fresh callback reference so the cleanup function does not close
  // over a stale `onUpdate` when the component unmounts.
  onUpdateRef.current = onUpdate;

  const left = annotation.position.x * scale;
  const top = annotation.position.y * scale;

  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  // Clamp the popup inside the page wrapper and re-clamp on wrapper resize
  // (tab activation / async viewport load / zoom). translate(-50%, 12px).
  const adjustedPosition = useClampedPopupPosition(
    popupRef,
    left,
    top,
    undefined,
    [localContent, isStreaming]
  );

  const { run: runStream, abort: abortStream } = useStreaming();

  // Stream translation on mount
  useEffect(() => {
    if (!isStreaming || annotation.content) return;

    const prompt = buildSelectionPrompt(
      "translate",
      annotation.text,
      settings.targetLanguage
    );
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt(
          "translate",
          settings.targetLanguage,
          settings.systemPrompts
        ),
      },
      { role: "user", content: prompt },
    ];

    runStream(
      "translate",
      messages,
      {
        onChunk: (_chunk, accumulated) => {
          accumulatedRef.current = accumulated;
          setLocalContent(accumulated);
        },
        onError: (message) => {
          setError(message);
          setIsStreaming(false);
        },
        onDone: () => {
          setIsStreaming(false);
        },
      },
      { thinking: "disabled" as const }
    );

    return () => {
      abortStream("translate");
      onUpdateRef.current({ content: accumulatedRef.current });
    };
    // This effect intentionally runs only once on mount to start the stream for
    // a newly created translation annotation. `settings` is included so the
    // stream uses the current LLM config; the effect guard above prevents
    // restarts once content has started accumulating.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external content updates (e.g. after persistence load)
  useEffect(() => {
    setLocalContent(annotation.content);
    setIsStreaming(annotation.isStreaming);
  }, [annotation.content, annotation.isStreaming]);

  // Debounce save while streaming
  useEffect(() => {
    const timeout = setTimeout(() => {
      onUpdate({ content: localContent, isStreaming });
    }, 300);
    return () => clearTimeout(timeout);
  }, [localContent, isStreaming, onUpdate]);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !dragStartRef.current) return;
    e.preventDefault();

    const start = dragStartRef.current;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;

    dragStartRef.current = { x: e.clientX, y: e.clientY };

    // Convert viewport delta to PDF original coordinate delta
    onUpdate({
      position: {
        ...annotation.position,
        x: annotation.position.x + dx / scale,
        y: annotation.position.y + dy / scale,
      },
    });
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (!isDragging) return;
    e.preventDefault();
    setIsDragging(false);
    dragStartRef.current = null;
  };

  return (
    <div
      ref={popupRef}
      className={`translate-popup ${isDragging ? "dragging" : ""}`}
      style={{ left: adjustedPosition.x, top: adjustedPosition.y }}
    >
      <div className="translate-popup-header" onMouseDown={handleMouseDown}>
        <span className="translate-popup-title">
          <Icon name="translate" size={14} />
          {t("translate.title")}
        </span>
        <div className="translate-popup-actions">
          <button
            className="icon-btn"
            onClick={onHide}
            aria-label={t("translate.hidePopup")}
            title={t("translate.hidePopup")}
          >
            <Icon name="minus" size={14} />
          </button>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={t("common.delete")}
            title={t("common.delete")}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>
      <div
        className="translate-popup-body"
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {error ? (
          <p className="translate-popup-error">{error}</p>
        ) : (
          <>
            {localContent ? <MarkdownRenderer content={localContent} /> : null}
            {isStreaming && (
              <div
                className={`translate-popup-loading ${localContent ? "with-content" : ""}`}
              >
                <span className="loading-spinner" />
                <span>{t("translate.loading")}</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
