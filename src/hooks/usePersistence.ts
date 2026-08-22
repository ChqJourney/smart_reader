import i18n from "i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Annotation,
  createAnnotation,
  loadPdfData,
  savePdfData,
} from "../services/annotations";
import { showConfirm } from "../services/dialog";
import { error, info, warn } from "../services/logs";
import { SelectionState } from "../services/selection";
import {
  InterpretationMessage,
  InterpretationSession,
  SessionAction,
  SessionImageRef,
  ToolEvent,
  appendUserMessage,
  bytesToBase64,
  createSession,
  deleteSession,
  deleteSessionOnDisk,
  loadSession,
  readSessionImage,
  saveSession,
  saveSessionImage,
  startAssistantResponse,
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
  ToolCall,
} from "../services/llm";
import type { TokenUsage } from "../types/llm";
import { AppSettings } from "../services/settings";
import { PLATFORM_PRESETS, modelSupportsVision } from "../data/platformPresets";
import { PdfTab } from "./useTabs";
import { useStreaming } from "./useStreaming";
import { beginToolSession, ToolSession } from "../services/pdfTools";
import { getOpenFileHashes } from "../services/pdfToolsRegistry";

export type { SelectionState } from "../services/selection";

// 流式 chunk 合批间隔：SSE chunk 频率远高于渲染吞吐，逐 chunk setSessions
// 会让每个 chunk 都触发整棵子树重渲染（可见 PdfPage + 每条消息的
// react-markdown 全量重跑）。ref 累积 + 50ms 定时 flush 一次即可。
const STREAM_FLUSH_INTERVAL = 50;

/**
 * 会话归属判定：常规会话靠 sources 里的 fileHash；无选区自由提问会话
 * （空 sources）靠 anchorFileHash 锚点归属到创建时 focused tab 的文档。
 */
