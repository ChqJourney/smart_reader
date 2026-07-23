import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import "./ContextWidget.css";

interface ContextWidgetProps {
  /** Current context usage in tokens (last prompt_tokens) */
  currentTokens: number;
  /** Context window limit in tokens */
  contextWindow: number;
}

/** Threshold percentages for color coding */
const GREEN_THRESHOLD = 0.7;
const YELLOW_THRESHOLD = 0.9;

export default function ContextWidget({
  currentTokens,
  contextWindow,
}: ContextWidgetProps) {
  const { t } = useTranslation();
  const percent = useMemo(() => {
    if (contextWindow <= 0) return 0;
    const raw = (currentTokens / contextWindow) * 100;
    // When there is token usage, show at least 1% so the widget is never
    // misleadingly "0%" for small-but-non-zero consumption.
    if (currentTokens > 0 && raw < 1) return 1;
    return Math.min(100, Math.round(raw));
  }, [currentTokens, contextWindow]);

  const colorClass = useMemo(() => {
    if (percent >= 100) return "context-widget-red";
    if (percent >= YELLOW_THRESHOLD * 100) return "context-widget-orange";
    if (percent >= GREEN_THRESHOLD * 100) return "context-widget-yellow";
    return "context-widget-green";
  }, [percent]);

  const tooltip = t("contextWidget.tooltip", {
    percent,
    currentTokens,
    contextWindow,
    defaultValue: `上下文已用 ${percent}%（${currentTokens} / ${contextWindow} tokens）`,
  });

  return (
    <div className={`context-widget ${colorClass}`} title={tooltip}>
      <div className="context-widget-bar">
        <div
          className="context-widget-fill"
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </div>
      <span className="context-widget-label">{`${percent}%`}</span>
    </div>
  );
}
