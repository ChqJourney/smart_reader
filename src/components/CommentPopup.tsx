import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { Annotation } from "../services/annotations";
import Icon from "./Icon";
import { useClampedPopupPosition } from "../hooks/useClampedPopupPosition";
import { useDrag } from "../hooks/useDrag";
import "./CommentPopup.css";

interface CommentPopupProps {
  annotation: Annotation;
  scale: number;
  onUpdate: (patch: Partial<Omit<Annotation, "id">>) => void;
  onHide: () => void;
  onClose: () => void;
}

export default function CommentPopup({
  annotation,
  scale,
  onUpdate,
  onHide,
  onClose,
}: CommentPopupProps) {
  const { t } = useTranslation();
  const [localContent, setLocalContent] = useState(annotation.content);
  const popupRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const onUpdateRef = useRef(onUpdate);

  // Keep a fresh callback reference so the cleanup function does not close
  // over a stale `onUpdate` when the component unmounts.
  onUpdateRef.current = onUpdate;

  // 用 ref 持有最新输入，unmount flush 时避免闭包旧值。
  const localContentRef = useRef(localContent);
  localContentRef.current = localContent;

  const left = annotation.position.x * scale;
  const top = annotation.position.y * scale;

  const { isDragging, handlers: dragHandlers } = useDrag({
    onMove: (dx, dy) =>
      onUpdate({
        position: {
          ...annotation.position,
          x: annotation.position.x + dx / scale,
          y: annotation.position.y + dy / scale,
        },
      }),
    threshold: 2,
  });
  // Clamp the popup inside the page wrapper and re-clamp on wrapper resize
  // (tab activation / async viewport load / zoom). translate(-50%, 12px).
  const adjustedPosition = useClampedPopupPosition(
    popupRef,
    left,
    top,
    undefined,
    [localContent]
  );

  // Focus the textarea when the comment is freshly created (empty content),
  // so the user can start typing immediately.
  useEffect(() => {
    if (!annotation.content) {
      textareaRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external content updates (e.g. after persistence load).
  useEffect(() => {
    setLocalContent(annotation.content);
  }, [annotation.content]);

  // Debounce save while editing.
  useEffect(() => {
    const timeout = setTimeout(() => {
      onUpdateRef.current({ content: localContent, isStreaming: false });
    }, 300);
    return () => clearTimeout(timeout);
  }, [localContent]);

  // unmount 时提交最终内容：上面的 300ms 防抖 cleanup 只 clearTimeout，
  // 若用户在窗口期内切页/关闭浮层/退出应用，最后一段输入会丢失。
  // 内容与防抖提交相同（幂等），已保存过的场景重复提交无副作用。
  useEffect(() => {
    return () => {
      onUpdateRef.current({
        content: localContentRef.current,
        isStreaming: false,
      });
    };
  }, []);

  return (
    <div
      ref={popupRef}
      className={`comment-popup ${isDragging ? "dragging" : ""}`}
      style={{ left: adjustedPosition.x, top: adjustedPosition.y }}
    >
      <div
        className="comment-popup-header"
        onMouseDown={dragHandlers.onMouseDown}
      >
        <span className="comment-popup-title">
          <Icon name="comment" size={14} />
          {t("comment.title")}
        </span>
        <div className="comment-popup-actions">
          <button
            className="icon-btn"
            onClick={onHide}
            aria-label={t("comment.hidePopup")}
            title={t("comment.hidePopup")}
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
      <div className="comment-popup-body">
        <textarea
          ref={textareaRef}
          className="comment-popup-textarea"
          value={localContent}
          placeholder={t("comment.placeholder")}
          onChange={(e) => setLocalContent(e.target.value)}
        />
      </div>
    </div>
  );
}