function sessionBelongsToHashes(
  session: InterpretationSession,
  hashes: ReadonlySet<string>
): boolean {
  if (
    session.anchorFileHash !== undefined &&
    hashes.has(session.anchorFileHash)
  ) {
    return true;
  }
  return session.sources.some((item) => hashes.has(item.source.fileHash));
}

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
  /** 按 fileHash 分桶的批注（keep-alive viewer 按 tab 各自传递）。 */
  annotationsByHash: Record<string, Annotation[]>;
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
  handleAddComment: (selection: SelectionState, text: string) => void;
  handleRemoveStash: (id: string) => void;
  handleClearStashes: () => void;
  handleCustomInterpret: (prompt: string, visibleStashes: StashItem[]) => void;
  /** 无选区自由提问：创建空 sources 的锚定会话，返回新会话 id（无锚定文档时 null） */
  handleFreeQuestion: (prompt: string) => string | null;
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
  handleDeleteSession: (sessionId: string) => Promise<void>;
  handleReinterpretSession: (sessionId: string) => void;
  handleUpdateStash: (id: string, text: string) => void;
  findSessionIdByAnnotationId: (id: string) => string | undefined;
  abortSessionsForTab: (
    tabId: string,
    fileHash: string,
    openTabIds: string[]
  ) => void;
  /** 退出前立即落盘：清掉防抖定时器，同步保存所有脏 hash 与变更会话。 */
  flushPendingSaves: () => Promise<void>;
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
  const [annotationsByHash, setAnnotationsByHashState] = useState<
    Record<string, Annotation[]>
  >({});

  // 任何批注变更都把对应 fileHash 标脏：防抖保存只落「脏 ∩ 已加载」的桶，
  // 切 tab/关 tab/退出时对脏 hash 做立即 flush，不再只看当前可见 tab。
  const dirtyHashesRef = useRef<Set<string>>(new Set());
  // hash → filePath 映射：保存时需要路径，但脏 hash 所属 tab 可能已切换
  // 或关闭，不能依赖当前 active/secondary tab 反查。
  const filePathByHashRef = useRef<Map<string, string>>(new Map());
  const annotationsByHashRef = useRef(annotationsByHash);
  useEffect(() => {
    annotationsByHashRef.current = annotationsByHash;
  }, [annotationsByHash]);

  const setAnnotationsByHash = useCallback(
    (value: React.SetStateAction<Record<string, Annotation[]>>) => {
      setAnnotationsByHashState((prev) => {
        const next = typeof value === "function" ? value(prev) : value;
        if (next === prev) return prev;
        // 在 updater 内标脏：StrictMode 会重复调用 updater，但 Set.add 幂等，
        // 不会引入脏标记误判。
        for (const hash of Object.keys(next)) {
          if (next[hash] !== prev[hash]) dirtyHashesRef.current.add(hash);
        }
        return next;
      });
    },
    []
  );
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
    [setAnnotationsByHash]
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
  // 流式合批尚未触发的 flush 定时器集合，组件卸载时统一清理。
  const streamFlushTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(
    new Set()
  );
  // Allow handleInterruptSession to stop the agent loop even between LLM rounds
  // (e.g. while tool calls are being executed). Each active session registers an
  // abort callback that is checked before starting a new round or running a tool.
  const agentLoopAbortRef = useRef<Map<string, () => void>>(new Map());

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

  // 同步可见 tab 的 hash → filePath 映射（映射不随关 tab 清除，供后续 flush）。
  useEffect(() => {
    if (activeTab?.fileHash && activeTab.filePath) {
      filePathByHashRef.current.set(activeTab.fileHash, activeTab.filePath);
    }
    if (isSplitView && secondaryTab?.fileHash && secondaryTab.filePath) {
      filePathByHashRef.current.set(
        secondaryTab.fileHash,
        secondaryTab.filePath
      );
    }
  }, [
    activeTab?.fileHash,
    activeTab?.filePath,
    isSplitView,
    secondaryTab?.fileHash,
    secondaryTab?.filePath,
  ]);

  const visibleTabStashes = useMemo(
    () => stashes.filter((s) => visibleTabIds.has(s.source.tabId)),
    [stashes, visibleTabIds]
  );

  const visibleTabSessions = useMemo(
    () => sessions.filter((s) => sessionBelongsToHashes(s, visibleFileHashes)),
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
      sessions.filter((s) => {
        if (!focusedTab?.fileHash) return false;
        return sessionBelongsToHashes(s, new Set([focusedTab.fileHash]));
      }),
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
  // 注意只在桶「不存在」时移除：成功加载空文件、或用户删光该文件全部批注后
  // 桶为空数组但仍属已加载，若此时摘掉 loaded 标记，后续保存会被 loaded
  // 门槛拦截，删除操作永远无法落盘。
  useEffect(() => {
    for (const hash of loadedFileHashesRef.current) {
      if (!(hash in annotationsByHash)) {
        loadedFileHashesRef.current.delete(hash);
      }
    }
  }, [annotationsByHash]);

  // 把「脏 ∩ 已成功加载」的 hash 落盘；onlyHashes 用于定向 flush（如切 tab）。
  // 加载失败的 hash 不在 loadedFileHashes 中，永远不会被保存——这是防止
  // 「加载失败 → 空数据覆盖写回」的关键门槛。
  const persistDirtyHashes = useCallback(
    async (onlyHashes?: ReadonlySet<string>) => {
      const shouldSaveAnnotation = (a: Annotation) =>
        (a.type !== "stash" || a.interpretedGroupSize !== undefined) &&
        a.fileHash;

      for (const fileHash of Array.from(dirtyHashesRef.current)) {
        if (onlyHashes && !onlyHashes.has(fileHash)) continue;
        if (!loadedFileHashesRef.current.has(fileHash)) continue;
        const filePath = filePathByHashRef.current.get(fileHash);
        if (!filePath) continue;

        const fileAnnotations = annotationsByHashRef.current[fileHash] || [];
        const fileSessionIds = sessionsRef.current
          .filter((s) => sessionBelongsToHashes(s, new Set([fileHash])))
          .map((s) => s.id);

        try {
          await savePdfData(filePath, {
            annotations: fileAnnotations.filter(shouldSaveAnnotation),
            sessionIds: fileSessionIds,
          });
          // 保存成功才清脏标记；失败保留，下次防抖/flush 时重试。
          dirtyHashesRef.current.delete(fileHash);
          info(
            `savePdfData succeeded: fileHash=${fileHash} annotations=${fileAnnotations.length} sessions=${fileSessionIds.length}`
          );
        } catch (err) {
          error(`savePdfData failed: ${err}`);
        }
      }
    },
    []
  );

  const persistChangedSessions = useCallback(async () => {
    // Save all sessions that have changed since last save.
    // Note: we intentionally do NOT delete sessions from disk when they
    // disappear from state — sessions removed due to tab close should
    // persist on disk so they can be restored when the PDF is reopened.
    let savedSessionCount = 0;
    for (const session of sessionsRef.current) {
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
  }, []);

  // 退出前立即落盘：清掉两个防抖定时器，同步保存所有脏 hash 与变更会话。
  const flushPendingSaves = useCallback(async () => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    if (sessionSaveTimeoutRef.current) {
      clearTimeout(sessionSaveTimeoutRef.current);
      sessionSaveTimeoutRef.current = null;
    }
    await persistDirtyHashes();
    await persistChangedSessions();
  }, [persistDirtyHashes, persistChangedSessions]);

  // Load annotations and sessions when active file changes.
  // Skip if the current fileHash has already been loaded successfully.
  useEffect(() => {
    if (!activeTab?.filePath || !activeTab.fileHash) return;
    const fileHash = activeTab.fileHash;
    if (loadedFileHashesRef.current.has(fileHash)) return;

    let cancelled = false;
    loadPdfData(activeTab.filePath)
      .then(async (data) => {
        if (cancelled) return;
        // Mark as loaded before merging so concurrent StrictMode runs see it.
        loadedFileHashesRef.current.add(fileHash);
        // Replace the bucket for this fileHash. Backfill fileHash for legacy data.
        // 用原始 setter：从磁盘加载不算用户改动，不应标脏触发回写。
        setAnnotationsByHashState((prev) => {
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
      })
      .catch((err) => {
        // 加载失败：不标记 loaded、不 setState 写空桶，否则后续防抖保存
        // 会把空数据覆盖写回磁盘，静默清空该 PDF 的已有批注。
        warn(
          `Load PDF data failed, skip persistence for fileHash=${fileHash}: ${err}`
        );
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
    loadPdfData(secondaryTab.filePath)
      .then(async (data) => {
        if (cancelled) return;
        loadedFileHashesRef.current.add(fileHash);
        setAnnotationsByHashState((prev) => {
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
      })
      .catch((err) => {
        // 同主屏加载失败处理：不标记 loaded、不写空桶，防止空数据覆盖磁盘。
        warn(
          `Load secondary PDF data failed, skip persistence for fileHash=${fileHash}: ${err}`
        );
      });
    return () => {
      cancelled = true;
    };
  }, [isSplitView, secondaryTab?.filePath, secondaryTab?.fileHash]);

  // Persist PDF data with debounce (annotations + session references).
  // 保存目标为「脏 ∩ 已加载」的 hash，而非仅当前可见 tab——否则切 tab/关 tab
  // 时 cleanup 清掉未触发的定时器，旧 tab 在 500ms 窗口内的改动会丢失。
  useEffect(() => {
    if (!activeTab?.filePath || !activeTab.fileHash) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null;
      void persistDirtyHashes();
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
    persistDirtyHashes,
  ]);

  // 切 tab / 关 tab：离开可见集合的 hash 若有脏数据，立即 flush 不等防抖。
  // （不能在防抖 effect 的 cleanup 里 flush——cleanup 在每次批注变更时也触发，
  // 会把 500ms 防抖退化成每次按键都落盘。）
  const prevVisibleHashesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const previous = prevVisibleHashesRef.current;
    prevVisibleHashesRef.current = new Set(visibleFileHashes);
    const removed = [...previous].filter((h) => !visibleFileHashes.has(h));
    if (removed.length > 0) {
      void persistDirtyHashes(new Set(removed));
    }
  }, [visibleFileHashes, persistDirtyHashes]);

  // Persist modified sessions with debounce, and delete sessions that have been
  // removed from memory so that disk does not retain stale session files.
  useEffect(() => {
    if (sessionSaveTimeoutRef.current)
      clearTimeout(sessionSaveTimeoutRef.current);
    sessionSaveTimeoutRef.current = setTimeout(() => {
      sessionSaveTimeoutRef.current = null;
      void persistChangedSessions();
    }, 500);
    return () => {
      if (sessionSaveTimeoutRef.current)
        clearTimeout(sessionSaveTimeoutRef.current);
    };
  }, [sessions, persistChangedSessions]);

  // Abort any running streams when the hook unmounts (e.g. app close).
  useEffect(() => {
    const pendingFlushTimers = streamFlushTimersRef.current;
    return () => {
      // 清掉未触发的合批 flush 定时器，避免卸载后 setState。
      pendingFlushTimers.forEach((timer) => clearTimeout(timer));
      pendingFlushTimers.clear();
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

  /** Build a human-readable summary of a tool call for UI status lines. */
  const toolSummary = useCallback((name: string, argsJson: string): string => {
    try {
      const args = JSON.parse(argsJson);
      if (name === "read_pdf_page") {
        return i18n.t("tools.callReadPage", { page: args.page_number ?? "?" });
      }
      if (name === "search_in_pdf") {
        return i18n.t("tools.callSearch", { query: args.query ?? "?" });
      }
      if (name === "list_open_pdfs") {
        return i18n.t("tools.callList");
      }
      if (name === "screenshot_pdf_page") {
        return i18n.t("tools.callScreenshot", {
          page: args.page_number ?? "?",
        });
      }
    } catch {
      // fall through
    }
    return name;
  }, []);

  const runSessionStream = useCallback(
    (session: InterpretationSession, messageId: string) => {
      const sessionRef = { current: session };
      let loopAborted = false;
      agentLoopAbortRef.current.set(session.id, () => {
        loopAborted = true;
      });
      const currentSettings = settingsRef.current;
      const preset = PLATFORM_PRESETS[currentSettings.platformId];
      const toolsEnabled =
        currentSettings.agentToolsEnabled &&
        (preset?.supportsTools ?? false) &&
        (sessionRef.current.action === "explain" ||
          sessionRef.current.action === "custom");
      // 视觉门控：仅当前模型标记为视觉模型时，后端才会注入页面截图工具
      const visionEnabled =
        toolsEnabled &&
        modelSupportsVision(
          currentSettings.platformId,
          currentSettings.llm.model
        );
      const maxRounds =
        currentSettings.maxToolRounds > 0 ? currentSettings.maxToolRounds : 5;
      const toolSession: ToolSession | null = toolsEnabled
        ? beginToolSession()
        : null;

      // 无选区自由提问（空 sources 的 custom 会话）：没有片段可供「基于片段回答」，
      // 沿用 explain 模板会让模型以为用户忘了贴文本而拒答；改用专用 prompt——
      // tools 开启时明确引导模型主动用 list_open_pdfs / search_in_pdf 查证当前文档，
      // tools 关闭时则声明无法访问文档、需要原文才能作答的问题引导用户开启工具或选中文本。
      const isFreeQuestion =
        sessionRef.current.action === "custom" &&
        sessionRef.current.sources.length === 0;

      const buildSystemContent = () => {
        if (isFreeQuestion) {
          return i18n.t(
            toolsEnabled ? "llm.askWithToolsPrompt" : "llm.askNoToolsPrompt",
            { targetLanguage: currentSettings.targetLanguage }
          );
        }
        const base = buildSystemPrompt(
          sessionRef.current.action ?? "explain",
          currentSettings.targetLanguage,
          currentSettings.systemPrompts
        );
        if (!toolsEnabled) return base;
        return `${base}\n\n${i18n.t("llm.toolsSystemAddendum")}`;
      };

      /**
       * 截图图片的合成 user 消息：图片只能出现在 user 消息的 content parts
       * （各平台视觉 API 的共同约束，assistant/tool 消息带图会被 400 拒绝）。
       * 该消息不落盘，每次由 tool 消息上的 images 引用重建。
       */
      const buildImageUserMessage = (
        ref: SessionImageRef,
        base64: string
      ): ChatMessage => ({
        role: "user",
        content: [
          {
            type: "text",
            text: i18n.t("llm.toolImageContext", { page: ref.page }),
          },
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${base64}` },
          },
        ],
      });

      /**
       * 同步构建 API 消息；带截图引用的 tool 消息把图片位置记录到
       * imageSpots，由 replaySessionImages 异步读盘补齐。拆分同步/异步是为
       * 了无截图的会话保持 loop 同步启动（已有测试依赖该时序）。
       */
      const buildApiMessages = (): {
        messages: ChatMessage[];
        imageSpots: { afterIndex: number; ref: SessionImageRef }[];
      } => {
        const sourceMessages = sessionRef.current.messages.filter(
          (m) => !(m.role === "assistant" && m.id === messageId)
        );
        // 防御：中止曾可能留下没有 tool 响应消息的 assistant.toolCalls
        // （历史脏数据），原样回放会被 OpenAI 兼容 API 的消息序列校验直接
        // 400 拒绝，且该会话此后所有追问都失败。为缺失响应的 toolCall 在
        // assistant 消息之后补一条占位 tool 消息，让会话可以自愈继续追问。
        const answeredCallIds = new Set(
          sessionRef.current.messages
            .filter((m) => m.role === "tool" && m.toolCallId)
            .map((m) => m.toolCallId as string)
        );
        const repaired: ChatMessage[] = [];
        const imageSpots: { afterIndex: number; ref: SessionImageRef }[] = [];
        for (const m of sourceMessages) {
          repaired.push({
            role: m.role,
            content: m.content,
            toolCallId: m.toolCallId,
            toolCalls: m.toolCalls,
            reasoningContent: m.reasoningContent,
          } as ChatMessage);
          if (m.role === "assistant" && m.toolCalls) {
            for (const call of m.toolCalls) {
              if (!answeredCallIds.has(call.id)) {
                repaired.push({
                  role: "tool",
                  content: i18n.t("llm.toolCallCancelled"),
                  toolCallId: call.id,
                });
              }
            }
          }
          if (m.role === "tool" && m.images?.length) {
            for (const ref of m.images) {
              imageSpots.push({ afterIndex: repaired.length - 1, ref });
            }
          }
        }
        return {
          messages: [
            { role: "system", content: buildSystemContent() },
            ...repaired,
          ],
          // afterIndex 相对 repaired；加上 system 消息的偏移 1
          imageSpots: imageSpots.map((s) => ({
            afterIndex: s.afterIndex + 1,
            ref: s.ref,
          })),
        };
      };

      /** 把 imageSpots 记录的截图从磁盘读回，重建合成 user 图片消息。 */
      const replaySessionImages = async (
        base: ChatMessage[],
        imageSpots: { afterIndex: number; ref: SessionImageRef }[]
      ): Promise<ChatMessage[]> => {
        // 插入点必须落在该 tool 消息所属批次的末尾（同一 assistant 的
        // toolCalls 的全部 tool 响应之后）：DeepSeek 等平台校验 tool 消息
        // 必须紧跟 assistant(toolCalls)，中间夹 user 图片消息会 400。
        const insertions: { index: number; ref: SessionImageRef }[] = [];
        for (const spot of imageSpots) {
          let end = spot.afterIndex;
          while (end + 1 < base.length && base[end + 1].role === "tool") end++;
          insertions.push({ index: end + 1, ref: spot.ref });
        }
        const result = [...base];
        let inserted = 0;
        for (const ins of insertions) {
          const bytes = await readSessionImage(
            sessionRef.current.id,
            ins.ref.file
          );
          // 文件缺失时跳过图片只留文本，不阻塞追问。
          if (!bytes) continue;
          result.splice(
            ins.index + inserted,
            0,
            buildImageUserMessage(ins.ref, bytesToBase64(bytes))
          );
          inserted++;
        }
        return result;
      };

      const buildFinalNoToolsMessages = (
        sourceMessages: ChatMessage[]
      ): ChatMessage[] => {
        const finalMessages: ChatMessage[] = [];

        for (const message of sourceMessages) {
          if (message.role === "tool") {
            finalMessages.push({
              role: "user",
              content: i18n.t("llm.toolResultContext", {
                content: message.content,
              }),
            });
            continue;
          }

          if (message.toolCalls && message.toolCalls.length > 0) {
            const assistantContent =
              typeof message.content === "string" ? message.content.trim() : "";
            if (assistantContent) {
              finalMessages.push({
                role: "assistant",
                content: assistantContent,
              });
            }
            continue;
          }

          finalMessages.push({
            role: message.role,
            content: message.content,
          });
        }

        finalMessages.push({
          role: "system",
          content: i18n.t("llm.toolLimitFinalInstruction", { maxRounds }),
        });

        return finalMessages;
      };

      const runOneRound = async (
        round: number,
        messages: ChatMessage[],
        enableTools: boolean
      ): Promise<{
        content: string;
        reasoning: string;
        toolCalls: ToolCall[];
        usage?: TokenUsage;
        aborted: boolean;
        hadError: boolean;
      }> => {
        return new Promise((resolve) => {
          const key = `${messageId}-${round}`;
          let content = "";
          let reasoning = "";
          let usage: TokenUsage | undefined;
          const toolCalls: ToolCall[] = [];
          const toolEventsMap = new Map<string, ToolEvent>();

          const updateMessageInState = (
            updater: (
              m: InterpretationMessage
            ) => InterpretationMessage | undefined
          ) => {
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionRef.current.id) return s;
                const nextMessages = s.messages.map((m) =>
                  m.id === messageId ? (updater(m) ?? m) : m
                );
                const updated: InterpretationSession = {
                  ...s,
                  messages: nextMessages,
                };
                sessionRef.current = updated;
                return updated;
              })
            );
          };

          // 流式合批：content / reasoning 先累积在闭包变量里，50ms 定时
          // flush 一次到 state；流结束 / 出错 / 中止前强制 flush 最后一次，
          // 保证最终内容完整。toolEvents 更新频率低，不走合批。
          let flushTimer: ReturnType<typeof setTimeout> | null = null;
          let chunkDirty = false;

          const flushAccumulatedChunks = () => {
            if (flushTimer) {
              clearTimeout(flushTimer);
              streamFlushTimersRef.current.delete(flushTimer);
              flushTimer = null;
            }
            if (!chunkDirty) return;
            chunkDirty = false;
            const nextContent = content;
            const nextReasoning = reasoning;
            updateMessageInState((m) => ({
              ...m,
              content: nextContent,
              // 本轮没有 reasoning chunk 时保持原值，不用空串覆盖。
              ...(nextReasoning ? { reasoningContent: nextReasoning } : {}),
            }));
          };

          const scheduleChunkFlush = () => {
            chunkDirty = true;
            if (flushTimer) return;
            flushTimer = setTimeout(() => {
              if (flushTimer) streamFlushTimersRef.current.delete(flushTimer);
              flushTimer = null;
              flushAccumulatedChunks();
            }, STREAM_FLUSH_INTERVAL);
            streamFlushTimersRef.current.add(flushTimer);
          };

          streaming.run(
            key,
            messages,
            {
              onChunk: (_chunk, accumulated) => {
                content = accumulated;
                scheduleChunkFlush();
              },
              onReasoningChunk: (_chunk, accumulated) => {
                reasoning = accumulated;
                scheduleChunkFlush();
              },
              onToolCall: (name, args, callId) => {
                toolCalls.push({
                  id: callId,
                  type: "function",
                  function: { name, arguments: args },
                });
                toolEventsMap.set(callId, {
                  name,
                  summary: toolSummary(name, args),
                  status: "running",
                });
                updateMessageInState((m) => ({
                  ...m,
                  toolEvents: Array.from(toolEventsMap.values()),
                }));
              },
              onUsage: (u) => {
                usage = u;
              },
              onError: (message, error) => {
                // 强制 flush，保证已到达但未落状态的 chunk 不丢失。
                flushAccumulatedChunks();
                // content 保存本轮最新累积（含刚 flush 的部分）；sessionRef
                // 要等 React 处理完才更新，这里优先用本地变量。
                const currentContent =
                  content ||
                  sessionRef.current.messages.find((m) => m.id === messageId)
                    ?.content ||
                  "";
                const accumulated = `${currentContent}\n\n${i18n.t(
                  "common.errorPrefix"
                )} ${message}`;
                updateMessageInState((m) => ({
                  ...m,
                  content: accumulated,
                  error,
                }));
                resolve({
                  content,
                  reasoning,
                  toolCalls,
                  usage,
                  aborted: false,
                  hadError: true,
                });
              },
              onDone: () => {
                // 流正常结束：强制 flush 最后一次，再交回 agent loop 收尾。
                flushAccumulatedChunks();
                resolve({
                  content,
                  reasoning,
                  toolCalls,
                  usage,
                  aborted: false,
                  hadError: false,
                });
              },
              onAbort: () => {
                // 中止同样强制 flush，保留中止前已收到的内容。
                flushAccumulatedChunks();
                resolve({
                  content,
                  reasoning,
                  toolCalls,
                  usage,
                  aborted: true,
                  hadError: false,
                });
              },
            },
            {
              thinking: currentSettings.thinking,
              enableTools,
              enableVision: visionEnabled,
              authorizedFileHashes: getOpenFileHashes(),
            }
          );
        });
      };

      const appendAssistantToolMessage = (
        content: string,
        reasoning: string,
        toolCalls: ToolCall[],
        toolEvents: ToolEvent[]
      ) => {
        const assistantMsg: InterpretationMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content,
          createdAt: Date.now(),
          reasoningContent: reasoning || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          toolEvents: toolEvents.length > 0 ? toolEvents : undefined,
        };
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== sessionRef.current.id) return s;
            // Insert before the streaming placeholder message so the final
            // assistant message stays last.
            const index = s.messages.findIndex((m) => m.id === messageId);
            const messages = [...s.messages];
            if (index !== -1) {
              messages.splice(index, 0, assistantMsg);
            } else {
              messages.push(assistantMsg);
            }
            // 将 toolEvents 固化到新消息后，清空 streaming placeholder 上的
            // 临时 running 状态，避免下一轮无新工具时仍显示旧 spinner。
            const nextMessages = messages.map((m) =>
              m.id === messageId ? { ...m, toolEvents: undefined } : m
            );
            const updated = { ...s, messages: nextMessages };
            sessionRef.current = updated;
            return updated;
          })
        );
        return assistantMsg;
      };

      const appendToolResultMessage = (
        toolCallId: string,
        name: string,
        result: string,
        images?: SessionImageRef[]
      ) => {
        const toolMsg: InterpretationMessage = {
          id: crypto.randomUUID(),
          role: "tool",
          content: result,
          createdAt: Date.now(),
          toolCallId,
          name,
          images,
        };
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== sessionRef.current.id) return s;
            const index = s.messages.findIndex((m) => m.id === messageId);
            const messages = [...s.messages];
            if (index !== -1) {
              messages.splice(index, 0, toolMsg);
            } else {
              messages.push(toolMsg);
            }
            const updated = { ...s, messages };
            sessionRef.current = updated;
            return updated;
          })
        );
        return toolMsg;
      };

      const finishStreaming = () => {
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
      };

      // 首轮成功收尾后生成一句话摘要（fire-and-forget）：供会话列表展示。
      // 不走 agent loop、不带工具；失败仅记日志，下次成功收尾时重试。
      const maybeGenerateSummary = (finalContent: string) => {
        const current = sessionRef.current;
        if (current.summary) return;
        const firstUser = current.messages.find((m) => m.role === "user");
        const truncate = (text: string, max: number) =>
          text.length > max ? text.slice(0, max) : text;
        let acc = "";
        void streaming.run(
          `summary-${current.id}`,
          [
            {
              role: "user",
              content: i18n.t("llm.summarizePrompt", {
                targetLanguage: currentSettings.targetLanguage,
                request: truncate(firstUser?.content ?? "", 1500),
                answer: truncate(finalContent, 1500),
              }),
            },
          ],
          {
            onChunk: (_chunk, accumulated) => {
              acc = accumulated;
            },
            onDone: () => {
              const summary = acc.trim();
              if (!summary) return;
              setSessions((prev) =>
                prev.map((s) => (s.id === current.id ? { ...s, summary } : s))
              );
            },
            onError: (message) => {
              warn(`Session summary generation failed: ${message}`);
            },
          },
          // 摘要是机械任务，关闭思考模式以缩短延迟。
          { thinking: "disabled" }
        );
      };

      const runAgentLoop = async () => {
        const built = buildApiMessages();
        // 无截图引用的会话保持同步启动（不引入额外 microtask）
        let messages =
          built.imageSpots.length > 0
            ? await replaySessionImages(built.messages, built.imageSpots)
            : built.messages;
        const seenCalls = new Map<string, string>();
        let totalUsage: TokenUsage | undefined;
        try {
          for (let round = 0; round <= maxRounds; round++) {
            if (loopAborted) {
              finishStreaming();
              return;
            }
            const isLastChance = round >= maxRounds;
            const roundMessages =
              isLastChance && toolsEnabled
                ? buildFinalNoToolsMessages(messages)
                : messages;
            const { content, reasoning, toolCalls, usage, aborted, hadError } =
              await runOneRound(
                round,
                roundMessages,
                toolsEnabled && !isLastChance
              );

            if (usage) {
              if (!totalUsage) {
                totalUsage = { ...usage };
              } else {
                totalUsage.promptTokens += usage.promptTokens;
                totalUsage.completionTokens += usage.completionTokens;
                totalUsage.totalTokens += usage.totalTokens;
                if (usage.reasoningTokens !== undefined) {
                  totalUsage.reasoningTokens =
                    (totalUsage.reasoningTokens ?? 0) + usage.reasoningTokens;
                }
                if (usage.cachedTokens !== undefined) {
                  totalUsage.cachedTokens =
                    (totalUsage.cachedTokens ?? 0) + usage.cachedTokens;
                }
              }
            }

            if (aborted || hadError) {
              finishStreaming();
              return;
            }

            if (isLastChance || toolCalls.length === 0) {
              if (isLastChance && toolCalls.length > 0) {
                const finalContent =
                  content.trim() || i18n.t("llm.toolLimitReachedFallback");
                setSessions((prev) =>
                  prev.map((s) =>
                    s.id === sessionRef.current.id
                      ? {
                          ...s,
                          messages: s.messages.map((m) =>
                            m.id === messageId
                              ? {
                                  ...m,
                                  content: finalContent,
                                  toolEvents: undefined,
                                }
                              : m
                          ),
                        }
                      : s
                  )
                );
              }

              // Persist accumulated usage on the final assistant message.
              if (totalUsage) {
                setSessions((prev) =>
                  prev.map((s) =>
                    s.id === sessionRef.current.id
                      ? {
                          ...s,
                          lastPromptTokens: totalUsage!.promptTokens,
                          messages: s.messages.map((m) =>
                            m.id === messageId ? { ...m, usage: totalUsage } : m
                          ),
                        }
                      : s
                  )
                );
              }
              finishStreaming();
              maybeGenerateSummary(content);
              return;
            }

            // Build the assistant tool-calls message (persisted for replay).
            const runningEvents = toolCalls.map((call) => ({
              name: call.function.name,
              summary: toolSummary(call.function.name, call.function.arguments),
              status: "running" as const,
            }));
            const assistantMsg = appendAssistantToolMessage(
              content,
              reasoning,
              toolCalls,
              runningEvents
            );

            // Rebuild messages with the new assistant message and tool results.
            messages = [
              ...messages,
              {
                role: assistantMsg.role,
                content: assistantMsg.content,
                toolCalls: assistantMsg.toolCalls,
                reasoningContent: assistantMsg.reasoningContent,
              } as ChatMessage,
            ];

            // 同一批 toolCalls 的全部 tool 响应必须紧跟 assistant 消息
            // （DeepSeek 等平台会校验 adjacency，中间插入 user 消息直接 400）。
            // 因此合成 user 图片消息先攒在 roundImageMessages，整批 tool
            // 响应推送完毕后再统一追加。
            const roundImageMessages: ChatMessage[] = [];
            for (let i = 0; i < toolCalls.length; i++) {
              const call = toolCalls[i];
              if (loopAborted) {
                // 中止时必须为尚未执行的 toolCalls 补写占位 tool 结果消息：
                // 否则持久化的 assistant(toolCalls) 缺对应响应，追问回放会
                // 被 API 消息序列校验直接 400 拒绝，该会话此后无法追问。
                for (const pending of toolCalls.slice(i)) {
                  const cancelledMsg = appendToolResultMessage(
                    pending.id,
                    pending.function.name,
                    i18n.t("llm.toolCallCancelled")
                  );
                  messages.push({
                    role: "tool",
                    content: cancelledMsg.content,
                    toolCallId: cancelledMsg.toolCallId,
                  } as ChatMessage);
                }
                finishStreaming();
                return;
              }
              const callKey = `${call.function.name}:${call.function.arguments}`;
              let result: string;
              let imageRefs: SessionImageRef[] | undefined;
              if (seenCalls.has(callKey)) {
                // 去重命中只复用文本：图像已在历史消息里，不重复注入。
                result = seenCalls.get(callKey)!;
              } else {
                const toolResult = await toolSession!.executeToolCall(
                  call.function.name,
                  call.function.arguments
                );
                result = toolResult.result;
                seenCalls.set(callKey, result);
                // 截图图片：先落盘拿文件名引用（失败降级为纯文本结果），
                // 同时生成待发模型的合成 user 图片消息（loop 内使用，
                // 不落盘；持久化回放由 buildApiMessages 从引用重建）。
                if (toolResult.images?.length) {
                  const refs: SessionImageRef[] = [];
                  for (const image of toolResult.images) {
                    const file = await saveSessionImage(
                      sessionRef.current.id,
                      image.data
                    );
                    if (!file) continue;
                    const ref: SessionImageRef = {
                      file,
                      page: image.page,
                      region: image.region,
                    };
                    refs.push(ref);
                    roundImageMessages.push(
                      buildImageUserMessage(ref, bytesToBase64(image.data))
                    );
                  }
                  if (refs.length > 0) {
                    imageRefs = refs;
                  } else {
                    result += "\n(Failed to attach the screenshot image.)";
                  }
                }
              }

              // Mark tool event as done on the assistant message.
              setSessions((prev) =>
                prev.map((s) => {
                  if (s.id !== sessionRef.current.id) return s;
                  return {
                    ...s,
                    messages: s.messages.map((m) => {
                      if (m.id !== assistantMsg.id || !m.toolEvents) return m;
                      return {
                        ...m,
                        toolEvents: m.toolEvents.map((e) =>
                          e.name === call.function.name &&
                          e.summary ===
                            toolSummary(
                              call.function.name,
                              call.function.arguments
                            )
                            ? { ...e, status: "done" as const }
                            : e
                        ),
                      };
                    }),
                  };
                })
              );

              const toolMsg = appendToolResultMessage(
                call.id,
                call.function.name,
                result,
                imageRefs
              );
              messages.push({
                role: "tool",
                content: toolMsg.content,
                toolCallId: toolMsg.toolCallId,
              } as ChatMessage);
            }
            // 整批 tool 响应推送完毕后，再追加本批的合成 user 图片消息
            messages.push(...roundImageMessages);
          }
          // Should never reach here; maxRounds forces a final no-tools round.
          finishStreaming();
        } catch (err) {
          error(`Agent loop error: ${err}`);
          finishStreaming();
        } finally {
          agentLoopAbortRef.current.delete(session.id);
          await toolSession?.dispose();
        }
      };

      // Start the loop. Aborting the original messageId also cancels any round.
      runAgentLoop();
    },
    [streaming, toolSummary]
  );

  const startSessionFromStashes = useCallback(
    (
      prompt: string,
      sources: StashItem[],
      action: SessionAction = "explain",
      anchor?: { fileHash: string; fileName: string }
    ) => {
      const session = createSession(sources, prompt, action, anchor);
      const streamingSession = startAssistantResponse(session);
      const sessionId = streamingSession.id;
      const messageId = streamingSession.streamingMessageId!;
      setSessions((prev) => [...prev, streamingSession]);
      openRightPanel();

      // Mark each source stash annotation as interpreted, with group size and self index,
      // and link it to the session so the marker can be deleted together with the session.
      // 片段可能来自不同 PDF（分屏对照解读），按 fileHash 逐桶更新，
      // 否则第二个文件的 stash 批注不会被标记为已解读，重启后会被加载过滤器丢弃。
      // 空 sources（自由提问会话）下整段标记为 no-op，但流必须照常启动。
      const stashIds = new Set(sources.map((s) => s.id));
      const fileHashes = new Set(
        sources.map((s) => s.source.fileHash).filter(Boolean)
      );
      if (fileHashes.size > 0) {
        setAnnotationsByHash((prev) => {
          const next = { ...prev };
          for (const fileHash of fileHashes) {
            const list = next[fileHash] || [];
            next[fileHash] = list.map((a) =>
              a.type === "stash" && a.stashId && stashIds.has(a.stashId)
                ? {
                    ...a,
                    interpretedGroupSize: sources.length,
                    interpretedIndex: sources.findIndex(
                      (s) => s.id === a.stashId
                    ),
                    sessionId,
                  }
                : a
            );
          }
          return next;
        });
      }

      runSessionStream(streamingSession, messageId);

      return { sessionId, session: streamingSession };
    },
    [openRightPanel, runSessionStream, setAnnotationsByHash]
  );

  const handleAddToStash = useCallback(
    (selection: SelectionState, text: string) => {
      // 跟随焦点屏：分屏下在副屏选中文本时，暂存归属副屏 tab。
      if (!focusedTab) return;

      const stashItem = createStashItem(
        {
          tabId: focusedTab.id,
          fileName: focusedTab.fileName,
          filePath: focusedTab.filePath,
          fileHash: focusedTab.fileHash,
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
          fileHash: focusedTab.fileHash,
        }
      );
      setAnnotationsByHash((prev) => {
        const fileHash = focusedTab.fileHash;
        const list = prev[fileHash] || [];
        return { ...prev, [fileHash]: [...list, stashAnnotation] };
      });
      openRightPanel();
    },
    [focusedTab, openRightPanel, setAnnotationsByHash]
  );

  const handleAddComment = useCallback(
    (selection: SelectionState, text: string) => {
      if (!focusedTab) return;

      const commentAnnotation = createAnnotation(
        "comment",
        text,
        selection.page,
        selection.pdfX,
        selection.pdfY,
        {
          width: selection.width,
          height: selection.height,
          fileHash: focusedTab.fileHash,
        }
      );
      setAnnotationsByHash((prev) => {
        const fileHash = focusedTab.fileHash;
        const list = prev[fileHash] || [];
        return { ...prev, [fileHash]: [...list, commentAnnotation] };
      });
    },
    [focusedTab, setAnnotationsByHash]
  );

  const handleRemoveStash = useCallback(
    (id: string) => {
      setStashes((prev) => removeStash(prev, id));
      setAnnotationsByHash((prev) => {
        const next: Record<string, Annotation[]> = {};
        for (const [hash, list] of Object.entries(prev)) {
          next[hash] = list.filter((a) => a.stashId !== id);
        }
        return next;
      });
    },
    [setAnnotationsByHash]
  );

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
  }, [visibleTabIds, stashes, setAnnotationsByHash]);

  const handleCustomInterpret = useCallback(
    (prompt: string, visibleStashes: StashItem[]) => {
      if (visibleStashes.length === 0 || !focusedTab) return;
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
    [focusedTab, startSessionFromStashes, setAnnotationsByHash]
  );

  // 无选区自由提问：空 sources 的 custom 会话，经 anchorFileHash 锚定到
  // 创建时 focused tab 的文档（可见性过滤与持久化反查都认锚点）。
  // 不套 buildCustomInterpretPrompt 模板——没有片段可填，模板只会稀释问题；
  // action 复用 "custom"，Agent Tools 门控（action ∈ {explain, custom}）零改动放行。
  // 返回新会话 id 供面板直接切入 chatbox；无可锚定文档时返回 null。
  const handleFreeQuestion = useCallback(
    (prompt: string): string | null => {
      const trimmed = prompt.trim();
      if (!trimmed || !focusedTab?.fileHash) return null;
      const { sessionId } = startSessionFromStashes(trimmed, [], "custom", {
        fileHash: focusedTab.fileHash,
        fileName: focusedTab.fileName,
      });
      // 自由提问不产生批注变更，锚定 hash 不会因 setAnnotationsByHash 标脏；
      // 不主动标脏则 persistDirtyHashes 永不写回该文件的 sessionIds，
      // 会话 JSON 虽已落盘但重开 PDF 后无人引用它，等于丢失。
      // （加载失败的 hash 不在 loadedFileHashes 中，persistDirtyHashes 仍会跳过，
      // 不会引入「空数据覆盖写回」。）
      dirtyHashesRef.current.add(focusedTab.fileHash);
      return sessionId;
    },
    [focusedTab, startSessionFromStashes]
  );

  const handleSelectionAction = useCallback(
    (selection: SelectionState, action: SelectionAction, text: string) => {
      if (!focusedTab) return;

      const newAnnotation = createAnnotation(
        action,
        text,
        selection.page,
        selection.pdfX,
        selection.pdfY,
        {
          fileHash: focusedTab.fileHash,
        }
      );
      setAnnotationsByHash((prev) => {
        const fileHash = focusedTab.fileHash;
        const list = prev[fileHash] || [];
        return { ...prev, [fileHash]: [...list, newAnnotation] };
      });

      if (action === "explain") {
        const prompt = buildSelectionPrompt(
          "explain",
          text,
          settingsRef.current.targetLanguage,
          { fileName: focusedTab.fileName, page: selection.page }
        );
        const sourceStash = createStashItem(
          {
            tabId: focusedTab.id,
            fileName: focusedTab.fileName,
            filePath: focusedTab.filePath,
            fileHash: focusedTab.fileHash,
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
          const fileHash = focusedTab.fileHash;
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
    [focusedTab, startSessionFromStashes, setAnnotationsByHash]
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
      // Signal the agent loop to stop before starting the next round or tool.
      agentLoopAbortRef.current.get(sessionId)?.();
      streaming.abortPrefix(session.streamingMessageId);
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
    [setAnnotationsByHash]
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
    [annotationsByHash, setAnnotationsByHash]
  );

  // 从右侧面板按 session 删除：中止进行中的流、删除会话（含磁盘文件），
  // 并连带删除 PDF 上关联该 session 的所有标记（explain 标记与已解读暂存
  // 标记都带 sessionId），保证面板与页面两处一致。
  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return;
      const confirmed = await showConfirm(
        i18n.t("confirm.deleteTitle"),
        i18n.t("confirm.deleteSessionBody")
      );
      if (!confirmed) return;
      if (session.streamingMessageId) {
        handleInterruptSession(sessionId);
      }
      setSessions((prev) => deleteSession(prev, sessionId));
      try {
        await deleteSessionOnDisk(sessionId);
      } catch (err) {
        error(`deleteSessionOnDisk failed: ${err}`);
      }
      setAnnotationsByHash((prev) => {
        const next: Record<string, Annotation[]> = {};
        for (const [hash, list] of Object.entries(prev)) {
          next[hash] = list.filter((a) => a.sessionId !== sessionId);
        }
        return next;
      });
    },
    [sessions, handleInterruptSession, setAnnotationsByHash]
  );

  // 重新解读：沿用旧会话的来源片段与首条请求另起新会话并立即开始流式；
  // 旧会话删除（含磁盘），关联标记重新指向新会话，列表摘要沿用。
  // 流式中的会话不允许重跑（入口已禁用，这里防御）。
  const handleReinterpretSession = useCallback(
    (sessionId: string) => {
      const session = sessions.find((s) => s.id === sessionId);
      if (!session || session.isStreaming) return;
      const firstUser = session.messages.find((m) => m.role === "user");
      if (!firstUser) return;

      const { sessionId: newSessionId } = startSessionFromStashes(
        firstUser.content,
        session.sources,
        session.action ?? "explain"
      );

      setSessions((prev) => {
        const removed = deleteSession(prev, sessionId);
        if (!session.summary) return removed;
        return removed.map((s) =>
          s.id === newSessionId ? { ...s, summary: session.summary } : s
        );
      });
      void deleteSessionOnDisk(sessionId);
      setAnnotationsByHash((prev) => {
        const next: Record<string, Annotation[]> = {};
        for (const [hash, list] of Object.entries(prev)) {
          next[hash] = list.map((a) =>
            a.sessionId === sessionId ? { ...a, sessionId: newSessionId } : a
          );
        }
        return next;
      });
    },
    [sessions, startSessionFromStashes, setAnnotationsByHash]
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

  const handleUpdateStash = useCallback(
    (id: string, text: string) => {
      setStashes((prev) => updateStash(prev, id, text));
      setAnnotationsByHash((prev) => {
        const next: Record<string, Annotation[]> = {};
        for (const [hash, list] of Object.entries(prev)) {
          next[hash] = list.map((a) => (a.stashId === id ? { ...a, text } : a));
        }
        return next;
      });
    },
    [setAnnotationsByHash]
  );

  // 返回对象用 useMemo 固定引用：流式输出期间 sessions 高频变化，
  // 若每次渲染都返回新对象，App 层依赖 persistence 的回调会全部重建，
  // 击穿 PdfViewer / PdfPage 的 memo（成员本身都已是 useCallback/useMemo）。
  return useMemo(
    () => ({
      annotations,
      visibleTabAnnotations,
      annotationsByHash,
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
      handleAddComment,
      handleRemoveStash,
      handleClearStashes,
      handleCustomInterpret,
      handleFreeQuestion,
      handleSelectionAction,
      handleFollowUp,
      handleInterruptSession,
      handleSessionUpdate,
      handleAnnotationUpdate,
      handleAnnotationDelete,
      handleDeleteSession,
      handleReinterpretSession,
      handleUpdateStash,
      findSessionIdByAnnotationId,
      abortSessionsForTab,
      flushPendingSaves,
    }),
    [
      annotations,
      visibleTabAnnotations,
      annotationsByHash,
      setAnnotations,
      stashes,
      sessions,
      visibleTabStashes,
      visibleTabSessions,
      focusedTabStashes,
      focusedTabSessions,
      handleAddToStash,
      handleAddComment,
      handleRemoveStash,
      handleClearStashes,
      handleCustomInterpret,
      handleFreeQuestion,
      handleSelectionAction,
      handleFollowUp,
      handleInterruptSession,
      handleSessionUpdate,
      handleAnnotationUpdate,
      handleAnnotationDelete,
      handleDeleteSession,
      handleReinterpretSession,
      handleUpdateStash,
      findSessionIdByAnnotationId,
      abortSessionsForTab,
      flushPendingSaves,
    ]
  );
}
