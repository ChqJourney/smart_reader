import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Annotation } from "../services/annotations";
import Icon from "./Icon";
import { buildSelectionPrompt, ChatMessage, loadLlmConfig, streamChatCompletion } from "../services/llm";

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

  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  const left = annotation.position.x * scale;
  const top = annotation.position.y * scale;

  // Stream translation on mount
  useEffect(() => {
    if (!isStreaming || annotation.content) return;

    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    let accumulated = "";

    const runTranslation = async () => {
      const config = loadLlmConfig();
      const prompt = buildSelectionPrompt("translate", annotation.text);
      const messages: ChatMessage[] = [
        {
          role: "system",
          content:
            "你是一位检测认证行业标准文档翻译助手，擅长把英文标准条款翻译成准确、流畅的中文。",
        },
        { role: "user", content: prompt },
      ];

      try {
        for await (const event of streamChatCompletion(config, messages, signal)) {
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
      style={{ left, top }}
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
              <div className="markdown">
                <ReactMarkdown>{localContent}</ReactMarkdown>
              </div>
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
