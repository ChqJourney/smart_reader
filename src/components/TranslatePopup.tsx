import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Annotation } from "../services/annotations";
import Icon from "./Icon";
import MarkdownRenderer from "./MarkdownRenderer";
import { buildSelectionPrompt, buildSystemPrompt, ChatMessage, streamChatCompletion } from "../services/llm";
import { loadSettings } from "../services/settings";

interface TranslatePopupProps {
  annotation: Annotation;
  scale: number;
  onUpdate: (patch: Partial<Omit<Annotation, "id">>) => void;
  onHide: () => void;
  onClose: () => void;
}

export default function TranslatePopup({
  annotation,
  scale,
  onUpdate,
  onHide,
  onClose,
}: TranslatePopupProps) {
  const [localContent, setLocalContent] = useState(annotation.content);
  const [isStreaming, setIsStreaming] = useState(annotation.isStreaming);
  const [error, setError] = useState<string | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const accumulatedRef = useRef(localContent);

  const left = annotation.position.x * scale;
  const top = annotation.position.y * scale;

  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const [adjustedPosition, setAdjustedPosition] = useState({ x: left, y: top });

  // Keep the popup fully inside the PDF page wrapper so it never overflows
  // the page boundary after initial placement, content changes, or dragging.
  useLayoutEffect(() => {
    if (!popupRef.current) return;
    const wrapper = popupRef.current.closest(".pdf-page-wrapper") as HTMLElement | null;
    if (!wrapper) return;

    const popupWidth = popupRef.current.offsetWidth;
    const popupHeight = popupRef.current.offsetHeight;
    const maxX = wrapper.offsetWidth - popupWidth;
    const maxY = wrapper.offsetHeight - popupHeight;

    setAdjustedPosition({
      x: Math.max(0, Math.min(left, maxX)),
      y: Math.max(0, Math.min(top, maxY)),
    });
  }, [left, top, localContent, isStreaming]);

  // Stream translation on mount
  useEffect(() => {
    if (!isStreaming || annotation.content) return;

    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    let accumulated = "";
    let cancelled = false;

    const runTranslation = async () => {
      const settings = await loadSettings();
      if (cancelled) return;
      const prompt = buildSelectionPrompt("translate", annotation.text, settings.targetLanguage);
      const messages: ChatMessage[] = [
        {
          role: "system",
          content: buildSystemPrompt("translate", settings.targetLanguage, settings.systemPrompts),
        },
        { role: "user", content: prompt },
      ];

      try {
        for await (const event of streamChatCompletion(settings.llm, messages, signal)) {
          if (signal.aborted) return;
          if (event.type === "chunk") {
            accumulated += event.content;
            accumulatedRef.current = accumulated;
            setLocalContent(accumulated);
          } else if (event.type === "error") {
            setError(event.message);
            break;
          }
        }
      } catch (err) {
        if (!signal.aborted) {
          setError(`请求失败: ${err}`);
        }
      } finally {
        if (!signal.aborted) {
          setIsStreaming(false);
        }
      }
    };

    runTranslation();

    return () => {
      cancelled = true;
      controller.abort();
      onUpdate({ content: accumulatedRef.current });
    };
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
          翻译
        </span>
        <div className="translate-popup-actions">
          <button
            className="icon-btn"
            onClick={onHide}
            aria-label="隐藏浮层"
            title="隐藏浮层"
          >
            <Icon name="minus" size={14} />
          </button>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label="删除"
            title="删除"
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
            {localContent ? (
              <MarkdownRenderer content={localContent} />
            ) : null}
            {isStreaming && (
              <div className={`translate-popup-loading ${localContent ? "with-content" : ""}`}>
                <span className="loading-spinner" />
                <span>翻译中…</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
