import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Annotation,
  createAnnotation,
  deleteAnnotation,
  getPdfHash,
  loadPdfData,
  savePdfData,
  updateAnnotation,
} from "../services/annotations";
import {
  InterpretationSession,
  appendUserMessage,
  clearLegacySessionsStorage,
  createSession,
  deleteSession,
  deleteSessionOnDisk,
  finishStreaming,
  loadSession,
  loadSessionsFromLegacyStorage,
  saveSession,
  startAssistantResponse,
  updateMessageContent,
} from "../services/sessions";
import {
  StashItem,
  addStash,
  createStashItem,
  removeStash,
  updateStash,
} from "../services/stash";
import { buildCustomInterpretPrompt, buildSelectionPrompt, SelectionAction, loadLlmConfig, streamChatCompletion, ChatMessage } from "../services/llm";
import { PdfTab } from "./useTabs";

export interface SelectionState {
  text: string;
  x: number;
  y: number;
  pdfX: number;
  pdfY: number;
  page: number;
  width?: number;
  height?: number;
}

export interface UsePersistenceProps {
  activeTab: PdfTab | null;
  activeTabId: string | null;
  openRightPanel: () => void;
}

export interface UsePersistenceReturn {
  annotations: Annotation[];
  setAnnotations: React.Dispatch<React.SetStateAction<Annotation[]>>;
  stashes: StashItem[];
  setStashes: React.Dispatch<React.SetStateAction<StashItem[]>>;
  sessions: InterpretationSession[];
  setSessions: React.Dispatch<React.SetStateAction<InterpretationSession[]>>;
  activeTabStashes: StashItem[];
  activeTabSessions: InterpretationSession[];
  handleAddToStash: (selection: SelectionState, text: string) => void;
  handleRemoveStash: (id: string) => void;
  handleClearStashes: () => void;
  handleCustomInterpret: (prompt: string, activeTabStashes: StashItem[]) => void;
  handleSelectionAction: (selection: SelectionState, action: SelectionAction, text: string) => void;
  handleFollowUp: (sessionId: string, prompt: string) => void;
  handleSessionUpdate: (updatedSession: InterpretationSession) => void;
  handleAnnotationUpdate: (id: string, patch: Partial<Omit<Annotation, "id">>) => void;
  handleAnnotationDelete: (id: string) => Promise<void>;
  handleUpdateStash: (id: string, text: string) => void;
  findSessionIdByAnnotationId: (id: string) => string | undefined;
}

