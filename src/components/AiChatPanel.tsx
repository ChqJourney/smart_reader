import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { StashItem } from "../services/stash";
import { InterpretationSession } from "../services/sessions";
import Icon from "./Icon";
import CustomInterpretModal from "./CustomInterpretModal";
import MarkdownRenderer from "./MarkdownRenderer";
import ThinkingIndicator from "./ThinkingIndicator";
import ContextWidget from "./ContextWidget";
import "./AiChatPanel.css";

interface AiChatPanelProps {
  stashes: StashItem[];
  sessions: InterpretationSession[];
  expandedSessionId?: string | null;
  onRemoveStash: (id: string) => void;
  onUpdateStash?: (id: string, text: string) => void;
  onClearStashes: () => void;
  onCustomInterpret: (prompt: string) => void;
  onGotoStash?: (stash: StashItem) => void;
  onGotoSession?: (session: InterpretationSession) => void;
  onFollowUp: (sessionId: string, prompt: string) => void;
  onInterrupt?: (sessionId: string) => void;
  onToggleVisibility?: () => void;
  /** Context window size in tokens (for ContextWidget) */
  contextWindow?: number;
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
  onGotoSession,
  onFollowUp,
  onInterrupt,
  onToggleVisibility,
  contextWindow = 128000,
}: AiChatPanelProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<Tab>(
    stashes.length > 0 ? "stash" : "sessions"
  );
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    expandedSessionId ?? null
  );
  const [expandedStashIds, setExpandedStashIds] = useState<Set<string>>(
    new Set()
  );
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
  const hasUserManuallySwitchedTabRef = useRef(false);

  useEffect(() => {
    if (
      expandedSessionId &&
      expandedSessionId !== prevExpandedSessionIdRef.current
    ) {
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

  // Automatically switch tabs only on the initial stash/session state and only
  // if the user has not manually selected a tab. This prevents the UI from
  // jumping away from the user's current context as stashes are added/removed.
  useEffect(() => {
    if (hasUserManuallySwitchedTabRef.current) return;
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

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => b.createdAt - a.createdAt),
    [sessions]
  );

  const truncate = (text: string, max: number) =>
    text.length > max ? text.slice(0, max) + "…" : text;
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
            aria-label={t("panel.hide")}
            title={t("panel.hide")}
          >
            <Icon name="panel-collapse-right" size={16} />
          </button>
        )}
      </div>
    </div>
  );

  const renderSessionSource = (session: InterpretationSession) =>
    session.sources
      .map((s) => `${s.source.fileName} p.${s.source.page}`)
      .join(" · ");

  return (
    <div className="ai-chat-panel">
      {activeSession ? (
        <>
          {renderHeader(
            <>
              <button
                onClick={exitSessionChatbox}
                className="icon-btn session-back-btn"
                aria-label={t("session.backToList")}
                title={t("session.backToList")}
              >
                <Icon name="chevron-left" size={18} />
              </button>
              <span className="ai-chat-back-title">
                {renderSessionSource(activeSession)}
              </span>
            </>
          )}
          {activeSession.lastPromptTokens != null &&
            activeSession.lastPromptTokens > 0 && (
              <ContextWidget
                currentTokens={activeSession.lastPromptTokens}
                contextWindow={contextWindow}
                frozen={!!activeSession.frozen}
              />
            )}
          <div className="ai-chat-messages" role="log" aria-live="polite">
            {activeSession.messages.map((message) => {
              const isCurrentStreaming =
                activeSession.isStreaming &&
                activeSession.streamingMessageId === message.id;
              const hasReasoning = !!message.reasoningContent;
              const isThinking =
                isCurrentStreaming && hasReasoning && !message.content;
              const thinkingDone = hasReasoning && !!message.content;
              return (
                <div
                  key={message.id}
                  className={`ai-chat-message ${message.role} ${
                    message.role === "assistant" && !message.content
                      ? "streaming"
                      : ""
                  }`}
                >
                  <div className="ai-chat-role">
                    {message.role === "user"
                      ? t("chat.userLabel")
                      : t("chat.aiLabel")}
                  </div>
                  <div className="ai-chat-content">
                    {(hasReasoning || isThinking) && (
                      <ThinkingIndicator
                        isThinking={isThinking}
                        reasoningContent={message.reasoningContent || ""}
                        done={thinkingDone || !isCurrentStreaming}
                      />
                    )}
                    {message.role === "assistant" && !message.content ? (
                      !isThinking ? (
                        <span className="streaming-cursor">▍</span>
                      ) : null
                    ) : (
                      <MarkdownRenderer content={message.content} />
                    )}
                  </div>
                </div>
              );
            })}
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
              <h2>{t("chat.aiAssistant")}</h2>
            </>
          )}

          <div className="ai-chat-tabs">
            <button
              role="tab"
              aria-selected={activeTab === "stash"}
              className={activeTab === "stash" ? "active" : ""}
              onClick={() => {
                hasUserManuallySwitchedTabRef.current = true;
                setActiveTab("stash");
              }}
            >
              {t("stash.tabLabel", { count: stashes.length })}
            </button>
            <button
              role="tab"
              aria-selected={activeTab === "sessions"}
              className={activeTab === "sessions" ? "active" : ""}
              onClick={() => {
                hasUserManuallySwitchedTabRef.current = true;
                setActiveTab("sessions");
              }}
            >
              {t("session.tabLabel", { count: sessions.length })}
            </button>
          </div>

          {activeTab === "stash" && (
            <div className="ai-chat-content stash-list" role="tabpanel">
              {stashes.length === 0 && (
                <p className="ai-chat-placeholder">{t("stash.emptyHint")}</p>
              )}
              {stashes.map((stash) => {
                const isExpanded = expandedStashIds.has(stash.id);
                const isEditing = editingStashId === stash.id;
                const needsTruncate = stash.text.length > STASH_TRUNCATE_LEN;
                return (
                  <div
                    key={stash.id}
                    className="stash-item"
                    data-stash-id={stash.id}
                  >
                    <div className="stash-item-header">
                      <span className="stash-item-source">
                        {t("stash.source", {
                          fileName: stash.source.fileName,
                          page: stash.source.page,
                        })}
                      </span>
                      <div className="stash-item-actions">
                        {!isEditing && (
                          <button
                            className="icon-btn stash-item-edit"
                            onClick={() => startEditStash(stash)}
                            aria-label={t("common.edit")}
                            title={t("common.edit")}
                          >
                            <Icon name="edit" size={12} />
                          </button>
                        )}
                        <button
                          className="icon-btn stash-item-delete"
                          onClick={() => onRemoveStash(stash.id)}
                          aria-label={t("common.delete")}
                          title={t("common.delete")}
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
                          <button onClick={cancelEditStash}>
                            {t("common.cancel")}
                          </button>
                          <button
                            className="primary"
                            onClick={saveEditStash}
                            disabled={!editText.trim()}
                          >
                            {t("common.save")}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div
                        className={`stash-item-text ${needsTruncate ? "truncated" : ""}`}
                        onClick={() => handleGotoStash(stash)}
                      >
                        {isExpanded
                          ? stash.text
                          : truncate(stash.text, STASH_TRUNCATE_LEN)}
                        {needsTruncate && (
                          <button
                            className="stash-item-expand"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleExpandStash(stash.id);
                            }}
                            aria-label={
                              isExpanded
                                ? t("common.collapse")
                                : t("common.expand")
                            }
                            title={
                              isExpanded
                                ? t("common.collapse")
                                : t("common.expand")
                            }
                          >
                            {isExpanded
                              ? t("common.collapse")
                              : t("common.expand")}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {stashes.length > 0 && (
                <div className="stash-actions">
                  <button onClick={onClearStashes}>{t("stash.clear")}</button>
                  <button
                    className="primary"
                    onClick={() => setShowModal(true)}
                    disabled={stashes.length === 0}
                  >
                    {t("customInterpret.title")}
                  </button>
                </div>
              )}
            </div>
          )}

          {activeTab === "sessions" && (
            <div className="ai-chat-content session-list" role="tabpanel">
              {sortedSessions.length === 0 && (
                <p className="ai-chat-placeholder">{t("session.emptyHint")}</p>
              )}
              {sortedSessions.map((session) => {
                const lastUserMessage = [...session.messages]
                  .reverse()
                  .find((m) => m.role === "user");
                return (
                  <div
                    key={session.id}
                    className={`session-item ${session.isStreaming ? "streaming" : ""}`}
                    onClick={() => {
                      onGotoSession?.(session);
                      enterSessionChatbox(session);
                    }}
                  >
                    <div className="session-item-header">
                      <div className="session-item-meta">
                        <span className="session-item-source">
                          {renderSessionSource(session)}
                        </span>
                        {session.isStreaming && (
                          <span className="session-item-status">
                            {t("session.streamingStatus")}
                          </span>
                        )}
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

function FollowUpInput({
  session,
  disabled,
  onSend,
  onInterrupt,
}: FollowUpInputProps) {
  const { t } = useTranslation();
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
        placeholder={
          isStreaming
            ? t("chat.generatingPlaceholder")
            : t("chat.followUpPlaceholder")
        }
        rows={2}
        disabled={disabled}
      />
      <button
        onClick={isStreaming ? onInterrupt : handleSend}
        disabled={!isStreaming && !text.trim()}
        className={isStreaming ? "interrupt" : ""}
      >
        {isStreaming ? t("common.stop") : t("common.send")}
      </button>
    </div>
  );
}
