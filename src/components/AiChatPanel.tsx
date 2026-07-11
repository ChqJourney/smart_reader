import { useEffect, useMemo, useRef, useState } from "react";
import { StashItem } from "../services/stash";
import { InterpretationSession } from "../services/sessions";
import Icon from "./Icon";
import CustomInterpretModal from "./CustomInterpretModal";
import MarkdownRenderer from "./MarkdownRenderer";

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
  onInterrupt?: (sessionId: string) => void;
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
  onInterrupt,
  onToggleVisibility,
}: AiChatPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>(stashes.length > 0 ? "stash" : "sessions");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(expandedSessionId ?? null);
  const [expandedStashIds, setExpandedStashIds] = useState<Set<string>>(new Set());
  const [editingStashId, setEditingStashId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [showModal, setShowModal] = useState(false);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId]
  );

  // Enter chatbox when external code asks to expand a session (e.g. PDF marker click).
  // We only react to prop changes so that the user can navigate back without being
  // immediately pushed into the chatbox again.
  const prevExpandedSessionIdRef = useRef(expandedSessionId);
  useEffect(() => {
    if (expandedSessionId && expandedSessionId !== prevExpandedSessionIdRef.current) {
      setActiveSessionId(expandedSessionId);
      setActiveTab("sessions");
    }
    prevExpandedSessionIdRef.current = expandedSessionId;
  }, [expandedSessionId]);

  // If the active session disappears (deleted), fall back to the list view.
  useEffect(() => {
    if (activeSessionId && !activeSession) {
      setActiveSessionId(null);
    }
  }, [activeSessionId, activeSession]);

  useEffect(() => {
    setActiveTab(stashes.length > 0 ? "stash" : "sessions");
  }, [stashes.length]);

  const enterSessionChatbox = (session: InterpretationSession) => {
    setActiveSessionId(session.id);
  };

  const exitSessionChatbox = () => {
    setActiveSessionId(null);
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

  const renderHeader = (children: React.ReactNode) => (
    <div className="ai-chat-header">
      <div className="ai-chat-title">{children}</div>
      <div className="ai-chat-header-actions">
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
  );

  const renderSessionSource = (session: InterpretationSession) =>
    session.sources.map((s) => `${s.source.fileName} p.${s.source.page}`).join(" · ");

  return (
    <div className="ai-chat-panel">
      {activeSession ? (
        <>
          {renderHeader(
            <>
              <button
                onClick={exitSessionChatbox}
                className="icon-btn session-back-btn"
                aria-label="返回解读记录"
                title="返回解读记录"
              >
                <Icon name="chevron-left" size={18} />
              </button>
              <span className="ai-chat-back-title">{renderSessionSource(activeSession)}</span>
            </>
          )}
          <div className="ai-chat-messages" role="log" aria-live="polite">
            {activeSession.messages.map((message) => (
              <div
                key={message.id}
                className={`ai-chat-message ${message.role} ${
                  message.role === "assistant" && !message.content ? "streaming" : ""
                }`}
              >
                <div className="ai-chat-role">
                  {message.role === "user" ? "你" : "AI"}
                </div>
                <div className="ai-chat-content">
                  {message.role === "assistant" && !message.content ? (
                    <span className="streaming-cursor">▍</span>
                  ) : (
                    <MarkdownRenderer content={message.content} />
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="ai-chat-input-area">
            <FollowUpInput
              session={activeSession}
              disabled={activeSession.isStreaming}
              onSend={(text) => onFollowUp(activeSession.id, text)}
              onInterrupt={() => onInterrupt?.(activeSession.id)}
            />
          </div>
        </>
      ) : (
        <>
          {renderHeader(
            <>
              <Icon name="chat" size={18} />
              <h2>AI 助手</h2>
            </>
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
                          <button className="primary" onClick={saveEditStash} disabled={!editText.trim()}>
                            保存
                          </button>
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
                const lastUserMessage = [...session.messages]
                  .reverse()
                  .find((m) => m.role === "user");
                return (
                  <div
                    key={session.id}
                    className={`session-item ${session.isStreaming ? "streaming" : ""}`}
                    onClick={() => enterSessionChatbox(session)}
                  >
                    <div className="session-item-header">
                      <div className="session-item-meta">
                        <span className="session-item-source">{renderSessionSource(session)}</span>
                        {session.isStreaming && <span className="session-item-status">解读中…</span>}
                      </div>
                    </div>
                    <div className="session-item-prompt">
                      {truncate(lastUserMessage?.content ?? "", 80)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
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
  session: InterpretationSession;
  disabled: boolean;
  onSend: (text: string) => void;
  onInterrupt: () => void;
}

function FollowUpInput({ session, disabled, onSend, onInterrupt }: FollowUpInputProps) {
  const [text, setText] = useState("");
  const isStreaming = session.isStreaming;

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (isStreaming) {
        onInterrupt();
      } else {
        handleSend();
      }
    }
  };

  return (
    <div className="follow-up-input">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={isStreaming ? "生成中…" : "继续追问..."}
        rows={2}
        disabled={disabled}
      />
      <button
        onClick={isStreaming ? onInterrupt : handleSend}
        disabled={!isStreaming && !text.trim()}
        className={isStreaming ? "interrupt" : ""}
      >
        {isStreaming ? "中止" : "发送"}
      </button>
    </div>
  );
}
