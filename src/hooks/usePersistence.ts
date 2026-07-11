import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Annotation,
  createAnnotation,
  deleteAnnotation,
  loadPdfData,
  savePdfData,
  updateAnnotation,
} from "../services/annotations";
import {
  InterpretationSession,
  SessionAction,
  appendUserMessage,
  createSession,
  deleteSession,
  deleteSessionOnDisk,
  finishStreaming,
  loadSession,
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
import {
  buildCustomInterpretPrompt,
  buildSelectionPrompt,
  buildSystemPrompt,
  SelectionAction,
  streamChatCompletion,
  ChatMessage,
} from "../services/llm";
import { AppSettings } from "../services/settings";
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
  secondaryTab: PdfTab | null;
  isSplitView: boolean;
  openRightPanel: () => void;
  settings: AppSettings;
}

export interface UsePersistenceReturn {
  annotations: Annotation[];
  setAnnotations: React.Dispatch<React.SetStateAction<Annotation[]>>;
  stashes: StashItem[];
  setStashes: React.Dispatch<React.SetStateAction<StashItem[]>>;
  sessions: InterpretationSession[];
  setSessions: React.Dispatch<React.SetStateAction<InterpretationSession[]>>;
  visibleTabStashes: StashItem[];
  visibleTabSessions: InterpretationSession[];
  handleAddToStash: (selection: SelectionState, text: string) => void;
  handleRemoveStash: (id: string) => void;
  handleClearStashes: () => void;
  handleCustomInterpret: (prompt: string, visibleStashes: StashItem[]) => void;
  handleSelectionAction: (selection: SelectionState, action: SelectionAction, text: string) => void;
  handleFollowUp: (sessionId: string, prompt: string) => void;
  handleInterruptSession: (sessionId: string) => void;
  handleSessionUpdate: (updatedSession: InterpretationSession) => void;
  handleAnnotationUpdate: (id: string, patch: Partial<Omit<Annotation, "id">>) => void;
  handleAnnotationDelete: (id: string) => Promise<void>;
  handleUpdateStash: (id: string, text: string) => void;
  findSessionIdByAnnotationId: (id: string) => string | undefined;
}

