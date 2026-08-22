import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { StashItem } from "../services/stash";
import {
  InterpretationSession,
  SessionSortMode,
  collectTurnProcess,
  sortSessions,
} from "../services/sessions";
import { copyToClipboard } from "../utils/clipboard";
import { buildShareMarkdown, exportSessionMarkdown } from "../services/share";
import { error } from "../services/logs";
import Icon from "./Icon";
import IconSelect from "./IconSelect";
import MarkdownRenderer from "./MarkdownRenderer";
import ThinkingIndicator from "./ThinkingIndicator";
import ToolCallsIndicator from "./ToolCallsIndicator";
import ContextWidget from "./ContextWidget";
import "./AiChatPanel.css";

export type Tab = "stash" | "sessions";

interface AiChatPanelProps {
  stashes: StashItem[];
  /** 当前可见 tab 的会话（默认列表范围） */
  sessions: InterpretationSession[];
  /** 全部已加载会话：sessions tab 的「全部」过滤视图使用 */
  allSessions?: InterpretationSession[];
  expandedSessionId?: string | null;
  onRemoveStash: (id: string) => void;
  onUpdateStash?: (id: string, text: string) => void;
  onClearStashes: () => void;
  /** 打开自定义解读弹窗（弹窗由 App 层统一渲染，内置片段勾选清单）。
   *  preselectedIds 为面板选择模式下的勾选项；null 表示默认全选。 */
  onOpenCustomInterpret: (preselectedIds: Set<string> | null) => void;
  onGotoStash?: (stash: StashItem) => void;
  onGotoSession?: (session: InterpretationSession) => void;
  onFollowUp: (sessionId: string, prompt: string) => void;
  onInterrupt?: (sessionId: string) => void;
  /** 面板内删除会话（连带删除 PDF 上的对应标记） */
  onDeleteSession?: (sessionId: string) => void;
  onToggleVisibility?: () => void;
  /** Context window size in tokens (for ContextWidget) */
  contextWindow?: number;
  /** 解读记录排序方式（由 App 持久化到 settings；缺省时组件内部自持） */
  sessionSortMode?: SessionSortMode;
  onSessionSortModeChange?: (mode: SessionSortMode) => void;
  /** 外部请求激活某个 tab（如 PDF 侧加入暂存 / 发起解读）；nonce 变化即生效，
   *  与用户手动切换无关。 */
  tabRequest?: { tab: Tab; nonce: number };
}

