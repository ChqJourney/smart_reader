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

/** 归一化截图区域（0-1，原点页面左上角），与 pdfTools.ToolImageRegion 同构。 */
export interface SessionImageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 截图工具图片的持久化引用。图片本体落盘在
 * `<AppData>/SpecReader/annotations/sessions/{sessionId}/{file}`，
 * session JSON 里只存这个引用，避免 base64 撑爆会话文件。
 */
export interface SessionImageRef {
  /** 图片文件名（不含目录，位于 sessions/{sessionId}/ 下） */
  file: string;
  page: number;
  region?: SessionImageRegion;
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
  /** 截图工具图片引用（仅 role === "tool" 的截图结果消息） */
  images?: SessionImageRef[];
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

export interface TurnProcess {
  /** 该轮全部 assistant 消息的 reasoningContent 按序合并（无则为 undefined） */
  reasoning?: string;
  /** 该轮全部工具调用事件（含中间消息与流式占位消息上的） */
  toolEvents: ToolEvent[];
}

/**
 * 按「轮」（一个 user 消息到其最终 assistant 正文）归组思考与工具调用。
 * Agent loop 中每个工具轮次会产生一条隐藏的 assistant(toolCalls) 中间消息，
 * reasoningContent / toolEvents 分散在这些中间消息与流式占位消息上；UI 需要把
 * 同一轮的思考 + 工具调用收进该轮最终 assistant 消息的「过程气泡」里展示，
 * 与正文气泡并列（一轮对话 AI 侧最多两个框）。返回 Map：最终 assistant 消息 id
 * → 该轮累计的 TurnProcess（中间消息自身不入 Map，避免重复展示）。
 */
export function collectTurnProcess(
  messages: InterpretationMessage[]
): Map<string, TurnProcess> {
  const map = new Map<string, TurnProcess>();
  let accEvents: ToolEvent[] = [];
  let accReasoning: string[] = [];
  let lastAssistantId: string | null = null;
  const flush = () => {
    if (!lastAssistantId) return;
    const reasoning = accReasoning.join("\n\n");
    if (accEvents.length === 0 && !reasoning) return;
    map.set(lastAssistantId, {
      reasoning: reasoning || undefined,
      toolEvents: accEvents,
    });
  };
  for (const m of messages) {
    if (m.role === "user") {
      flush();
      accEvents = [];
      accReasoning = [];
      lastAssistantId = null;
      continue;
    }
    if (m.role !== "assistant") continue;
    if (m.toolEvents?.length) accEvents = [...accEvents, ...m.toolEvents];
    if (m.reasoningContent) accReasoning.push(m.reasoningContent);
    lastAssistantId = m.id;
  }
  flush();
  return map;
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

/** Uint8Array → base64（分块避免栈溢出，截图图片约数百 KB）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** base64 → Uint8Array。 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 把截图图片字节落盘到 sessions/{sessionId}/ 目录，返回文件名引用。
 * 失败返回 null（调用方降级为纯文本结果，不中断 agent loop）。
 */
export async function saveSessionImage(
  sessionId: string,
  data: Uint8Array
): Promise<string | null> {
  try {
    // 与 export_binary_file 同一传输约定：嵌套 Uint8Array 会被序列化成对象，
    // 必须用普通 number 数组。
    return await invoke<string>("save_session_image", {
      sessionId,
      data: Array.from(data),
    });
  } catch (err) {
    error(`Failed to save session image: ${err}`);
    return null;
  }
}

/** 读取落盘的截图图片字节（追问/重载时回放图片消息用）。 */
export async function readSessionImage(
  sessionId: string,
  file: string
): Promise<Uint8Array | null> {
  try {
    const data = await invoke<number[]>("read_session_image", {
      sessionId,
      file,
    });
    return new Uint8Array(data);
  } catch (err) {
    error(`Failed to read session image: ${err}`);
    return null;
  }
}
