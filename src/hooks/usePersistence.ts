import i18n from "i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Annotation,
  createAnnotation,
  deleteAnnotation,
  loadPdfData,
  savePdfData,
  updateAnnotation,
} from "../services/annotations";
import { showConfirm } from "../services/dialog";
import { error, info } from "../services/logs";
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
  ChatMessage,
} from "../services/llm";
import { AppSettings } from "../services/settings";
import { PdfTab } from "./useTabs";
import { useStreaming } from "./useStreaming";

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
  handleSelectionAction: (
    selection: SelectionState,
    action: SelectionAction,
    text: string
  ) => void;
  handleFollowUp: (sessionId: string, prompt: string) => void;
  handleInterruptSession: (sessionId: string) => void;
  handleSessionUpdate: (updatedSession: InterpretationSession) => void;
  handleAnnotationUpdate: (
    id: string,
    patch: Partial<Omit<Annotation, "id">>
  ) => void;
  handleAnnotationDelete: (id: string) => Promise<void>;
  handleUpdateStash: (id: string, text: string) => void;
  findSessionIdByAnnotationId: (id: string) => string | undefined;
  abortSessionsForTab: (
    tabId: string,
    fileHash: string,
    openTabIds: string[]
  ) => void;
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
  const sessionsRef = useRef<InterpretationSession[]>(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const savedSessionsRef = useRef<Record<string, InterpretationSession>>({});
  const settingsRef = useRef<AppSettings>(settings);
  const streaming = useStreaming();
  const { abortAll } = streaming;

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
    if (isSplitView && secondaryTab?.fileHash)
      hashes.add(secondaryTab.fileHash);
    return hashes;
  }, [activeTab?.fileHash, isSplitView, secondaryTab?.fileHash]);

  const visibleTabStashes = useMemo(
    () => stashes.filter((s) => visibleTabIds.has(s.source.tabId)),
    [stashes, visibleTabIds]
  );

  const visibleTabSessions = useMemo(
    () =>
      sessions.filter((s) =>
        s.sources.some((item) => visibleFileHashes.has(item.source.fileHash))
      ),
    [sessions, visibleFileHashes]
  );

  const loadedFileHashesRef = useRef<Set<string>>(new Set());

  // Maintain the set of file hashes considered "loaded". When all annotations
  // for a hash are removed (e.g. tab closed), drop the hash so reopening the
  // same file later triggers a fresh load.
  useEffect(() => {
    const currentHashes = new Set(
      annotations.map((a) => a.fileHash).filter(Boolean)
    );
    for (const hash of loadedFileHashesRef.current) {
      if (!currentHashes.has(hash)) {
        loadedFileHashesRef.current.delete(hash);
      }
    }
  }, [annotations]);

  // Load annotations and sessions when active file changes.
  // Skip if the current fileHash has already been loaded successfully.
  useEffect(() => {
    if (!activeTab?.filePath || !activeTab.fileHash) {
      setAnnotations([]);
      return;
    }
    const fileHash = activeTab.fileHash;
    if (loadedFileHashesRef.current.has(fileHash)) return;

    let cancelled = false;
    loadPdfData(activeTab.filePath).then(async (data) => {
      if (cancelled) return;
      // Mark as loaded before merging so concurrent StrictMode runs see it.
      loadedFileHashesRef.current.add(fileHash);
      // Merge loaded annotations, replacing any previous annotations for the
      // same fileHash. Backfill fileHash for legacy data that lacks it.
      setAnnotations((prev) => {
        const kept = prev.filter((a) => a.fileHash !== fileHash);
        const loaded = data.annotations
          .filter(
            (a) => a.type !== "stash" || a.interpretedGroupSize !== undefined
          )
          .map((a) => ({ ...a, fileHash: a.fileHash || fileHash }));
        return [...kept, ...loaded];
      });

      const sessionIds = data.sessionIds || [];
      const loadedSessions = await Promise.all(
        sessionIds.map((id) => loadSession(id))
      );
      if (cancelled) return;
      setSessions((prev) => {
        const existingIds = new Set(prev.map((s) => s.id));
        const newSessions = loadedSessions.filter(
          (s): s is InterpretationSession =>
            s !== null && !existingIds.has(s.id)
        );
        return newSessions.length > 0 ? [...prev, ...newSessions] : prev;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [activeTab?.filePath, activeTab?.fileHash]);

  // Load secondary PDF annotations and sessions when in split view.
  useEffect(() => {
    if (!isSplitView || !secondaryTab?.filePath || !secondaryTab.fileHash)
      return;
    const fileHash = secondaryTab.fileHash;
    if (loadedFileHashesRef.current.has(fileHash)) return;

    let cancelled = false;
    loadPdfData(secondaryTab.filePath).then(async (data) => {
      if (cancelled) return;
      loadedFileHashesRef.current.add(fileHash);
      setAnnotations((prev) => {
        const kept = prev.filter((a) => a.fileHash !== fileHash);
        const loaded = data.annotations
          .filter(
            (a) => a.type !== "stash" || a.interpretedGroupSize !== undefined
          )
          .map((a) => ({ ...a, fileHash: a.fileHash || fileHash }));
        return [...kept, ...loaded];
      });

      const sessionIds = data.sessionIds || [];
      const loadedSessions = await Promise.all(
        sessionIds.map((id) => loadSession(id))
      );
      if (cancelled) return;
      setSessions((prev) => {
        const existingIds = new Set(prev.map((s) => s.id));
        const newSessions = loadedSessions.filter(
          (s): s is InterpretationSession =>
            s !== null && !existingIds.has(s.id)
        );
        return newSessions.length > 0 ? [...prev, ...newSessions] : prev;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [isSplitView, secondaryTab?.filePath, secondaryTab?.fileHash]);

  // Persist PDF data with debounce (annotations + session references)
  useEffect(() => {
    if (!activeTab?.filePath || !activeTab.fileHash) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      const shouldSaveAnnotation = (a: Annotation) =>
        (a.type !== "stash" || a.interpretedGroupSize !== undefined) &&
        a.fileHash;

      // Active PDF: save current annotations + session refs
      const activeFileHash = activeTab.fileHash;
      const activeAnnotations = annotations.filter(
        (a) => shouldSaveAnnotation(a) && a.fileHash === activeFileHash
      );
      const activeSessionIds = sessions
        .filter((s) =>
          s.sources.some((item) => item.source.fileHash === activeFileHash)
        )
        .map((s) => s.id);
      try {
        await savePdfData(activeTab.filePath, {
          annotations: activeAnnotations,
          sessionIds: activeSessionIds,
        });
        info(
          `savePdfData succeeded: fileHash=${activeFileHash} annotations=${activeAnnotations.length} sessions=${activeSessionIds.length}`
        );
      } catch (err) {
        error(`savePdfData failed: ${err}`);
      }

      // Secondary PDF in split view: annotations now live in state with fileHash,
      // so we can save them directly without loading from disk first.
      if (
        isSplitView &&
        secondaryTab?.filePath &&
        secondaryTab.fileHash &&
        secondaryTab.filePath !== activeTab.filePath
      ) {
        const secondaryFileHash = secondaryTab.fileHash;
        const secondaryAnnotations = annotations.filter(
          (a) => shouldSaveAnnotation(a) && a.fileHash === secondaryFileHash
        );
        const secondarySessionIds = sessions
          .filter((s) =>
            s.sources.some((item) => item.source.fileHash === secondaryFileHash)
          )
          .map((s) => s.id);
        try {
          await savePdfData(secondaryTab.filePath, {
            annotations: secondaryAnnotations,
            sessionIds: secondarySessionIds,
          });
          info(
            `savePdfData secondary succeeded: fileHash=${secondaryFileHash} annotations=${secondaryAnnotations.length} sessions=${secondarySessionIds.length}`
          );
        } catch (err) {
          error(`savePdfData secondary failed: ${err}`);
        }
      }
    }, 500);
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [
    annotations,
    sessions,
    activeTab?.filePath,
    activeTab?.fileHash,
    isSplitView,
    secondaryTab?.filePath,
    secondaryTab?.fileHash,
  ]);

  // Persist modified sessions with debounce, and delete sessions that have been
  // removed from memory so that disk does not retain stale session files.
  useEffect(() => {
    if (sessionSaveTimeoutRef.current)
      clearTimeout(sessionSaveTimeoutRef.current);
    sessionSaveTimeoutRef.current = setTimeout(async () => {
      // Delete any previously saved sessions that no longer exist in state.
      const deletedSessionIds: string[] = [];
      for (const sessionId of Object.keys(savedSessionsRef.current)) {
        if (!sessions.some((s) => s.id === sessionId)) {
          try {
            await deleteSessionOnDisk(sessionId);
            deletedSessionIds.push(sessionId);
          } catch (err) {
            error(`deleteSessionOnDisk failed: ${err}`);
          }
        }
      }
      if (deletedSessionIds.length > 0) {
        info(
          `deleteSessionOnDisk succeeded: count=${deletedSessionIds.length}`
        );
      }
      deletedSessionIds.forEach((sessionId) => {
        delete savedSessionsRef.current[sessionId];
      });

      let savedSessionCount = 0;
      for (const session of sessions) {
        const saved = savedSessionsRef.current[session.id];
        if (!saved || JSON.stringify(saved) !== JSON.stringify(session)) {
          try {
            await saveSession(session);
            savedSessionsRef.current[session.id] = session;
            savedSessionCount += 1;
          } catch (err) {
            error(`saveSession failed: ${err}`);
          }
        }
      }
      if (savedSessionCount > 0) {
        info(`saveSession succeeded: count=${savedSessionCount}`);
      }
    }, 500);
    return () => {
      if (sessionSaveTimeoutRef.current)
        clearTimeout(sessionSaveTimeoutRef.current);
    };
  }, [sessions]);

  // Abort any running streams when the hook unmounts (e.g. app close).
  useEffect(() => {
    return () => {
      abortAll();
    };
  }, [abortAll]);

  const findSessionIdByAnnotationId = useCallback(
    (id: string) => {
      const annotation = annotations.find((a) => a.id === id);
      return annotation?.sessionId;
    },
    [annotations]
  );

  const runSessionStream = useCallback(
    (session: InterpretationSession, messageId: string) => {
      const sessionRef = { current: session };

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

      streaming.run(messageId, config, messagesForApi, {
        onChunk: (_chunk, accumulated) => {
          const updated = updateMessageContent(
            sessionRef.current,
            messageId,
            accumulated
          );
          sessionRef.current = updated;
          setSessions((prev) =>
            prev.map((s) => (s.id === updated.id ? updated : s))
          );
        },
        onError: (message) => {
          const currentContent =
            sessionRef.current.messages.find((m) => m.id === messageId)
              ?.content ?? "";
          const accumulated = `${currentContent}\n\n${i18n.t(
            "common.errorPrefix"
          )} ${message}`;
          const updated = updateMessageContent(
            sessionRef.current,
            messageId,
            accumulated
          );
          sessionRef.current = updated;
          setSessions((prev) =>
            prev.map((s) => (s.id === updated.id ? updated : s))
          );
          setSessions((prev) =>
            prev.map((s) =>
              s.id === sessionRef.current.id
                ? finishStreaming(sessionRef.current)
                : s
            )
          );
        },
        onDone: () => {
          setSessions((prev) =>
            prev.map((s) =>
              s.id === sessionRef.current.id
                ? finishStreaming(sessionRef.current)
                : s
            )
          );
        },
      });
    },
    [streaming]
  );

  const startSessionFromStashes = useCallback(
    (
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
    },
    [openRightPanel, runSessionStream]
  );

  const handleAddToStash = useCallback(
    (selection: SelectionState, text: string) => {
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
        {
          stashId: stashItem.id,
          width: selection.width,
          height: selection.height,
          fileHash: activeTab.fileHash,
        }
      );
      setAnnotations((prev) => [...prev, stashAnnotation]);
      openRightPanel();
    },
    [activeTab, openRightPanel]
  );

  const handleRemoveStash = useCallback((id: string) => {
    setStashes((prev) => removeStash(prev, id));
    setAnnotations((prev) => prev.filter((a) => a.stashId !== id));
  }, []);

  const handleClearStashes = useCallback(() => {
    setStashes((prev) =>
      prev.filter((s) => !visibleTabIds.has(s.source.tabId))
    );
    setAnnotations((prev) => prev.filter((a) => a.type !== "stash"));
  }, [visibleTabIds]);

  const handleCustomInterpret = useCallback(
    (prompt: string, visibleStashes: StashItem[]) => {
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
      setStashes((prev) =>
        prev.filter((s) => !visibleTabIds.has(s.source.tabId))
      );
      // Keep interpreted stash annotations; remove only uninterpreted stash markers.
      setAnnotations((prev) =>
        prev.filter(
          (a) => a.type !== "stash" || a.interpretedGroupSize !== undefined
        )
      );
    },
    [activeTab, visibleTabIds, startSessionFromStashes]
  );

  const handleSelectionAction = useCallback(
    (selection: SelectionState, action: SelectionAction, text: string) => {
      if (!activeTab) return;

      const newAnnotation = createAnnotation(
        action,
        text,
        selection.page,
        selection.pdfX,
        selection.pdfY,
        {
          fileHash: activeTab.fileHash,
        }
      );
      setAnnotations((prev) => [...prev, newAnnotation]);

      if (action === "explain") {
        const prompt = buildSelectionPrompt(
          "explain",
          text,
          settingsRef.current.targetLanguage
        );
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
        const { sessionId } = startSessionFromStashes(
          prompt,
          [sourceStash],
          action
        );

        // Link the annotation to the session; persistence is handled by debounced effects.
        setAnnotations((prev) =>
          prev.map((a) =>
            a.id === newAnnotation.id
              ? { ...a, stashId: sourceStash.id, sessionId }
              : a
          )
        );
      }
    },
    [activeTab, startSessionFromStashes]
  );

  const handleFollowUp = useCallback(
    (sessionId: string, prompt: string) => {
      // Compute the updated session outside the state updater so the side effect
      // of starting a stream is not duplicated when React StrictMode double-
      // invokes updater functions in development.
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;

      const withUserMessage = appendUserMessage(session, prompt);
      const streamingSession = startAssistantResponse(withUserMessage);

      setSessions((prev) => {
        // Guard against the session having been removed since we read the ref.
        if (!prev.some((s) => s.id === sessionId)) return prev;
        return prev.map((s) => (s.id === sessionId ? streamingSession : s));
      });

      if (streamingSession.streamingMessageId) {
        runSessionStream(streamingSession, streamingSession.streamingMessageId);
      }
    },
    [runSessionStream]
  );

  const handleInterruptSession = useCallback(
    (sessionId: string) => {
      const session = sessions.find((s) => s.id === sessionId);
      if (!session?.streamingMessageId) return;
      streaming.abort(session.streamingMessageId);
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? { ...s, isStreaming: false, streamingMessageId: undefined }
            : s
        )
      );
    },
    [sessions, streaming]
  );

  const handleSessionUpdate = useCallback(
    (updatedSession: InterpretationSession) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === updatedSession.id ? updatedSession : s))
      );
    },
    []
  );

  const handleAnnotationUpdate = useCallback(
    (id: string, patch: Partial<Omit<Annotation, "id">>) => {
      setAnnotations((prev) => updateAnnotation(prev, id, patch));
    },
    []
  );

  const handleAnnotationDelete = useCallback(
    async (id: string) => {
      const annotation = annotations.find((a) => a.id === id);
      const isInterpretedStash =
        annotation?.type === "stash" &&
        typeof annotation.interpretedGroupSize === "number";

      if (annotation?.type === "explain" || isInterpretedStash) {
        const confirmed = await showConfirm(
          i18n.t("confirm.deleteTitle"),
          i18n.t("confirm.deleteExplainBody")
        );
        if (!confirmed) return;
        if (annotation.sessionId) {
          const sessionId = annotation.sessionId;
          // Removing the session from state is enough; the debounced session effect
          // will delete the session file and the PDF data effect will remove its
          // references from the currently open PDFs.
          setSessions((prev) => deleteSession(prev, sessionId));
        }
      }
      setAnnotations((prev) => deleteAnnotation(prev, id));
    },
    [annotations]
  );

  // H-6: when a tab is closed, abort its streaming sessions and remove any
  // sessions/annotations that are not shared with another open tab.
  const abortSessionsForTab = useCallback(
    (tabId: string, fileHash: string, openTabIds: string[]) => {
      const sessionIdsToRemove: string[] = [];

      sessions.forEach((session) => {
        const associated = session.sources.some(
          (item) => item.source.tabId === tabId
        );
        if (!associated) return;

        if (session.streamingMessageId) {
          handleInterruptSession(session.id);
        }

        const isShared = session.sources.some(
          (item) =>
            item.source.tabId !== tabId &&
            openTabIds.includes(item.source.tabId)
        );
        if (!isShared) {
          sessionIdsToRemove.push(session.id);
        }
      });

      if (sessionIdsToRemove.length > 0) {
        setSessions((prev) =>
          prev.filter((s) => !sessionIdsToRemove.includes(s.id))
        );
      }
      setAnnotations((prev) =>
        prev.filter(
          (a) =>
            a.fileHash !== fileHash &&
            !sessionIdsToRemove.includes(a.sessionId ?? "")
        )
      );
    },
    [sessions, handleInterruptSession]
  );

  const handleUpdateStash = useCallback((id: string, text: string) => {
    setStashes((prev) => updateStash(prev, id, text));
    setAnnotations((prev) =>
      prev.map((a) => (a.stashId === id ? { ...a, text } : a))
    );
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
    abortSessionsForTab,
  };
}
