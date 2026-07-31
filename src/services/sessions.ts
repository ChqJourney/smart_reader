import { invoke } from "@tauri-apps/api/core";
import { error } from "./logs";
import { StashItem } from "./stash";
import { SelectionAction } from "./llm";
import type { LlmError, TokenUsage, ToolCall } from "../types/llm";

export type SessionAction = SelectionAction | "custom";

/**
 * 解读记录列表排序方式：
 * - recentActivity：按 updatedAt 降序（追问/流式更新会刷新，默认）
 * - createdAt：按创建时间降序
 * - page：按来源片段最小页码升序（仅「当前文档」范围下可选）
 */
export type SessionSortMode = "recentActivity" | "createdAt" | "page";

export interface ToolEvent {
  name: string;
  summary: string;
  status: "running" | "done";
}

export interface InterpretationMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: number;
  /** Accumulated reasoning/thinking content (for ThinkingIndicator) */
  reasoningContent?: string;
  /** Structured error if the message failed (displayed in the UI) */
  error?: LlmError;
  /** Token usage for this message's LLM call */
  usage?: TokenUsage;
  /** Tool call ID when role === "tool" */
  toolCallId?: string;
  /** Tool name when role === "tool" (for display/audit only) */
  name?: string;
  /** Tool calls initiated by an assistant message */
  toolCalls?: ToolCall[];
  /** UI-facing summary of tool calls executed for this assistant message */
  toolEvents?: ToolEvent[];
}

export interface InterpretationSession {
  id: string;
  sources: StashItem[];
  messages: InterpretationMessage[];
  isStreaming: boolean;
  streamingMessageId?: string;
  action?: SessionAction;
  createdAt: number;
  updatedAt: number;
  /** Last prompt_tokens from the most recent LLM call (for ContextWidget) */
  lastPromptTokens?: number;
  /** LLM 生成的一句话摘要，用于会话列表展示 */
  summary?: string;
}

function createMessage(
  role: "user" | "assistant",
  content: string
): InterpretationMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: Date.now(),
  };
}

export function createSession(
  sources: StashItem[],
  prompt: string,
  action: SessionAction = "explain"
): InterpretationSession {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    sources,
    messages: [createMessage("user", prompt)],
    isStreaming: false,
    action,
    createdAt: now,
    updatedAt: now,
  };
}

export function appendUserMessage(
  session: InterpretationSession,
  content: string
): InterpretationSession {
  return {
    ...session,
    messages: [...session.messages, createMessage("user", content)],
    updatedAt: Date.now(),
  };
}

export function startAssistantResponse(
  session: InterpretationSession
): InterpretationSession {
  const message = createMessage("assistant", "");
  return {
    ...session,
    messages: [...session.messages, message],
    isStreaming: true,
    streamingMessageId: message.id,
    updatedAt: Date.now(),
  };
}

export function updateMessageContent(
  session: InterpretationSession,
  messageId: string,
  content: string
): InterpretationSession {
  const index = session.messages.findIndex((m) => m.id === messageId);
  if (index === -1) return session;

  const messages = [...session.messages];
  messages[index] = { ...messages[index], content };
  return {
    ...session,
    messages,
    updatedAt: Date.now(),
  };
}

export function deleteSession(
  sessions: InterpretationSession[],
  id: string
): InterpretationSession[] {
  return sessions.filter((s) => s.id !== id);
}

/** 页码排序键：来源片段的最小页码；无来源（旧数据）排最后。 */
function minSourcePage(session: InterpretationSession): number {
  let min = Infinity;
  for (const stash of session.sources) {
    if (stash.source.page < min) min = stash.source.page;
  }
  return min;
}

/** 返回按指定方式排序的新数组，不修改入参。 */
export function sortSessions(
  sessions: InterpretationSession[],
  mode: SessionSortMode
): InterpretationSession[] {
  const sorted = [...sessions];
  switch (mode) {
    case "page":
      // 页码相同的并列项按创建时间降序，保证顺序稳定可预期
      sorted.sort(
        (a, b) =>
          minSourcePage(a) - minSourcePage(b) || b.createdAt - a.createdAt
      );
      break;
    case "createdAt":
      sorted.sort((a, b) => b.createdAt - a.createdAt);
      break;
    case "recentActivity":
      sorted.sort((a, b) => b.updatedAt - a.updatedAt);
      break;
  }
  return sorted;
}

export function finishStreaming(
  session: InterpretationSession
): InterpretationSession {
  return {
    ...session,
    isStreaming: false,
    streamingMessageId: undefined,
    updatedAt: Date.now(),
  };
}

// Backend storage helpers
export async function loadSession(
  sessionId: string
): Promise<InterpretationSession | null> {
  try {
    return await invoke<InterpretationSession>("load_session", { sessionId });
  } catch (err) {
    error(`Failed to load session: ${err}`);
    return null;
  }
}

export async function saveSession(
  session: InterpretationSession
): Promise<void> {
  try {
    await invoke("save_session", { session });
  } catch (err) {
    error(`Failed to save session: ${err}`);
  }
}

export async function deleteSessionOnDisk(sessionId: string): Promise<void> {
  try {
    await invoke("delete_session", { sessionId });
  } catch (err) {
    error(`Failed to delete session: ${err}`);
  }
}
