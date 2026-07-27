import { useState } from "react";
import { useTranslation } from "react-i18next";

interface ThinkingIndicatorProps {
  /** Whether the model is currently producing reasoning content */
  isThinking: boolean;
  /** Accumulated reasoning content */
  reasoningContent: string;
  /** Whether thinking has finished for this message */
  done: boolean;
}

export default function ThinkingIndicator({
  isThinking,
  reasoningContent,
  done,
}: ThinkingIndicatorProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  if (!reasoningContent && !isThinking) return null;

  // 不向非程序员用户暴露 token 概念（且按字符估算对中文严重失真），
  // 只显示状态；思考过程可通过「展开」查看。
  const label = done ? t("thinking.done") : t("thinking.thinking");

  return (
    <div className={`thinking-indicator ${done ? "done" : ""}`}>
      <span
        className="thinking-indicator-icon"
        onClick={() => done && setExpanded(!expanded)}
        role="button"
        tabIndex={0}
      >
        {done ? (
          "✓"
        ) : (
          <span className="thinking-indicator-spinner" aria-hidden="true" />
        )}
      </span>
      <span
        onClick={() => done && setExpanded(!expanded)}
        role="button"
        tabIndex={0}
      >
        {label}
        {done && (
          <span style={{ marginLeft: 4, fontSize: "0.7rem", opacity: 0.7 }}>
            {expanded ? t("thinking.collapse") : t("thinking.expand")}
          </span>
        )}
      </span>
      {expanded && done && reasoningContent && (
        <div className="thinking-indicator-details">{reasoningContent}</div>
      )}
    </div>
  );
}
