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

  const tokenCount = Math.round(reasoningContent.length / 4); // rough estimate

  const label = done
    ? t("thinking.done", {
        defaultValue: `已思考（约 ${tokenCount} tokens）`,
      })
    : t("thinking.thinking", {
        defaultValue: `思考中...（约 ${tokenCount} tokens）`,
      });

  return (
    <div className={`thinking-indicator ${done ? "done" : ""}`}>
      <span
        className="thinking-indicator-icon"
        onClick={() => done && setExpanded(!expanded)}
        role="button"
        tabIndex={0}
      >
        {done ? "✓" : "🌀"}
      </span>
      <span
        onClick={() => done && setExpanded(!expanded)}
        role="button"
        tabIndex={0}
      >
        {label}
        {done && (
          <span style={{ marginLeft: 4, fontSize: "0.7rem", opacity: 0.7 }}>
            {expanded
              ? t("thinking.collapse", { defaultValue: "收起" })
              : t("thinking.expand", { defaultValue: "展开" })}
          </span>
        )}
      </span>
      {expanded && done && reasoningContent && (
        <div className="thinking-indicator-details">{reasoningContent}</div>
      )}
    </div>
  );
}
