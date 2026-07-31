import { useTranslation } from "react-i18next";
import { useRef, useState } from "react";
import { Annotation } from "../services/annotations";
import { InterpretationSession } from "../services/sessions";
import { llmErrorToMessage } from "../services/llmError";
import Icon from "./Icon";
import MarkdownRenderer from "./MarkdownRenderer";
import { useClampedPopupPosition } from "../hooks/useClampedPopupPosition";
import "./InterpretPopup.css";

interface InterpretPopupProps {
  annotation: Annotation;
  scale: number;
  /** explain = 选区直接解读；interpretedStash = 自定义解读的已解读暂存 */
  variant: "explain" | "interpretedStash";
  /** 关联的解读会话（可能尚未加载或已被删除） */
  session?: InterpretationSession;
  onGotoSession: () => void;
  onReinterpret?: () => void;
  onDelete: () => void;
  onClose: () => void;
}

/**
 * 解读结果内联浮层（explain 与已解读暂存共用）：直接在标记处展示
 * 会话最新一条 assistant 回答（含流式 / 错误态），原文默认折叠，
 * 操作区提供「查看解读（面板展开追问）/ 重新解读 / 删除」。
 */
export default function InterpretPopup({
  annotation,
  scale,
  variant,
  session,
  onGotoSession,
  onReinterpret,
  onDelete,
  onClose,
}: InterpretPopupProps) {
  const { t } = useTranslation();
  const popupRef = useRef<HTMLDivElement>(null);
  // 无会话（异常遗留数据）时默认展开原文，否则结果优先、原文折叠。
  const [sourceExpanded, setSourceExpanded] = useState(!session);
  const left = annotation.position.x * scale;
  const top = annotation.position.y * scale;
  // Clamp inside the page wrapper; re-clamp on wrapper resize (tab activation
  // / async viewport load / zoom). translate(-50%, 12px).
  const pos = useClampedPopupPosition(popupRef, left, top);

  // 内联预览取最后一条有内容的 assistant 消息（agent loop 的最终回答）；
  // 流式中的占位消息内容为空也纳入，用于渲染加载态。
  const answerMessage = session
    ? [...session.messages]
        .reverse()
        .find(
          (m) =>
            m.role === "assistant" &&
            (m.content.trim() !== "" || m.id === session.streamingMessageId)
        )
    : undefined;
  const isStreaming = !!session?.isStreaming;
  const answer = answerMessage?.content ?? "";

  const title =
    variant === "interpretedStash"
      ? t("marker.interpretedStash")
      : t("explain.title");

  return (
    <div
      ref={popupRef}
      className="explain-popup interpret-popup"
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label={
        variant === "interpretedStash"
          ? t("marker.interpretedStash")
          : t("explain.popupLabel")
      }
    >
      <div className="explain-popup-header">
        <span className="explain-popup-title">
          <Icon name="explain" size={14} />
          {title}
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
      <div className="explain-popup-body interpret-popup-body">
        {answerMessage || isStreaming ? (
          <div className="interpret-popup-result">
            {answerMessage?.error ? (
              <p className="interpret-popup-error">
                {llmErrorToMessage(answerMessage.error)}
              </p>
            ) : (
              <>
                {answer ? <MarkdownRenderer content={answer} /> : null}
                {isStreaming && (
                  <div
                    className={`interpret-popup-loading ${answer ? "with-content" : ""}`}
                  >
                    <span className="loading-spinner" />
                    <span>{t("explain.loading")}</span>
                  </div>
                )}
              </>
            )}
          </div>
        ) : null}
        <button
          className="interpret-popup-source-toggle"
          onClick={() => setSourceExpanded((v) => !v)}
          aria-expanded={sourceExpanded}
        >
          <Icon
            name={sourceExpanded ? "chevron-up" : "chevron-down"}
            size={12}
          />
          {t("common.sourceText")}
        </button>
        {sourceExpanded && (
          <div className="explain-popup-source">{annotation.text}</div>
        )}
      </div>
      <div className="explain-popup-footer">
        <button onClick={onGotoSession}>{t("session.viewSession")}</button>
        {onReinterpret && (
          <button onClick={onReinterpret} disabled={isStreaming}>
            {t("explain.reinterpret")}
          </button>
        )}
        <button className="danger" onClick={onDelete}>
          {t("common.delete")}
        </button>
      </div>
    </div>
  );
}
