import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ToolEvent } from "../services/sessions";

interface ToolCallsIndicatorProps {
  toolEvents: ToolEvent[];
  isStreaming: boolean;
}

export default function ToolCallsIndicator({
  toolEvents,
  isStreaming,
}: ToolCallsIndicatorProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  if (!toolEvents || toolEvents.length === 0) return null;

  const allDone = toolEvents.every((e) => e.status === "done");

  // 工具调用仍在进行中：只给出一次性提示，不展开每个调用详情
  if (!allDone || isStreaming) {
    return (
      <div className="tool-calls-indicator running">
        <span className="tool-calls-spinner" aria-hidden="true" />
        <span className="tool-calls-running-hint">
          {t("tools.callsRunning", { defaultValue: "正在查阅文档…" })}
        </span>
      </div>
    );
  }

  // 全部完成且流已结束：显示可折叠摘要，详情默认收起
  return (
    <div className="tool-calls-indicator done">
      <span
        className="tool-calls-summary"
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
      >
        <span className="tool-calls-icon">✓</span>
        {t("tools.callsSummary", { count: toolEvents.length })}
        <span className="tool-calls-expand-hint">
          {expanded
            ? t("tools.collapsedSummary", { defaultValue: "收起" })
            : t("tools.expandedSummary", { defaultValue: "展开" })}
        </span>
      </span>
      {expanded && (
        <ul className="tool-calls-list">
          {toolEvents.map((event, idx) => (
            <li key={idx} className="tool-call-item">
              <span className="tool-call-status">✓</span>
              <span className="tool-call-name">{event.name}</span>
              <span className="tool-call-summary">{event.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