export function usePersistence({
  activeTab,
  activeTabId,
  secondaryTab,
  isSplitView,
  openRightPanel,
  settings,
}: UsePersistenceProps): UsePersistenceReturn {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [stashes, setStashes] = useState<StashItem[]>([]);
  const [sessions, setSessions] = useState<InterpretationSession[]>([]);

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedSessionsRef = useRef<Record<string, InterpretationSession>>({});
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const settingsRef = useRef<AppSettings>(settings);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const visibleTabIds = useMemo(() => {
    const ids = new Set<string>();
    if (activeTabId) ids.add(activeTabId);
    if (isSplitView && secondaryTab?.id) ids.add(secondaryTab.id);
    return ids;
  }, [activeTabId, isSplitView, secondaryTab?.id]);

  const visibleFileHashes = useMemo(() => {
    const hashes = new Set<string>();
    if (activeTab?.fileHash) hashes.add(activeTab.fileHash);
    if (isSplitView && secondaryTab?.fileHash) hashes.add(secondaryTab.fileHash);
    return hashes;
  }, [activeTab?.fileHash, isSplitView, secondaryTab?.fileHash]);

  const visibleTabStashes = useMemo(
    () => stashes.filter((s) => visibleTabIds.has(s.source.tabId)),
    [stashes, visibleTabIds]
  );

  const visibleTabSessions = useMemo(
    () =>
      sessions.filter((s) => s.sources.some((item) => visibleFileHashes.has(item.source.fileHash))),
    [sessions, visibleFileHashes]
  );

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

  // Load secondary PDF sessions when in split view so AI panel can merge records
  useEffect(() => {
    if (!isSplitView || !secondaryTab?.filePath) return;
    let cancelled = false;
    loadPdfData(secondaryTab.filePath).then(async (data) => {
      if (cancelled) return;
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
  }, [isSplitView, secondaryTab?.filePath]);

  // Persist PDF data with debounce (annotations + session references)
  useEffect(() => {
    if (!activeTab?.filePath || !activeTab.fileHash) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      const annotationsToSave = annotations.filter(
        (a) => a.type !== "stash" || a.interpretedGroupSize !== undefined
      );

      // Active PDF: save current annotations + session refs
      const activeSessionIds = sessions
        .filter((s) => s.sources.some((item) => item.source.fileHash === activeTab.fileHash))
        .map((s) => s.id);
      savePdfData(activeTab.filePath, {
        annotations: annotationsToSave,
        sessionIds: activeSessionIds,
      });

      // Secondary PDF in split view: preserve its existing annotations, only update session refs
      if (isSplitView && secondaryTab?.filePath && secondaryTab.fileHash && secondaryTab.filePath !== activeTab.filePath) {
        const secondarySessionIds = sessions
          .filter((s) => s.sources.some((item) => item.source.fileHash === secondaryTab.fileHash))
          .map((s) => s.id);
        loadPdfData(secondaryTab.filePath).then((data) => {
          savePdfData(secondaryTab.filePath, {
            annotations: data.annotations,
            sessionIds: secondarySessionIds,
          });
        });
      }
    }, 500);
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [annotations, sessions, activeTab?.filePath, activeTab?.fileHash, isSplitView, secondaryTab?.filePath, secondaryTab?.fileHash]);

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
      const currentSettings = settingsRef.current;
      const config = currentSettings.llm;
      const messagesForApi: ChatMessage[] = [
        {
          role: "system",
          content: buildSystemPrompt(
            sessionRef.current.action ?? "explain",
            currentSettings.targetLanguage,
            currentSettings.systemPrompts
          ),
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

  const startSessionFromStashes = useCallback((
    prompt: string,
    sources: StashItem[],
    action: SessionAction = "explain"
  ) => {
    const session = createSession(sources, prompt, action);
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
    setStashes((prev) => prev.filter((s) => !visibleTabIds.has(s.source.tabId)));
    setAnnotations((prev) => prev.filter((a) => a.type !== "stash"));
  }, [visibleTabIds]);

  const handleCustomInterpret = useCallback((prompt: string, visibleStashes: StashItem[]) => {
    if (visibleStashes.length === 0 || !activeTab) return;
    const enrichedPrompt = buildCustomInterpretPrompt(
      prompt,
      visibleStashes.map((s) => ({
        fileName: s.source.fileName,
        page: s.source.page,
        text: s.text,
      })),
      settingsRef.current.targetLanguage
    );
    startSessionFromStashes(enrichedPrompt, visibleStashes, "custom");

    // Persistence of the session and its PDF references is handled by the
    // debounced effects; avoid manual writes here to prevent clobbering.
    setStashes((prev) => prev.filter((s) => !visibleTabIds.has(s.source.tabId)));
    // Keep interpreted stash annotations; remove only uninterpreted stash markers.
    setAnnotations((prev) => prev.filter((a) => a.type !== "stash" || a.interpretedGroupSize !== undefined));
  }, [activeTab, visibleTabIds, startSessionFromStashes]);

  const handleSelectionAction = useCallback((selection: SelectionState, action: SelectionAction, text: string) => {
    if (!activeTab) return;

    const newAnnotation = createAnnotation(action, text, selection.page, selection.pdfX, selection.pdfY);
    setAnnotations((prev) => [...prev, newAnnotation]);

    if (action === "explain") {
      const prompt = buildSelectionPrompt("explain", text, settingsRef.current.targetLanguage);
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
      const { sessionId } = startSessionFromStashes(prompt, [sourceStash], action);

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

  const handleInterruptSession = useCallback((sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session?.streamingMessageId) return;
    const controller = abortControllersRef.current.get(session.streamingMessageId);
    controller?.abort();
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, isStreaming: false, streamingMessageId: undefined } : s))
    );
  }, [sessions]);

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
    visibleTabStashes,
    visibleTabSessions,
    handleAddToStash,
    handleRemoveStash,
    handleClearStashes,
    handleCustomInterpret,
    handleSelectionAction,
    handleFollowUp,
    handleInterruptSession,
    handleSessionUpdate,
    handleAnnotationUpdate,
    handleAnnotationDelete,
    handleUpdateStash,
    findSessionIdByAnnotationId,
  };
}
