import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Annotation } from "../services/annotations";
import Icon from "./Icon";
import {
  buildSelectionPrompt,
  ChatMessage,
  loadLlmConfig,
  LlmConfig,
  saveLlmConfig,
  streamChatCompletion,
} from "../services/llm";

interface AiChatPanelProps {
  explainAnnotations: Annotation[];
  onGotoAnnotation?: (annotation: Annotation) => void;
  onAnnotationUpdate?: (id: string, patch: Partial<Omit<Annotation, "id">>) => void;
  onToggleVisibility?: () => void;
}

export default function AiChatPanel({
  explainAnnotations,
  onGotoAnnotation,
  onAnnotationUpdate,
  onToggleVisibility,
}: AiChatPanelProps) {
  const [config, setConfig] = useState<LlmConfig>(loadLlmConfig);
  const [showSettings, setShowSettings] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const streamingIdsRef = useRef<Set<string>>(new Set());

  // Stream explanation content for new annotations
  useEffect(() => {
    if (!onAnnotationUpdate) return;

    const pending = explainAnnotations.filter(
      (a) => a.type === "explain" && a.isStreaming && !streamingIdsRef.current.has(a.id)
    );

    pending.forEach((annotation) => {
      streamingIdsRef.current.add(annotation.id);

      let cancelled = false;
      let accumulated = annotation.content;

      const runExplain = async () => {
        const prompt = buildSelectionPrompt("explain", annotation.text);
        const messages: ChatMessage[] = [
          {
            role: "system",
            content:
              "你是一位检测认证行业标准文档阅读助手，擅长把复杂的英文标准条款解释得清晰易懂。",
          },
          { role: "user", content: prompt },
        ];

        try {
          for await (const event of streamChatCompletion(config, messages)) {
            if (cancelled) return;
            if (event.type === "chunk") {
              accumulated += event.content;
              onAnnotationUpdate(annotation.id, { content: accumulated });
            } else if (event.type === "error") {
              accumulated += `\n\n[错误] ${event.message}`;
              onAnnotationUpdate(annotation.id, { content: accumulated });
              break;
            }
          }
        } catch (err) {
          if (!cancelled) {
            onAnnotationUpdate(annotation.id, {
              content: `${accumulated}\n\n[错误] 请求失败: ${err}`,
            });
          }
        } finally {
          if (!cancelled) {
            onAnnotationUpdate(annotation.id, { isStreaming: false });
          }
          streamingIdsRef.current.delete(annotation.id);
        }
      };

      runExplain();
    });
  }, [explainAnnotations, config, onAnnotationUpdate]);

  const handleSaveConfig = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    saveLlmConfig(config);
    setShowSettings(false);
  };

  const handleItemClick = (annotation: Annotation) => {
    const willExpand = expandedId !== annotation.id;
    setExpandedId(willExpand ? annotation.id : null);
    if (willExpand) {
      onGotoAnnotation?.(annotation);
    }
  };

  const sortedAnnotations = [...explainAnnotations].sort((a, b) => b.createdAt - a.createdAt);

  const truncate = (text: string, max: number) => (text.length > max ? text.slice(0, max) + "…" : text);

  return (
    <div className="ai-chat-panel">
      <div className="ai-chat-header">
        <div className="ai-chat-title">
          <Icon name="chat" size={18} />
          <h2>解读记录</h2>
        </div>
        <div className="ai-chat-header-actions">
          <button
            onClick={() => setShowSettings((s) => !s)}
            className={`icon-btn settings-toggle ${showSettings ? "active" : ""}`}
            aria-label={showSettings ? "关闭设置" : "打开设置"}
            title={showSettings ? "关闭设置" : "打开设置"}
          >
            <Icon name="settings" size={16} />
          </button>
          {onToggleVisibility && (
            <button
              onClick={onToggleVisibility}
              className="icon-btn panel-hide-btn"
              aria-label="隐藏面板"
              title="隐藏面板"
            >
              <Icon name="hide-right" size={16} />
            </button>
          )}
        </div>
      </div>

      {showSettings && (
        <form className="llm-config-form" onSubmit={handleSaveConfig}>
          <label>
            API Base URL
            <input
              type="text"
              value={config.baseUrl}
              onChange={(e) => setConfig((c) => ({ ...c, baseUrl: e.target.value }))}
              placeholder="https://api.openai.com/v1"
            />
          </label>
          <label>
            API Key
            <input
              type="password"
              value={config.apiKey}
              onChange={(e) => setConfig((c) => ({ ...c, apiKey: e.target.value }))}
              placeholder="sk-..."
            />
          </label>
          <label>
            Model
            <input
              type="text"
              value={config.model}
              onChange={(e) => setConfig((c) => ({ ...c, model: e.target.value }))}
              placeholder="gpt-4o-mini"
            />
          </label>
          <button type="submit">保存配置</button>
        </form>
      )}

      <div className="ai-chat-messages explain-list">
        {sortedAnnotations.length === 0 && (
          <p className="ai-chat-placeholder">
            在 PDF 中选中内容，点击「解读」生成解释。
          </p>
        )}
        {sortedAnnotations.map((annotation) => {
          const isExpanded = expandedId === annotation.id;
          return (
            <div
              key={annotation.id}
              className={`explain-item ${annotation.isStreaming ? "streaming" : ""} ${
                isExpanded ? "expanded" : ""
              }`}
              onClick={() => handleItemClick(annotation)}
            >
              <div className="explain-item-header">
                <div className="explain-item-meta">
                  <span className="explain-item-page">第 {annotation.position.page} 页</span>
                  {annotation.isStreaming && <span className="explain-item-status">解读中…</span>}
                </div>
                <span className="explain-item-toggle">{isExpanded ? "▼" : "▶"}</span>
              </div>
              <div className="explain-item-source">{truncate(annotation.text, 80)}</div>
              {isExpanded && annotation.content && (
                <div className="explain-item-content markdown">
                  <ReactMarkdown>{annotation.content}</ReactMarkdown>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
