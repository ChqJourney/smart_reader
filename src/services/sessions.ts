import { invoke } from "@tauri-apps/api/core";
import { StashItem } from "./stash";
import { SelectionAction } from "./llm";

export type SessionAction = SelectionAction | "custom";

export interface InterpretationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
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
}

const LEGACY_STORAGE_KEY = "standardread-interpretation-sessions";

function createMessage(role: "user" | "assistant", content: string): InterpretationMessage {
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

export function appendUserMessage(session: InterpretationSession, content: string): InterpretationSession {
  return {
    ...session,
    messages: [...session.messages, createMessage("user", content)],
    updatedAt: Date.now(),
  };
}

export function startAssistantResponse(session: InterpretationSession): InterpretationSession {
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

export function deleteSession(sessions: InterpretationSession[], id: string): InterpretationSession[] {
  return sessions.filter((s) => s.id !== id);
}

export function finishStreaming(session: InterpretationSession): InterpretationSession {
  return {
    ...session,
    isStreaming: false,
    streamingMessageId: undefined,
    updatedAt: Date.now(),
  };
}

// Legacy localStorage helpers used for one-time migration.
export function loadSessionsFromLegacyStorage(): InterpretationSession[] {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

export function clearLegacySessionsStorage(): void {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// Backend storage helpers
export async function loadSession(sessionId: string): Promise<InterpretationSession | null> {
  try {
    return await invoke<InterpretationSession>("load_session", { sessionId });
  } catch (err) {
    console.error("Failed to load session:", err);
    return null;
  }
}

export async function saveSession(session: InterpretationSession): Promise<void> {
  try {
    await invoke("save_session", { session });
  } catch (err) {
    console.error("Failed to save session:", err);
  }
}

export async function deleteSessionOnDisk(sessionId: string): Promise<void> {
  try {
    await invoke("delete_session", { sessionId });
  } catch (err) {
    console.error("Failed to delete session:", err);
  }
}