export function usePersistence({
  activeTab,
  activeTabId,
  openRightPanel,
}: UsePersistenceProps): UsePersistenceReturn {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [stashes, setStashes] = useState<StashItem[]>([]);
  const [sessions, setSessions] = useState<InterpretationSession[]>([]);

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedSessionsRef = useRef<Record<string, InterpretationSession>>({});
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  const activeTabStashes = useMemo(
    () => (activeTabId ? stashes.filter((s) => s.source.tabId === activeTabId) : []),
    [stashes, activeTabId]
  );

  const activeTabSessions = useMemo(
    () =>
      activeTab?.fileHash
        ? sessions.filter((s) => s.sources.some((item) => item.source.fileHash === activeTab.fileHash))
        : [],
    [sessions, activeTab?.fileHash]
  );

  // Migrate legacy localStorage sessions to backend storage on mount
  useEffect(() => {
    let cancelled = false;
    async function migrate() {
      const legacy = loadSessionsFromLegacyStorage();
      if (legacy.length === 0) return;

      for (const session of legacy) {
        if (cancelled) return;
        const enrichedSources = await Promise.all(
          session.sources.map(async (item) => {
            if (item.source.fileHash) return item;
            try {
              const fileHash = await getPdfHash(item.source.filePath);
              return { ...item, source: { ...item.source, fileHash } };
            } catch {
              return item;
            }
          })
        );
        const migratedSession = { ...session, sources: enrichedSources };
        await saveSession(migratedSession);

        const uniqueHashes = new Map<string, string>();
        enrichedSources.forEach((item) => {
          if (item.source.fileHash) {
            uniqueHashes.set(item.source.fileHash, item.source.filePath);
          }
        });
        for (const [, filePath] of uniqueHashes.entries()) {
          if (cancelled) return;
          try {
            const data = await loadPdfData(filePath);
            if (!data.sessionIds.includes(migratedSession.id)) {
              await savePdfData(filePath, {
                annotations: data.annotations,
                sessionIds: [...data.sessionIds, migratedSession.id],
              });
            }
          } catch {
            // ignore per-pdf migration errors
          }
        }
      }

      clearLegacySessionsStorage();
    }
    migrate();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load annotations and sessions when active file changes
  useEffect(() => {
    if (!activeTab?.filePath) {
      setAnnotations([]);
      return;
    }
    let cancelled = false;
    loadPdfData(activeTab.filePath).then(async (data) => {
      if (cancelled) return;
      // Uninterpreted stash highlights are not persisted across sessions
      setAnnotations(data.annotations.filter((a) => a.type !== "stash" || a.interpretedGroupSize !== undefined));

      const sessionIds = data.sessionIds || [];
      const loadedSessions = await Promise.all(sessionIds.map((id) => loadSession(id)));
      if (cancelled) return;
      setSessions((prev) => {
        const existingIds = new Set(prev.map((s) => s.id));
        const newSessions = loadedSessions.filter(
          (s): s is InterpretationSession => s !== null && !existingIds.has(s.id)
        );
        return newSessions.length > 0 ? [...prev, ...newSessions] : prev;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [activeTab?.filePath, activeTab?.fileHash]);

  // Persist PDF data with debounce (annotations + session references)
  useEffect(() => {
    if (!activeTab?.filePath || !activeTab.fileHash) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      const sessionIds = sessions
        .filter((s) => s.sources.some((item) => item.source.fileHash === activeTab.fileHash))
        .map((s) => s.id);
      savePdfData(activeTab.filePath, {
        annotations: annotations.filter(
          (a) => a.type !== "stash" || a.interpretedGroupSize !== undefined
        ),
        sessionIds,
      });
    }, 500);
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [annotations, sessions, activeTab?.filePath, activeTab?.fileHash]);

  // Persist modified sessions with debounce
  useEffect(() => {
    if (sessionSaveTimeoutRef.current) clearTimeout(sessionSaveTimeoutRef.current);
    sessionSaveTimeoutRef.current = setTimeout(() => {
      sessions.forEach((session) => {
        const saved = savedSessionsRef.current[session.id];
        if (!saved || JSON.stringify(saved) !== JSON.stringify(session)) {
          saveSession(session).then(() => {
            savedSessionsRef.current[session.id] = session;
          });
        }
      });
    }, 500);
    return () => {
      if (sessionSaveTimeoutRef.current) clearTimeout(sessionSaveTimeoutRef.current);
    };
  }, [sessions]);

  // Abort any running streams when the hook unmounts (e.g. app close).
  useEffect(() => {
    return () => {
      abortControllersRef.current.forEach((controller) => controller.abort());
      abortControllersRef.current.clear();
    };
  }, []);

  const findSessionIdByAnnotationId = useCallback((id: string) => {
    const annotation = annotations.find((a) => a.id === id);
    return annotation?.sessionId;
  }, [annotations]);

  const runSessionStream = useCallback((session: InterpretationSession, messageId: string) => {
    const controller = new AbortController();
    abortControllersRef.current.set(messageId, controller);
    const signal = controller.signal;

    let accumulated = "";
    const sessionRef = { current: session };

    const finish = () => {
      abortControllersRef.current.delete(messageId);
    };

    const stream = async () => {
      const config = loadLlmConfig();
      const messagesForApi: ChatMessage[] = [
        {
          role: "system",
          content:
            "你是一位检测认证行业标准文档阅读助手，擅长把复杂的英文标准条款解释得清晰易懂。请基于用户提供的文档片段回答，不要编造片段中未提及的条款或页码。",
        },
        ...sessionRef.current.messages
          .filter((m) => !(m.role === "assistant" && m.id === messageId))
          .map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
      ];

      try {
        for await (const event of streamChatCompletion(config, messagesForApi, signal)) {
          if (signal.aborted) return;
          if (event.type === "chunk") {
            accumulated += event.content;
            const updated = updateMessageContent(sessionRef.current, messageId, accumulated);
            sessionRef.current = updated;
            setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
          } else if (event.type === "error") {
            accumulated += `\n\n[错误] ${event.message}`;
            const updated = updateMessageContent(sessionRef.current, messageId, accumulated);
            sessionRef.current = updated;
            setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
            break;
          }
        }
        if (!signal.aborted) {
          setSessions((prev) =>
            prev.map((s) => (s.id === sessionRef.current.id ? finishStreaming(sessionRef.current) : s))
          );
        }
      } catch (err) {
        if (!signal.aborted) {
          const updated = updateMessageContent(
            sessionRef.current,
            messageId,
            `${accumulated}\n\n[错误] 请求失败: ${err}`
          );
          sessionRef.current = updated;
          setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
          setSessions((prev) =>
            prev.map((s) => (s.id === sessionRef.current.id ? finishStreaming(sessionRef.current) : s))
          );
        }
      } finally {
        finish();
      }
    };

    stream();
  }, []);

  const startSessionFromStashes = useCallback((prompt: string, sources: StashItem[]) => {
    const session = createSession(sources, prompt);
    const streamingSession = startAssistantResponse(session);
    const sessionId = streamingSession.id;
    const messageId = streamingSession.streamingMessageId!;
    setSessions((prev) => [...prev, streamingSession]);
    openRightPanel();

    // Mark each source stash annotation as interpreted, with group size and self index,
    // and link it to the session so the marker can be deleted together with the session.
    const stashIds = new Set(sources.map((s) => s.id));
    setAnnotations((prev) =>
      prev.map((a) =>
        a.type === "stash" && a.stashId && stashIds.has(a.stashId)
          ? {
              ...a,
              interpretedGroupSize: sources.length,
              interpretedIndex: sources.findIndex((s) => s.id === a.stashId),
              sessionId,
            }
          : a
      )
    );

    runSessionStream(streamingSession, messageId);

    return { sessionId, session: streamingSession };
  }, [openRightPanel, runSessionStream]);

  const handleAddToStash = useCallback((selection: SelectionState, text: string) => {
    if (!activeTab) return;

    const stashItem = createStashItem(
      {
        tabId: activeTab.id,
        fileName: activeTab.fileName,
        filePath: activeTab.filePath,
        fileHash: activeTab.fileHash,
        page: selection.page,
        pdfX: selection.pdfX,
        pdfY: selection.pdfY,
      },
      text
    );

    setStashes((prev) => addStash(prev, stashItem));
    const stashAnnotation = createAnnotation(
      "stash",
      text,
      selection.page,
      selection.pdfX,
      selection.pdfY,
      { stashId: stashItem.id, width: selection.width, height: selection.height }
    );
    setAnnotations((prev) => [...prev, stashAnnotation]);
    openRightPanel();
  }, [activeTab, openRightPanel]);

  const handleRemoveStash = useCallback((id: string) => {
    setStashes((prev) => removeStash(prev, id));
    setAnnotations((prev) => prev.filter((a) => a.stashId !== id));
  }, []);

  const handleClearStashes = useCallback(() => {
    setStashes((prev) => prev.filter((s) => s.source.tabId !== activeTabId));
    setAnnotations((prev) => prev.filter((a) => a.type !== "stash"));
  }, [activeTabId]);

  const handleCustomInterpret = useCallback((prompt: string, activeTabStashes: StashItem[]) => {
    if (activeTabStashes.length === 0 || !activeTab) return;
    const enrichedPrompt = buildCustomInterpretPrompt(
      prompt,
      activeTabStashes.map((s) => ({
        fileName: s.source.fileName,
        page: s.source.page,
        text: s.text,
      }))
    );
    startSessionFromStashes(enrichedPrompt, activeTabStashes);

    // Persistence of the session and its PDF references is handled by the
    // debounced effects; avoid manual writes here to prevent clobbering.
    setStashes((prev) => prev.filter((s) => s.source.tabId !== activeTabId));
    // Keep interpreted stash annotations; remove only uninterpreted stash markers.
    setAnnotations((prev) => prev.filter((a) => a.type !== "stash" || a.interpretedGroupSize !== undefined));
  }, [activeTab, activeTabId, startSessionFromStashes]);

  const handleSelectionAction = useCallback((selection: SelectionState, action: SelectionAction, text: string) => {
    if (!activeTab) return;

    const newAnnotation = createAnnotation(action, text, selection.page, selection.pdfX, selection.pdfY);
    setAnnotations((prev) => [...prev, newAnnotation]);

    if (action === "explain") {
      const prompt = buildSelectionPrompt("explain", text);
      const sourceStash = createStashItem(
        {
          tabId: activeTab.id,
          fileName: activeTab.fileName,
          filePath: activeTab.filePath,
          fileHash: activeTab.fileHash,
          page: selection.page,
          pdfX: selection.pdfX,
          pdfY: selection.pdfY,
        },
        text
      );
      const { sessionId } = startSessionFromStashes(prompt, [sourceStash]);

      // Link the annotation to the session; persistence is handled by debounced effects.
      setAnnotations((prev) =>
        prev.map((a) =>
          a.id === newAnnotation.id
            ? { ...a, stashId: sourceStash.id, sessionId }
            : a
        )
      );
    }
  }, [activeTab, startSessionFromStashes]);

  const handleFollowUp = useCallback((sessionId: string, prompt: string) => {
    setSessions((prev) => {
      const next = prev.map((session) => {
        if (session.id !== sessionId) return session;
        const withUserMessage = appendUserMessage(session, prompt);
        return startAssistantResponse(withUserMessage);
      });
      const updatedSession = next.find((s) => s.id === sessionId);
      if (updatedSession?.streamingMessageId) {
        runSessionStream(updatedSession, updatedSession.streamingMessageId);
      }
      return next;
    });
  }, [runSessionStream]);

  const handleSessionUpdate = useCallback((updatedSession: InterpretationSession) => {
    setSessions((prev) => prev.map((s) => (s.id === updatedSession.id ? updatedSession : s)));
  }, []);

  const handleAnnotationUpdate = useCallback((id: string, patch: Partial<Omit<Annotation, "id">>) => {
    setAnnotations((prev) => updateAnnotation(prev, id, patch));
  }, []);

  const handleAnnotationDelete = useCallback(async (id: string) => {
    const annotation = annotations.find((a) => a.id === id);
    const isInterpretedStash =
      annotation?.type === "stash" &&
      typeof annotation.interpretedGroupSize === "number";

    if (annotation?.type === "explain" || isInterpretedStash) {
      const confirmed = window.confirm(
        "确定要删除这条解读吗？原文标记和右侧面板的解读记录将一并删除。"
      );
      if (!confirmed) return;
      if (annotation.sessionId) {
        const sessionId = annotation.sessionId;
        const session = sessions.find((s) => s.id === sessionId);
        if (session) {
          try {
            // Remove session reference from every involved PDF
            const pdfPaths = new Set(session.sources.map((item) => item.source.filePath).filter(Boolean));
            await Promise.all(
              Array.from(pdfPaths).map(async (filePath) => {
                const data = await loadPdfData(filePath);
                await savePdfData(filePath, {
                  annotations: data.annotations.filter((a) => a.id !== id),
                  sessionIds: data.sessionIds.filter((sid) => sid !== sessionId),
                });
              })
            );
            // Remove loaded session from state and disk
            setSessions((prev) => deleteSession(prev, sessionId));
            await deleteSessionOnDisk(sessionId);
            delete savedSessionsRef.current[sessionId];
          } catch (err) {
            console.error("Failed to clean up session during annotation delete:", err);
            // Still remove the session from local state so the UI updates
            setSessions((prev) => deleteSession(prev, sessionId));
          }
        }
      }
    }
    setAnnotations((prev) => deleteAnnotation(prev, id));
  }, [annotations, sessions]);

  const handleUpdateStash = useCallback((id: string, text: string) => {
    setStashes((prev) => updateStash(prev, id, text));
    setAnnotations((prev) => prev.map((a) => (a.stashId === id ? { ...a, text } : a)));
  }, []);

  return {
    annotations,
    setAnnotations,
    stashes,
    setStashes,
    sessions,
    setSessions,
    activeTabStashes,
    activeTabSessions,
    handleAddToStash,
    handleRemoveStash,
    handleClearStashes,
    handleCustomInterpret,
    handleSelectionAction,
    handleFollowUp,
    handleSessionUpdate,
    handleAnnotationUpdate,
    handleAnnotationDelete,
    handleUpdateStash,
    findSessionIdByAnnotationId,
  };
}
