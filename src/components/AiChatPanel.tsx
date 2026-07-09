import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { StashItem } from "../services/stash";
import {
  InterpretationSession,
} from "../services/sessions";
import Icon from "./Icon";
import CustomInterpretModal from "./CustomInterpretModal";
import {
  loadLlmConfig,
  LlmConfig,
  saveLlmConfig,
} from "../services/llm";

interface AiChatPanelProps {
  stashes: StashItem[];
  sessions: InterpretationSession[];
  expandedSessionId?: string | null;
  onRemoveStash: (id: string) => void;
  onUpdateStash?: (id: string, text: string) => void;
  onClearStashes: () => void;
  onCustomInterpret: (prompt: string) => void;
  onGotoStash?: (stash: StashItem) => void;
  onFollowUp: (sessionId: string, prompt: string) => void;
  onToggleVisibility?: () => void;
}

type Tab = "stash" | "sessions";

export default function AiChatPanel({
  stashes,
  sessions,
  expandedSessionId,
  onRemoveStash,
  onUpdateStash,
  onClearStashes,
  onCustomInterpret,
  onGotoStash,
  onFollowUp,
  onToggleVisibility,
}: AiChatPanelProps) {
  const [config, setConfig] = useState<LlmConfig>(loadLlmConfig);
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>(stashes.length > 0 ? "stash" : "sessions");
  const [expandedId, setExpandedId] = useState<string | null>(expandedSessionId ?? null);

  useEffect(() => {
    if (expandedSessionId) {
      setExpandedId(expandedSessionId);
    }
  }, [expandedSessionId]);
  const [expandedStashIds, setExpandedStashIds] = useState<Set<string>>(new Set());
  const [editingStashId, setEditingStashId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    if (expandedSessionId) {
      setExpandedId(expandedSessionId);
      setActiveTab("sessions");
    }
  }, [expandedSessionId]);

  useEffect(() => {
    setActiveTab(stashes.length > 0 ? "stash" : "sessions");
  }, [stashes.length]);

  const handleSaveConfig = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    saveLlmConfig(config);
    setShowSettings(false);
  };

  const handleSessionClick = (session: InterpretationSession) => {
    setExpandedId((current) => (current === session.id ? null : session.id));
  };

  const handleGotoStash = (stash: StashItem) => {
    onGotoStash?.(stash);
  };

  const sortedSessions = [...sessions].sort((a, b) => b.createdAt - a.createdAt);

  const truncate = (text: string, max: number) => (text.length > max ? text.slice(0, max) + "…" : text);
  const STASH_TRUNCATE_LEN = 120;

  const toggleExpandStash = (id: string) => {
    setExpandedStashIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startEditStash = (stash: StashItem) => {
    setEditingStashId(stash.id);
    setEditText(stash.text);
  };

  const cancelEditStash = () => {
    setEditingStashId(null);
    setEditText("");
  };

  const saveEditStash = () => {
    const trimmed = editText.trim();
    if (!editingStashId || !trimmed) return;
    onUpdateStash?.(editingStashId, trimmed);
    setEditingStashId(null);
    setEditText("");
  };

  return (
    <div className="ai-chat-panel">
      <div className="ai-chat-header">
        <div className="ai-chat-title">
          <Icon name="chat" size={18} />
          <h2>AI 助手</h2>
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

      <div className="ai-chat-tabs">
        <button
          role="tab"
          aria-selected={activeTab === "stash"}
          className={activeTab === "stash" ? "active" : ""}
          onClick={() => setActiveTab("stash")}
        >
          暂存区 ({stashes.length})
        </button>
        <button
          role="tab"
          aria-selected={activeTab === "sessions"}
          className={activeTab === "sessions" ? "active" : ""}
          onClick={() => setActiveTab("sessions")}
        >
          解读记录 ({sessions.length})
        </button>
      </div>

      {activeTab === "stash" && (
        <div className="ai-chat-content stash-list" role="tabpanel">
          {stashes.length === 0 && (
            <p className="ai-chat-placeholder">暂无暂存片段，在 PDF 中选中内容后点击「加入暂存」。</p>
          )}
          {stashes.map((stash) => {
            const isExpanded = expandedStashIds.has(stash.id);
            const isEditing = editingStashId === stash.id;
            const needsTruncate = stash.text.length > STASH_TRUNCATE_LEN;
            return (
              <div key={stash.id} className="stash-item" data-stash-id={stash.id}>
                <div className="stash-item-header">
                  <span className="stash-item-source">
                    {stash.source.fileName} · 第 {stash.source.page} 页
                  </span>
                  <div className="stash-item-actions">
                    {!isEditing && (
                      <button
                        className="icon-btn stash-item-edit"
                        onClick={() => startEditStash(stash)}
                        aria-label="编辑"
                        title="编辑"
                      >
                        <Icon name="edit" size={12} />
                      </button>
                    )}
                    <button
                      className="icon-btn stash-item-delete"
                      onClick={() => onRemoveStash(stash.id)}
                      aria-label="删除"
                      title="删除"
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                </div>
                {isEditing ? (
                  <div className="stash-item-edit-form">
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={3}
                      autoFocus
                    />
                    <div className="stash-item-edit-actions">
                      <button onClick={cancelEditStash}>取消</button>
                      <button className="primary" onClick={saveEditStash} disabled={!editText.trim()}>保存</button>
                    </div>
                  </div>
                ) : (
                  <div
                    className={`stash-item-text ${needsTruncate ? "truncated" : ""}`}
                    onClick={() => handleGotoStash(stash)}
                  >
                    {isExpanded ? stash.text : truncate(stash.text, STASH_TRUNCATE_LEN)}
                    {needsTruncate && (
                      <button
                        className="stash-item-expand"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpandStash(stash.id);
                        }}
                        aria-label={isExpanded ? "收起" : "展开"}
                        title={isExpanded ? "收起" : "展开"}
                      >
                        {isExpanded ? "收起" : "展开"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {stashes.length > 0 && (
            <div className="stash-actions">
              <button onClick={onClearStashes}>清空暂存</button>
              <button
                className="primary"
                onClick={() => setShowModal(true)}
                disabled={stashes.length === 0}
              >
                自定义解读
              </button>
            </div>
          )}
        </div>
      )}

      {activeTab === "sessions" && (
        <div className="ai-chat-content session-list" role="tabpanel">
          {sortedSessions.length === 0 && (
            <p className="ai-chat-placeholder">
              在 PDF 中选中内容，点击「解读」生成解释，或先「加入暂存」再使用自定义解读。
            </p>
          )}
          {sortedSessions.map((session) => {
            const isExpanded = expandedId === session.id;
            const lastUserMessage = [...session.messages]
              .reverse()
              .find((m) => m.role === "user");
            return (
              <div
                key={session.id}
                className={`session-item ${session.isStreaming ? "streaming" : ""} ${
                  isExpanded ? "expanded" : ""
                }`}
              >
                <div className="session-item-header" onClick={() => handleSessionClick(session)}>
                  <div className="session-item-meta">
                    <span className="session-item-source">
                      {session.sources.map((s) => `${s.source.fileName} p.${s.source.page}`).join(" · ")}
                    </span>
                    {session.isStreaming && <span className="session-item-status">解读中…</span>}
                  </div>
                  <span className="session-item-toggle">{isExpanded ? "▼" : "▶"}</span>
                </div>
                <div
                  className="session-item-prompt"
                  onClick={() => handleSessionClick(session)}
                >
                  {truncate(lastUserMessage?.content ?? "", 80)}
                </div>
                {isExpanded && (
                  <div className="session-item-messages">
                    {session.messages.map((message) => (
                      <div
                        key={message.id}
                        className={`session-message ${message.role}`}
                      >
                        <div className="session-message-label">
                          {message.role === "user" ? "你" : "AI"}
                        </div>
                        <div className="session-message-content markdown">
                          {message.role === "assistant" ? (
                            message.content ? (
                              <ReactMarkdown>{message.content}</ReactMarkdown>
                            ) : (
                              <span className="streaming-cursor">▍</span>
                            )
                          ) : (
                            <ReactMarkdown>{message.content}</ReactMarkdown>
                          )}
                        </div>
                      </div>
                    ))}
                    <FollowUpInput
                      disabled={session.isStreaming}
                      onSend={(text) => onFollowUp(session.id, text)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <CustomInterpretModal
          stashCount={stashes.length}
          onSubmit={(prompt) => {
            onCustomInterpret(prompt);
            setShowModal(false);
            setActiveTab("sessions");
          }}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}

interface FollowUpInputProps {
  disabled: boolean;
  onSend: (text: string) => void;
}

function FollowUpInput({ disabled, onSend }: FollowUpInputProps) {
  const [text, setText] = useState("");

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="follow-up-input">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="继续追问..."
        rows={2}
        disabled={disabled}
      />
      <button onClick={handleSend} disabled={disabled || !text.trim()}>
        发送
      </button>
    </div>
  );
}
