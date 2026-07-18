import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RecentFile, checkFilesExist } from "../services/recentFiles";
import { getBasename, getDirname, middleEllipsize } from "../utils/path";
import { formatRelativeTime } from "../utils/time";
import Icon from "./Icon";
import "./RecentFilesBar.css";

// 条目超过该数量时面板顶部出现搜索框
const SEARCH_THRESHOLD = 8;

interface RecentFilesBarProps {
  files: RecentFile[];
  /** 当前已打开为 tab 的文件路径，用于「已打开」标记 */
  openFilePaths?: string[];
  onFileClick: (file: RecentFile) => void;
  onOpenInSplit?: (file: RecentFile) => void;
  onTogglePin: (path: string) => void;
  onRemove: (path: string) => void;
  onClear: () => void;
}

export default function RecentFilesBar({
  files,
  openFilePaths,
  onFileClick,
  onOpenInSplit,
  onTogglePin,
  onRemove,
  onClear,
}: RecentFilesBarProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [focusIndex, setFocusIndex] = useState(-1);
  const [missingPaths, setMissingPaths] = useState<ReadonlySet<string>>(
    new Set()
  );
  const [clearArmed, setClearArmed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openPathSet = useMemo(
    () => new Set(openFilePaths ?? []),
    [openFilePaths]
  );

  const trimmedQuery = query.trim().toLowerCase();
  const matchesQuery = useCallback(
    (file: RecentFile) =>
      !trimmedQuery ||
      file.fileName.toLowerCase().includes(trimmedQuery) ||
      file.path.toLowerCase().includes(trimmedQuery),
    [trimmedQuery]
  );

  const pinnedFiles = files.filter((f) => f.pinned && matchesQuery(f));
  const unpinnedFiles = files.filter((f) => !f.pinned && matchesQuery(f));
  const visibleFiles = [...pinnedFiles, ...unpinnedFiles];
  // 过滤导致列表变短时焦点可能越界，渲染与回车都用钳制后的索引
  const clampedFocusIndex = Math.min(focusIndex, visibleFiles.length - 1);

  const closePanel = useCallback(() => {
    setOpen(false);
    setQuery("");
    setFocusIndex(-1);
    setClearArmed(false);
  }, []);

  const openFile = useCallback(
    (file: RecentFile, split: boolean) => {
      if (missingPaths.has(file.path)) return;
      closePanel();
      if (split) {
        onOpenInSplit?.(file);
      } else {
        onFileClick(file);
      }
    },
    [missingPaths, closePanel, onFileClick, onOpenInSplit]
  );

  // 面板打开时重置内部状态并接管焦点：有搜索框聚焦搜索框，否则聚焦面板
  // 本身让方向键立即可用。
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setFocusIndex(files.length > 0 ? 0 : -1);
    setClearArmed(false);
    if (files.length > SEARCH_THRESHOLD) {
      searchRef.current?.focus();
    } else {
      panelRef.current?.focus();
    }
    // 仅在打开动作发生时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 打开面板时校验文件是否仍存在于磁盘，失效条目置灰并禁止打开
  useEffect(() => {
    if (!open) return;
    const paths = files.map((f) => f.path);
    if (paths.length === 0) {
      setMissingPaths(new Set());
      return;
    }
    let cancelled = false;
    checkFilesExist(paths).then((exists) => {
      if (cancelled) return;
      setMissingPaths(new Set(paths.filter((_, i) => !exists[i])));
    });
    return () => {
      cancelled = true;
    };
  }, [open, files]);

  // 点击面板外部关闭
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // 全局快捷键 Ctrl/Cmd+Shift+O 开关面板
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "o"
      ) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 键盘焦点移动时保证目标行可见
  useEffect(() => {
    if (clampedFocusIndex < 0) return;
    panelRef.current
      ?.querySelector(`[data-index="${clampedFocusIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [clampedFocusIndex]);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    };
  }, []);

  const handlePanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closePanel();
      return;
    }
    if (visibleFiles.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusIndex((i) => Math.min(i + 1, visibleFiles.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      // 未用方向键选择时（如搜索框输入后直接回车）默认打开第一个结果
      const target = clampedFocusIndex >= 0 ? clampedFocusIndex : 0;
      const file = visibleFiles[target];
      if (file) {
        e.preventDefault();
        openFile(file, e.altKey);
      }
    }
  };

  const handleClearClick = () => {
    if (clearArmed) {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      setClearArmed(false);
      onClear();
      return;
    }
    setClearArmed(true);
    clearTimerRef.current = setTimeout(() => setClearArmed(false), 3000);
  };

  const renderMeta = (file: RecentFile) => {
    const parts: string[] = [];
    const dir = getDirname(file.path);
    if (dir) parts.push(middleEllipsize(dir, 34));
    const rel = formatRelativeTime(file.openedAt);
    parts.push(
      rel.kind === "date"
        ? rel.date
        : t(`recentFiles.time.${rel.kind}`, {
            count: "count" in rel ? rel.count : 0,
          })
    );
    if (file.lastPage && file.lastPage > 0) {
      parts.push(t("recentFiles.lastPage", { page: file.lastPage }));
    }
    return parts.join(" · ");
  };

  const renderRow = (file: RecentFile, index: number) => {
    const isMissing = missingPaths.has(file.path);
    const isOpen = openPathSet.has(file.path);
    return (
      <div
        key={file.path}
        role="option"
        aria-selected={index === clampedFocusIndex}
        data-index={index}
        className={`recent-file-row${index === clampedFocusIndex ? " focused" : ""}${isMissing ? " missing" : ""}`}
        title={file.path}
        onClick={() => openFile(file, false)}
        onMouseEnter={() => setFocusIndex(index)}
      >
        <Icon name="pdf" size={18} className="recent-file-icon" />
        <span className="recent-file-text">
          <span className="recent-file-name">
            {middleEllipsize(getBasename(file.path))}
          </span>
          <span className="recent-file-meta">{renderMeta(file)}</span>
        </span>
        {isMissing ? (
          <span className="recent-file-missing">
            {t("recentFiles.missing")}
          </span>
        ) : (
          <>
            {isOpen && (
              <span className="recent-file-opened">
                {t("recentFiles.opened")}
              </span>
            )}
            <span className="recent-file-actions">
              <button
                className={`icon-btn recent-file-action${file.pinned ? " pin-active" : ""}`}
                aria-label={t(
                  file.pinned ? "recentFiles.unpin" : "recentFiles.pin"
                )}
                title={t(file.pinned ? "recentFiles.unpin" : "recentFiles.pin")}
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin(file.path);
                }}
              >
                <Icon name="pin" size={13} />
              </button>
              {onOpenInSplit && (
                <button
                  className="icon-btn recent-file-action"
                  aria-label={t("recentFiles.openInSplit")}
                  title={t("recentFiles.openInSplit")}
                  onClick={(e) => {
                    e.stopPropagation();
                    openFile(file, true);
                  }}
                >
                  <Icon name="panel-right" size={13} />
                </button>
              )}
            </span>
          </>
        )}
        <button
          className="icon-btn recent-file-action recent-file-remove"
          aria-label={t("recentFiles.remove")}
          title={t("recentFiles.remove")}
          onClick={(e) => {
            e.stopPropagation();
            onRemove(file.path);
          }}
        >
          <Icon name="close" size={13} />
        </button>
      </div>
    );
  };

  return (
    <div className="recent-files" ref={rootRef}>
      <button
        data-testid="recent-files-trigger"
        className={`recent-files-trigger${open ? " open" : ""}`}
        aria-label={t("recentFiles.title")}
        title={t("recentFiles.title")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? closePanel() : setOpen(true))}
      >
        <Icon name="clock" size={15} />
        <span>{t("recentFiles.trigger")}</span>
        {files.length > 0 && (
          <span className="recent-files-count">{files.length}</span>
        )}
        <Icon name="chevron-down" size={12} />
      </button>

      {open && (
        <div
          className="recent-files-panel"
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-label={t("recentFiles.title")}
          onKeyDown={handlePanelKeyDown}
        >
          {files.length > SEARCH_THRESHOLD && (
            <div className="recent-files-search">
              <Icon name="search" size={14} />
              <input
                ref={searchRef}
                type="text"
                value={query}
                placeholder={t("recentFiles.searchPlaceholder")}
                aria-label={t("recentFiles.searchPlaceholder")}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setFocusIndex(0);
                }}
              />
            </div>
          )}

          <div className="recent-files-list" role="listbox">
            {files.length === 0 && (
              <div className="recent-files-empty">{t("recentFiles.empty")}</div>
            )}
            {files.length > 0 && visibleFiles.length === 0 && (
              <div className="recent-files-empty">
                {t("recentFiles.noMatch")}
              </div>
            )}
            {pinnedFiles.length > 0 && (
              <>
                <div className="recent-files-section">
                  {t("recentFiles.pinned")}
                </div>
                {pinnedFiles.map((f, i) => renderRow(f, i))}
              </>
            )}
            {unpinnedFiles.length > 0 && (
              <>
                {pinnedFiles.length > 0 && (
                  <div className="recent-files-section">
                    {t("recentFiles.recent")}
                  </div>
                )}
                {unpinnedFiles.map((f, i) =>
                  renderRow(f, pinnedFiles.length + i)
                )}
              </>
            )}
          </div>

          {files.length > 0 && (
            <div className="recent-files-footer">
              <button
                className={`recent-files-clear${clearArmed ? " armed" : ""}`}
                onClick={handleClearClick}
              >
                {clearArmed
                  ? t("recentFiles.clearConfirm")
                  : t("recentFiles.clear")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
