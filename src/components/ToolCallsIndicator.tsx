import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ToolEvent } from "../services/sessions";

interface ToolCallsIndicatorProps {
  toolEvents: ToolEvent[];
  isStreaming: boolean;
  /** 该轮最终正文是否已开始输出：开始输出后气泡自动收拢为摘要行 */
  hasFinalContent?: boolean;
}

export default function ToolCallsIndicator({
  toolEvents,
  isStreaming,
  hasFinalContent = false,
}: ToolCallsIndicatorProps) {
  const { t } = useTranslation();
  // 用户手动开合优先于自动状态；null 表示跟随自动
  const [override, setOverride] = useState<boolean | null>(null);

  if (!toolEvents || toolEvents.length === 0) return null;

  // 工具阶段（流式且最终正文尚未输出）自动展开明细；正文开始输出或流结束后
  // 自动收拢为一行摘要，用户仍可点击展开回看。
  const autoExpanded = isStreaming && !hasFinalContent;
  const expanded = override ?? autoExpanded;

  const anyRunning =
    isStreaming && toolEvents.some((e) => e.status === "running");

  return (
    <div className={`tool-calls-indicator ${anyRunning ? "running" : "done"}`}>
      <span
        className="tool-calls-summary"
        onClick={() => setOverride(!expanded)}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
      >
        {anyRunning ? (
          <span className="tool-calls-spinner" aria-hidden="true" />
        ) : (
          <span className="tool-calls-icon">✓</span>
        )}
        {anyRunning
          ? t("tools.callsRunning", { defaultValue: "正在查阅文档…" })
          : t("tools.callsSummary", { count: toolEvents.length })}
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
              {event.status === "running" ? (
                <span className="tool-calls-spinner" aria-hidden="true" />
              ) : (
                <span className="tool-call-status">✓</span>
              )}
              <span className="tool-call-name">{event.name}</span>
              <span className="tool-call-summary">{event.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