export default function AiChatPanel({
  stashes,
  sessions,
  allSessions,
  expandedSessionId,
  onRemoveStash,
  onUpdateStash,
  onClearStashes,
  onOpenCustomInterpret,
  onGotoStash,
  onGotoSession,
  onFollowUp,
  onInterrupt,
  onDeleteSession,
  onToggleVisibility,
  contextWindow = 128000,
  sessionSortMode,
  onSessionSortModeChange,
  tabRequest,
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
  // 暂存选择模式：进入后点击片段勾选/取消；未进入时自定义解读默认全选
  const [selectingStashes, setSelectingStashes] = useState(false);
  const [selectedStashIds, setSelectedStashIds] = useState<Set<string>>(
    new Set()
  );
  // 会话列表范围：当前可见文档 / 全部已加载会话（跨文档找回解读用）
  const [sessionScope, setSessionScope] = useState<"current" | "all">(
    "current"
  );
  // 排序方式：优先受控于 App（持久化到 settings），未接时组件内部自持（测试场景）
  const [localSortMode, setLocalSortMode] =
    useState<SessionSortMode>("recentActivity");
  const sortMode = sessionSortMode ?? localSortMode;
  const handleSortModeChange = (mode: SessionSortMode) => {
    setLocalSortMode(mode);
    onSessionSortModeChange?.(mode);
  };
  // 分享下拉菜单开合
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const shareMenuRef = useRef<HTMLDivElement>(null);

  const messagesRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const programmaticScrollRef = useRef(false);

  // 会话查找合并「当前 + 全部」：从「全部」视图点进的会话可能不属于
  // 当前可见 tab，仅在 sessions 里找会落空并退回列表。
  const activeSession = useMemo(
    () =>
      (allSessions ?? sessions).find((s) => s.id === activeSessionId) ??
      sessions.find((s) => s.id === activeSessionId) ??
      null,
    [sessions, allSessions, activeSessionId]
  );

  // 解读生成期间自动滚动到底部；用户主动滚动后暂停，回到底部时恢复。
  useEffect(() => {
    if (!messagesRef.current || !autoScroll || !activeSession?.isStreaming)
      return;
    const el = messagesRef.current;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    const raf = requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
    return () => cancelAnimationFrame(raf);
  }, [activeSession?.messages, activeSession?.isStreaming, autoScroll]);

  const handleMessagesScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (programmaticScrollRef.current) return;
    const el = e.currentTarget;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distance < 32;
    setAutoScroll(nearBottom);
  };

  // 将一轮对话（含多个工具轮次）的思考与全部工具调用归组到该轮最终
  // assistant 消息上：AI 侧一轮最多两个框——过程气泡（思考 + 工具调用）
  // 与正文气泡；工具轮次的中间消息本身被过滤不渲染。
  const turnProcessByMessageId = useMemo(
    () => collectTurnProcess(activeSession?.messages ?? []),
    [activeSession]
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

  // PDF 侧动作的显式 tab 激活请求（加入暂存 → 暂存 tab；发起解读 → 解读 tab）。
  // 以 nonce 变化为准，不受用户手动切换标记影响。
  const prevTabRequestNonceRef = useRef(tabRequest?.nonce ?? 0);
  useEffect(() => {
    if (!tabRequest) return;
    if (tabRequest.nonce === prevTabRequestNonceRef.current) return;
    prevTabRequestNonceRef.current = tabRequest.nonce;
    setActiveTab(tabRequest.tab);
  }, [tabRequest]);

  // stash 被删除或清空时同步剔除失效的选中项；stash 清空时退出选择模式
  useEffect(() => {
    setSelectedStashIds((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(stashes.map((s) => s.id));
      const next = new Set([...prev].filter((id) => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
    if (stashes.length === 0) setSelectingStashes(false);
  }, [stashes]);

  const selectedStashes = useMemo(
    () => stashes.filter((s) => selectedStashIds.has(s.id)),
    [stashes, selectedStashIds]
  );
  // 未进入选择模式时，自定义解读默认全选；按钮常驻显示参与片段数量
  const interpretCount = selectingStashes
    ? selectedStashes.length
    : stashes.length;

  const enterSessionChatbox = (session: InterpretationSession) => {
    setActiveSessionId(session.id);
  };

  const exitSessionChatbox = () => {
    setActiveSessionId(null);
  };

  const handleGotoStash = (stash: StashItem) => {
    onGotoStash?.(stash);
  };

  // 首条 user 消息 id：首条是模板拼装的 prompt（折叠 + 来源片段卡片），
  // 其余 user 消息是用户手写的追问，原样展示。
  const activeFirstUserMessageId = useMemo(
    () => activeSession?.messages.find((m) => m.role === "user")?.id ?? null,
    [activeSession]
  );

  const copyActiveSessionTranscript = () => {
    if (!activeSession) return;
    const transcript = activeSession.messages
      .filter((m) => m.role !== "tool" && m.content.trim() !== "")
      .map(
        (m) =>
          `${m.role === "user" ? t("chat.userLabel") : t("chat.aiLabel")}：\n${m.content}`
      )
      .join("\n\n");
    void copyToClipboard(transcript).catch((err) =>
      error(`Failed to copy transcript: ${err}`)
    );
  };

  // 分享菜单打开时，点击菜单外任意处关闭
  useEffect(() => {
    if (!shareMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (
        shareMenuRef.current &&
        !shareMenuRef.current.contains(e.target as Node)
      ) {
        setShareMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [shareMenuOpen]);

  const handleShareCopy = () => {
    if (!activeSession) return;
    setShareMenuOpen(false);
    void copyToClipboard(buildShareMarkdown(activeSession)).catch((err) =>
      error(`Failed to copy share markdown: ${err}`)
    );
  };

  const handleShareExport = () => {
    if (!activeSession) return;
    setShareMenuOpen(false);
    void exportSessionMarkdown(activeSession);
  };

  const listedSessions =
    sessionScope === "all" && allSessions ? allSessions : sessions;
  // 跨文档的「全部文档」范围下页码排序没有意义，回退到最近活动；
  // 不落盘，切回「当前文档」后恢复用户原选择。
  const effectiveSortMode: SessionSortMode =
    sessionScope === "all" && sortMode === "page" ? "recentActivity" : sortMode;
  const sortedSessions = useMemo(
    () => sortSessions(listedSessions, effectiveSortMode),
    [listedSessions, effectiveSortMode]
  );
  const sortOptions = useMemo(
    () =>
      (
        [
          ["recentActivity", t("session.sort.recentActivity")],
          ["createdAt", t("session.sort.createdAt")],
          // 页码排序仅在「当前文档」范围下提供
          ...(sessionScope === "current"
            ? [["page", t("session.sort.page")] as const]
            : []),
        ] as const
      ).map(([value, label]) => ({ value, label })),
    [t, sessionScope]
  );

  const truncate = (text: string, max: number) =>
    text.length > max ? text.slice(0, max) + "…" : text;
  const STASH_TRUNCATE_LEN = 120;

  const toggleSelectingStashes = () => {
    // 退出选择模式时清空选中项
    if (selectingStashes) setSelectedStashIds(new Set());
    setSelectingStashes(!selectingStashes);
  };

  const toggleStashSelected = (id: string) => {
    setSelectedStashIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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

  const renderHeader = (
    children: React.ReactNode,
    extraActions?: React.ReactNode
  ) => (
    <div className="ai-chat-header">
      <div className="ai-chat-title">{children}</div>
      <div className="ai-chat-header-actions">
        {extraActions}
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

  // 页码徽章：来源页去重排序后取前 3 个，如 p.3·7·12
  const renderSessionPages = (session: InterpretationSession) => {
    const pages = [...new Set(session.sources.map((s) => s.source.page))].sort(
      (a, b) => a - b
    );
    if (pages.length === 0) return "";
    const shown = pages.slice(0, 3).join("·");
    return `p.${shown}${pages.length > 3 ? "…" : ""}`;
  };

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
            </>,
            <>
              {activeSession.sources.length > 0 && (
                <button
                  onClick={() => handleGotoStash(activeSession.sources[0])}
                  className="icon-btn session-goto-source-btn"
                  aria-label={t("session.gotoSource")}
                  title={t("session.gotoSource")}
                >
                  <Icon name="bookmark" size={16} />
                </button>
              )}
              <button
                onClick={copyActiveSessionTranscript}
                className="icon-btn session-copy-btn"
                aria-label={t("chat.copyAll")}
                title={t("chat.copyAll")}
              >
                <Icon name="copy" size={16} />
              </button>
              <div className="session-share" ref={shareMenuRef}>
                <button
                  onClick={() => setShareMenuOpen((v) => !v)}
                  className="icon-btn session-share-btn"
                  aria-label={t("share.share")}
                  title={t("share.share")}
                  aria-expanded={shareMenuOpen}
                >
                  <Icon name="share" size={16} />
                </button>
                {shareMenuOpen && (
                  <div className="session-share-menu" role="menu">
                    <button role="menuitem" onClick={handleShareCopy}>
                      {t("share.copyMarkdown")}
                    </button>
                    <button role="menuitem" onClick={handleShareExport}>
                      {t("share.exportMarkdown")}
                    </button>
                  </div>
                )}
              </div>
              {onDeleteSession && (
                <button
                  onClick={() => onDeleteSession(activeSession.id)}
                  className="icon-btn session-delete-btn"
                  aria-label={t("session.delete")}
                  title={t("session.delete")}
                >
                  <Icon name="trash" size={16} />
                </button>
              )}
            </>
          )}
          {activeSession.lastPromptTokens != null &&
            activeSession.lastPromptTokens > 0 && (
              <ContextWidget
                currentTokens={activeSession.lastPromptTokens}
                contextWindow={contextWindow}
              />
            )}
          <div
            ref={messagesRef}
            className="ai-chat-messages"
            role="log"
            aria-live="polite"
            onScroll={handleMessagesScroll}
          >
            {activeSession.messages
              // 工具结果消息用于 LLM 上下文回放，UI 上不展示。工具轮次的
              // 中间 assistant 消息（含仅有 reasoning 的）也隐藏，其
              // reasoningContent / toolEvents 由 collectTurnProcess 归组到
              // 该轮最终 assistant 消息的过程气泡内。
              .filter((message) => {
                if (message.role === "tool") return false;
                if (message.role !== "assistant") return true;
                const isCurrentStreaming =
                  activeSession.isStreaming &&
                  activeSession.streamingMessageId === message.id;
                if (isCurrentStreaming) return true;
                if (message.content.trim() !== "") return true;
                // 中止/异常收尾时正文可能为空：该轮最终消息仍有过程气泡可展示
                return turnProcessByMessageId.has(message.id);
              })
              .map((message) => {
                const isCurrentStreaming =
                  activeSession.isStreaming &&
                  activeSession.streamingMessageId === message.id;
                const turnProcess =
                  message.role === "assistant"
                    ? turnProcessByMessageId.get(message.id)
                    : undefined;
                const turnReasoning = turnProcess?.reasoning ?? "";
                const hasReasoning = turnReasoning !== "";
                const turnToolEvents = turnProcess?.toolEvents ?? [];
                const anyRunningTools =
                  isCurrentStreaming &&
                  turnToolEvents.some((e) => e.status === "running");
                // 思考中 = 流式且本轮正文未输出且不在工具执行阶段
                const isThinking =
                  isCurrentStreaming &&
                  hasReasoning &&
                  !message.content &&
                  !anyRunningTools;
                const hasProcess =
                  hasReasoning || isThinking || turnToolEvents.length > 0;
                // 加载圆点气泡仅在「等待首个 token」阶段出现；思考 / 工具调用
                // 阶段只保留过程气泡，正文气泡要等正文真正开始输出才渲染，
                // 否则会出现一个空白气泡。
                const showStreamingDots =
                  message.role === "assistant" &&
                  isCurrentStreaming &&
                  !message.content &&
                  !isThinking &&
                  !anyRunningTools;
                const hasContentBubble =
                  message.role === "user" ||
                  message.content.trim() !== "" ||
                  showStreamingDots;
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
                    {hasProcess && (
                      <div className="ai-chat-process">
                        {(hasReasoning || isThinking) && (
                          <ThinkingIndicator
                            isThinking={isThinking}
                            reasoningContent={turnReasoning}
                            done={!isThinking}
                          />
                        )}
                        {turnToolEvents.length > 0 && (
                          <ToolCallsIndicator
                            toolEvents={turnToolEvents}
                            isStreaming={isCurrentStreaming}
                            hasFinalContent={message.content.trim() !== ""}
                          />
                        )}
                      </div>
                    )}
                    {hasContentBubble && (
                      <div className="ai-chat-content">
                        {showStreamingDots ? (
                          <span className="streaming-cursor">
                            <span className="streaming-dots" aria-hidden="true">
                              <span />
                              <span />
                              <span />
                            </span>
                          </span>
                        ) : message.role === "user" ? (
                          <UserMessageContent
                            content={message.content}
                            isFirst={message.id === activeFirstUserMessageId}
                            sources={activeSession.sources}
                            onGotoStash={onGotoStash}
                          />
                        ) : (
                          <MarkdownRenderer content={message.content} />
                        )}
                        {message.role === "assistant" &&
                          message.content.trim() !== "" && (
                            <button
                              className="ai-chat-copy-btn"
                              onClick={() =>
                                void copyToClipboard(message.content).catch(
                                  (err) =>
                                    error(`Failed to copy message: ${err}`)
                                )
                              }
                              aria-label={t("chat.copyMessage")}
                              title={t("chat.copyMessage")}
                            >
                              <Icon name="copy" size={12} />
                            </button>
                          )}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
          <div className="ai-chat-input-area">
            <FollowUpInput
              session={activeSession}
              sendDisabled={activeSession.isStreaming}
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
                const isSelected = selectedStashIds.has(stash.id);
                const needsTruncate = stash.text.length > STASH_TRUNCATE_LEN;
                return (
                  <div
                    key={stash.id}
                    className={`stash-item${selectingStashes ? " selecting" : ""}${isSelected ? " selected" : ""}`}
                    data-stash-id={stash.id}
                  >
                    <div className="stash-item-header">
                      <div className="stash-item-header-main">
                        {selectingStashes && (
                          <input
                            type="checkbox"
                            className="stash-item-checkbox"
                            checked={isSelected}
                            onChange={() => toggleStashSelected(stash.id)}
                            aria-label={t("stash.selectItem")}
                          />
                        )}
                        <span className="stash-item-source">
                          {t("stash.source", {
                            fileName: stash.source.fileName,
                            page: stash.source.page,
                          })}
                        </span>
                      </div>
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
                          <Icon name="trash" size={12} />
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
                        onClick={() =>
                          selectingStashes
                            ? toggleStashSelected(stash.id)
                            : handleGotoStash(stash)
                        }
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
                  <button onClick={toggleSelectingStashes}>
                    {selectingStashes ? t("stash.done") : t("stash.select")}
                  </button>
                  <button
                    className="primary"
                    onClick={() => {
                      // 弹窗内置勾选清单：把当前勾选（或全选语义 null）交给弹窗，
                      // 面板的选择模式随即退出，后续调整都在弹窗内完成。
                      onOpenCustomInterpret(
                        selectingStashes ? selectedStashIds : null
                      );
                      setSelectingStashes(false);
                      setSelectedStashIds(new Set());
                    }}
                    disabled={interpretCount === 0}
                  >
                    {t("customInterpret.titleWithCount", {
                      count: interpretCount,
                    })}
                  </button>
                </div>
              )}
            </div>
          )}

          {activeTab === "sessions" && (
            <>
              <div className="session-list-toolbar">
                {allSessions && (
                  <button
                    type="button"
                    className={`session-scope-switch${sessionScope === "all" ? " active" : ""}`}
                    onClick={() =>
                      setSessionScope(
                        sessionScope === "current" ? "all" : "current"
                      )
                    }
                    title={t("session.scopeSwitch")}
                  >
                    <Icon name="swap" size={13} />
                    {sessionScope === "current"
                      ? t("session.scopeCurrent")
                      : t("session.scopeAll")}
                  </button>
                )}
                <div
                  className="session-sort-select"
                  title={t("session.sort.label")}
                >
                  <IconSelect
                    value={effectiveSortMode}
                    options={sortOptions}
                    onChange={(v) => handleSortModeChange(v as SessionSortMode)}
                  />
                </div>
              </div>
              <div className="ai-chat-content session-list" role="tabpanel">
                {sortedSessions.length === 0 && (
                  <p className="ai-chat-placeholder">
                    {t("session.emptyHint")}
                  </p>
                )}
                {sortedSessions.map((session) => {
                  const isCustom = session.action === "custom";
                  // 旧会话没有 LLM summary 时，回退显示首个片段的原文摘要。
                  const fallbackSummary = truncate(
                    session.sources[0]?.text ?? "",
                    80
                  );
                  return (
                    <div
                      key={session.id}
                      className={`session-item ${isCustom ? "custom" : "explain"} ${session.isStreaming ? "streaming" : ""}`}
                      onClick={() => {
                        onGotoSession?.(session);
                        enterSessionChatbox(session);
                      }}
                    >
                      <div className="session-item-header">
                        <div className="session-item-meta">
                          <span className="session-item-page">
                            {renderSessionPages(session)}
                          </span>
                          <span
                            className={`session-item-type ${isCustom ? "custom" : "explain"}`}
                          >
                            {isCustom
                              ? t("session.typeCustom")
                              : t("session.typeExplain")}
                          </span>
                          {session.isStreaming && (
                            <span className="session-item-status">
                              {t("session.streamingStatus")}
                            </span>
                          )}
                        </div>
                        {onDeleteSession && (
                          <button
                            className="icon-btn session-item-delete"
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteSession(session.id);
                            }}
                            aria-label={t("session.delete")}
                            title={t("session.delete")}
                          >
                            <Icon name="trash" size={12} />
                          </button>
                        )}
                      </div>
                      <div className="session-item-summary">
                        {session.summary ?? fallbackSummary}
                      </div>
                      <div className="session-item-source">
                        {renderSessionSource(session)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

const USER_MSG_COLLAPSE_THRESHOLD = 240;
const USER_MSG_COLLAPSE_LEN = 120;
const SOURCE_CARD_TEXT_LEN = 60;

/**
 * user 消息内容：首条是模板拼装的 prompt（含片段原文），默认折叠为摘要并
 * 带来源片段卡片（点击跳原文）；追问消息是用户手写短文本，原样展示。
 */
function UserMessageContent({
  content,
  isFirst,
  sources,
  onGotoStash,
}: {
  content: string;
  isFirst: boolean;
  sources: StashItem[];
  onGotoStash?: (stash: StashItem) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const needsCollapse = content.length > USER_MSG_COLLAPSE_THRESHOLD;
  const shown =
    needsCollapse && !expanded
      ? content.slice(0, USER_MSG_COLLAPSE_LEN) + "…"
      : content;
  return (
    <>
      {isFirst && sources.length > 0 && (
        <div className="ai-chat-source-cards">
          {sources.map((s) => (
            <button
              key={s.id}
              type="button"
              className="ai-chat-source-card"
              onClick={() => onGotoStash?.(s)}
              title={s.text}
            >
              <span className="ai-chat-source-card-meta">
                {t("stash.source", {
                  fileName: s.source.fileName,
                  page: s.source.page,
                })}
              </span>
              <span className="ai-chat-source-card-text">
                {s.text.length > SOURCE_CARD_TEXT_LEN
                  ? s.text.slice(0, SOURCE_CARD_TEXT_LEN) + "…"
                  : s.text}
              </span>
            </button>
          ))}
        </div>
      )}
      <MarkdownRenderer content={shown} />
      {needsCollapse && (
        <button
          type="button"
          className="ai-chat-msg-expand"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? t("common.collapse") : t("common.expand")}
        </button>
      )}
    </>
  );
}

interface FollowUpInputProps {
  session: InterpretationSession;
  sendDisabled: boolean;
  onSend: (text: string) => void;
  onInterrupt: () => void;
}

function FollowUpInput({
  session,
  sendDisabled,
  onSend,
  onInterrupt,
}: FollowUpInputProps) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const isStreaming = session.isStreaming;

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || sendDisabled) return;
    onSend(trimmed);
    setText("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // 生成期间忽略 Enter，避免用户准备下一条问题或误按时中断长答案。
      // 需要停止可点击右侧“中止”按钮。
      if (!isStreaming) {
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
