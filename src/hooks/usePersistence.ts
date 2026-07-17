import i18n from "i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Annotation,
  createAnnotation,
  loadPdfData,
  savePdfData,
} from "../services/annotations";
import { showConfirm } from "../services/dialog";
import { error, info } from "../services/logs";
import { SelectionState } from "../services/selection";
import {
  InterpretationSession,
  SessionAction,
  appendUserMessage,
  createSession,
  deleteSession,
  deleteSessionOnDisk,
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

export type { SelectionState } from "../services/selection";

export interface UsePersistenceProps {
  activeTab: PdfTab | null;
  activeTabId: string | null;
  secondaryTab: PdfTab | null;
  isSplitView: boolean;
  focusedTab: PdfTab | null;
  openRightPanel: () => void;
  settings: AppSettings;
}

export interface UsePersistenceReturn {
  annotations: Annotation[];
  visibleTabAnnotations: Annotation[];
  setAnnotations: React.Dispatch<React.SetStateAction<Annotation[]>>;
  stashes: StashItem[];
  setStashes: React.Dispatch<React.SetStateAction<StashItem[]>>;
  sessions: InterpretationSession[];
  setSessions: React.Dispatch<React.SetStateAction<InterpretationSession[]>>;
  visibleTabStashes: StashItem[];
  visibleTabSessions: InterpretationSession[];
  focusedTabStashes: StashItem[];
  focusedTabSessions: InterpretationSession[];
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
  focusedTab,
  openRightPanel,
  settings,
}: UsePersistenceProps): UsePersistenceReturn {
  // Annotations are stored per fileHash so that switching tabs never leaks
  // one PDF's markers into another.
  const [annotationsByHash, setAnnotationsByHash] = useState<
    Record<string, Annotation[]>
  >({});
  const [stashes, setStashes] = useState<StashItem[]>([]);
  const [sessions, setSessions] = useState<InterpretationSession[]>([]);

  // Backwards-compatible setter that re-buckets annotations by fileHash.
  // Primarily exposed for tests; prefer the bucket-aware helpers in production.
  const setAnnotations = useCallback(
    (value: React.SetStateAction<Annotation[]>) => {
      const bucket = (annotations: Annotation[]) => {
        const next: Record<string, Annotation[]> = {};
        for (const a of annotations) {
          const hash = a.fileHash || "";
          if (!next[hash]) next[hash] = [];
          next[hash].push(a);
        }
        return next;
      };

      if (typeof value === "function") {
        setAnnotationsByHash((prev) => {
          const all = Object.values(prev).flat();
          return bucket(value(all));
        });
      } else {
        setAnnotationsByHash(bucket(value));
      }
    },
    []
  );

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

  // The right panel follows the focused viewer in split view. When not split,
  // the focused tab is always the active tab.
  const focusedTabStashes = useMemo(
    () => stashes.filter((s) => s.source.tabId === focusedTab?.id),
    [stashes, focusedTab?.id]
  );

  const focusedTabSessions = useMemo(
    () =>
      sessions.filter((s) =>
        s.sources.some((item) => item.source.fileHash === focusedTab?.fileHash)
      ),
    [sessions, focusedTab?.fileHash]
  );

  // Flattened view of all annotations, kept for internal lookups.
  const annotations = useMemo(() => {
    return Object.values(annotationsByHash).flat();
  }, [annotationsByHash]);

  const visibleTabAnnotations = useMemo(() => {
    const result: Annotation[] = [];
    for (const hash of visibleFileHashes) {
      result.push(...(annotationsByHash[hash] || []));
    }
    return result;
  }, [annotationsByHash, visibleFileHashes]);

  const loadedFileHashesRef = useRef<Set<string>>(new Set());

  // Maintain the set of file hashes considered "loaded". When a bucket is
  // removed (e.g. tab closed and hash no longer referenced), drop the hash so
  // reopening the same file later triggers a fresh load.
  useEffect(() => {
    for (const hash of loadedFileHashesRef.current) {
      if (!annotationsByHash[hash] || annotationsByHash[hash].length === 0) {
        loadedFileHashesRef.current.delete(hash);
      }
    }
  }, [annotationsByHash]);

  // Load annotations and sessions when active file changes.
  // Skip if the current fileHash has already been loaded successfully.
  useEffect(() => {
    if (!activeTab?.filePath || !activeTab.fileHash) return;
    const fileHash = activeTab.fileHash;
    if (loadedFileHashesRef.current.has(fileHash)) return;

    let cancelled = false;
    loadPdfData(activeTab.filePath).then(async (data) => {
      if (cancelled) return;
      // Mark as loaded before merging so concurrent StrictMode runs see it.
      loadedFileHashesRef.current.add(fileHash);
      // Replace the bucket for this fileHash. Backfill fileHash for legacy data.
      setAnnotationsByHash((prev) => {
        const loaded = data.annotations
          .filter(
            (a) => a.type !== "stash" || a.interpretedGroupSize !== undefined
          )
          .map((a) => ({ ...a, fileHash: a.fileHash || fileHash }));
        return { ...prev, [fileHash]: loaded };
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
      setAnnotationsByHash((prev) => {
        const loaded = data.annotations
          .filter(
            (a) => a.type !== "stash" || a.interpretedGroupSize !== undefined
          )
          .map((a) => ({ ...a, fileHash: a.fileHash || fileHash }));
        return { ...prev, [fileHash]: loaded };
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

      const hashesToSave = new Set<string>();
      if (activeTab.fileHash) hashesToSave.add(activeTab.fileHash);
      if (
        isSplitView &&
        secondaryTab?.fileHash &&
        secondaryTab.fileHash !== activeTab.fileHash
      ) {
        hashesToSave.add(secondaryTab.fileHash);
      }

      for (const fileHash of hashesToSave) {
        const filePath =
          activeTab.fileHash === fileHash
            ? activeTab.filePath
            : secondaryTab?.filePath;
        if (!filePath) continue;

        const fileAnnotations = annotationsByHash[fileHash] || [];
        const fileSessionIds = sessions
          .filter((s) =>
            s.sources.some((item) => item.source.fileHash === fileHash)
          )
          .map((s) => s.id);

        try {
          await savePdfData(filePath, {
            annotations: fileAnnotations.filter(shouldSaveAnnotation),
            sessionIds: fileSessionIds,
          });
          info(
            `savePdfData succeeded: fileHash=${fileHash} annotations=${fileAnnotations.length} sessions=${fileSessionIds.length}`
          );
        } catch (err) {
          error(`savePdfData failed: ${err}`);
        }
      }
    }, 500);
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [
    annotationsByHash,
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
      // Save all sessions that have changed since last save.
      // Note: we intentionally do NOT delete sessions from disk when they
      // disappear from state — sessions removed due to tab close should
      // persist on disk so they can be restored when the PDF is reopened.
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
      for (const list of Object.values(annotationsByHash)) {
        const annotation = list.find((a) => a.id === id);
        if (annotation) return annotation.sessionId;
      }
      return undefined;
    },
    [annotationsByHash]
  );

  const runSessionStream = useCallback(
    (session: InterpretationSession, messageId: string) => {
      const sessionRef = { current: session };

      const currentSettings = settingsRef.current;
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

      streaming.run(
        messageId,
        messagesForApi,
        {
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
          onReasoningChunk: (_chunk, accumulated) => {
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionRef.current.id) return s;
                return {
                  ...s,
                  messages: s.messages.map((m) =>
                    m.id === messageId
                      ? { ...m, reasoningContent: accumulated }
                      : m
                  ),
                };
              })
            );
          },
          onUsage: (usage) => {
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionRef.current.id) return s;
                const updated = {
                  ...s,
                  lastPromptTokens: usage.promptTokens,
                  messages: s.messages.map((m) =>
                    m.id === messageId ? { ...m, usage } : m
                  ),
                };
                // Keep sessionRef in sync so onDone/onError don't clobber
                // lastPromptTokens with a stale snapshot.
                sessionRef.current = updated;
                return updated;
              })
            );
          },
          onError: (message, error) => {
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
            // Store structured error on the message for ErrorBanner
            const withError = {
              ...updated,
              messages: updated.messages.map((m) =>
                m.id === messageId ? { ...m, error } : m
              ),
            };
            sessionRef.current = withError;
            setSessions((prev) =>
              prev.map((s) => (s.id === withError.id ? withError : s))
            );
            // Finish streaming based on prev state to preserve lastPromptTokens
            setSessions((prev) =>
              prev.map((s) =>
                s.id === sessionRef.current.id
                  ? {
                      ...s,
                      isStreaming: false,
                      streamingMessageId: undefined,
                      updatedAt: Date.now(),
                    }
                  : s
              )
            );
          },
          onDone: () => {
            // Use prev-based update to preserve fields (e.g. lastPromptTokens)
            // that onUsage set in React state but not in sessionRef.
            setSessions((prev) =>
              prev.map((s) =>
                s.id === sessionRef.current.id
                  ? {
                      ...s,
                      isStreaming: false,
                      streamingMessageId: undefined,
                      updatedAt: Date.now(),
                    }
                  : s
              )
            );
          },
        },
        { thinking: currentSettings.thinking }
      );
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
      const fileHash = sources[0]?.source.fileHash;
      if (!fileHash) return { sessionId, session: streamingSession };

      setAnnotationsByHash((prev) => {
        const list = prev[fileHash] || [];
        const updated = list.map((a) =>
          a.type === "stash" && a.stashId && stashIds.has(a.stashId)
            ? {
                ...a,
                interpretedGroupSize: sources.length,
                interpretedIndex: sources.findIndex((s) => s.id === a.stashId),
                sessionId,
              }
            : a
        );
        return { ...prev, [fileHash]: updated };
      });

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
      setAnnotationsByHash((prev) => {
        const fileHash = activeTab.fileHash;
        const list = prev[fileHash] || [];
        return { ...prev, [fileHash]: [...list, stashAnnotation] };
      });
      openRightPanel();
    },
    [activeTab, openRightPanel]
  );

  const handleRemoveStash = useCallback((id: string) => {
    setStashes((prev) => removeStash(prev, id));
    setAnnotationsByHash((prev) => {
      const next: Record<string, Annotation[]> = {};
      for (const [hash, list] of Object.entries(prev)) {
        next[hash] = list.filter((a) => a.stashId !== id);
      }
      return next;
    });
  }, []);

  const handleClearStashes = useCallback(() => {
    const tabIdsToClear = new Set(visibleTabIds);
    const hashesToClear = new Set(
      stashes
        .filter((s) => tabIdsToClear.has(s.source.tabId))
        .map((s) => s.source.fileHash)
    );

    setStashes((prev) =>
      prev.filter((s) => !tabIdsToClear.has(s.source.tabId))
    );
    setAnnotationsByHash((prev) => {
      const next: Record<string, Annotation[]> = {};
      for (const [hash, list] of Object.entries(prev)) {
        if (hashesToClear.has(hash)) {
          next[hash] = list.filter(
            (a) =>
              a.type !== "stash" ||
              a.interpretedGroupSize !== undefined ||
              !tabIdsToClear.has(
                stashes.find((s) => s.id === a.stashId)?.source.tabId ?? ""
              )
          );
        } else {
          next[hash] = list;
        }
      }
      return next;
    });
  }, [visibleTabIds, stashes]);

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
      const stashIdsToRemove = new Set(visibleStashes.map((s) => s.id));
      const hashesToClear = new Set(
        visibleStashes.map((s) => s.source.fileHash)
      );

      setStashes((prev) => prev.filter((s) => !stashIdsToRemove.has(s.id)));
      setAnnotationsByHash((prev) => {
        const next: Record<string, Annotation[]> = {};
        for (const [hash, list] of Object.entries(prev)) {
          if (hashesToClear.has(hash)) {
            next[hash] = list.filter(
              (a) =>
                a.type !== "stash" ||
                a.interpretedGroupSize !== undefined ||
                !stashIdsToRemove.has(a.stashId ?? "")
            );
          } else {
            next[hash] = list;
          }
        }
        return next;
      });
    },
    [activeTab, startSessionFromStashes]
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
      setAnnotationsByHash((prev) => {
        const fileHash = activeTab.fileHash;
        const list = prev[fileHash] || [];
        return { ...prev, [fileHash]: [...list, newAnnotation] };
      });

      if (action === "explain") {
        const prompt = buildSelectionPrompt(
          "explain",
          text,
          settingsRef.current.targetLanguage,
          { fileName: activeTab.fileName, page: selection.page }
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
        setAnnotationsByHash((prev) => {
          const fileHash = activeTab.fileHash;
          const list = prev[fileHash] || [];
          return {
            ...prev,
            [fileHash]: list.map((a) =>
              a.id === newAnnotation.id
                ? { ...a, stashId: sourceStash.id, sessionId }
                : a
            ),
          };
        });
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
      setAnnotationsByHash((prev) => {
        const next: Record<string, Annotation[]> = {};
        for (const [hash, list] of Object.entries(prev)) {
          next[hash] = list.map((a) => (a.id === id ? { ...a, ...patch } : a));
        }
        return next;
      });
    },
    []
  );

  const handleAnnotationDelete = useCallback(
    async (id: string) => {
      let annotation: Annotation | undefined;
      for (const list of Object.values(annotationsByHash)) {
        annotation = list.find((a) => a.id === id);
        if (annotation) break;
      }
      const isInterpretedStash =
        annotation?.type === "stash" &&
        typeof annotation.interpretedGroupSize === "number";

      if (annotation && (annotation.type === "explain" || isInterpretedStash)) {
        const confirmed = await showConfirm(
          i18n.t("confirm.deleteTitle"),
          i18n.t("confirm.deleteExplainBody")
        );
        if (!confirmed) return;
        if (annotation.sessionId) {
          const sessionId = annotation.sessionId;
          setSessions((prev) => deleteSession(prev, sessionId));
          // Explicitly delete the session file from disk (user-initiated delete)
          try {
            await deleteSessionOnDisk(sessionId);
          } catch (err) {
            error(`deleteSessionOnDisk failed: ${err}`);
          }
        }
      }
      setAnnotationsByHash((prev) => {
        const next: Record<string, Annotation[]> = {};
        for (const [hash, list] of Object.entries(prev)) {
          next[hash] = list.filter((a) => a.id !== id);
        }
        return next;
      });
    },
    [annotationsByHash]
  );

  // When a tab is closed, abort its streaming sessions but KEEP the sessions
  // and annotations in state (and on disk) so they can be restored when the
  // PDF is reopened. Only streaming is interrupted; no data is deleted.
  const abortSessionsForTab = useCallback(
    (tabId: string, _fileHash: string, _openTabIds: string[]) => {
      sessions.forEach((session) => {
        const associated = session.sources.some(
          (item) => item.source.tabId === tabId
        );
        if (!associated) return;

        if (session.streamingMessageId) {
          handleInterruptSession(session.id);
        }
      });
    },
    [sessions, handleInterruptSession]
  );

  const handleUpdateStash = useCallback((id: string, text: string) => {
    setStashes((prev) => updateStash(prev, id, text));
    setAnnotationsByHash((prev) => {
      const next: Record<string, Annotation[]> = {};
      for (const [hash, list] of Object.entries(prev)) {
        next[hash] = list.map((a) => (a.stashId === id ? { ...a, text } : a));
      }
      return next;
    });
  }, []);

  return {
    annotations,
    visibleTabAnnotations,
    setAnnotations,
    stashes,
    setStashes,
    sessions,
    setSessions,
    visibleTabStashes,
    visibleTabSessions,
    focusedTabStashes,
    focusedTabSessions,
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
