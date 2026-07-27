import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const DIVIDER_WIDTH = 6;
const MIN_PANEL_WIDTH = 240;
const RIGHT_PANEL_MIN_WIDTH = 180;
const RIGHT_PANEL_DEFAULT_FRACTION = 3 / 8;
const LAYOUT_SAVE_DEBOUNCE_MS = 300;

export interface RightPanelLayout {
  visible: boolean;
  width: number;
}

export interface UseRightPanelLayoutReturn {
  mainRef: React.RefObject<HTMLElement>;
  leftVisible: boolean;
  rightVisible: boolean;
  rightPanelWidth: number;
  setRightPanelWidth: (width: number) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  openRightPanel: () => void;
  startResize: () => void;
  effectiveRightWidth: number;
  leftPct: number;
  rightPct: number;
}

export function useRightPanelLayout(
  initialLayout: RightPanelLayout,
  onLayoutChange: (layout: RightPanelLayout) => void
): UseRightPanelLayoutReturn {
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialLayoutRef = useRef(initialLayout);
  const rightPanelWidthRef = useRef(initialLayout.width);

  const [leftVisible, setLeftVisible] = useState(true);
  const [rightVisible, setRightVisible] = useState(initialLayout.visible);
  const [rightPanelWidth, setRightPanelWidthState] = useState<number>(
    Math.round(initialLayout.width)
  );
  rightPanelWidthRef.current = rightPanelWidth;

  // 持久化到后端的 right_panel_width 是 u32：所有宽度写入统一取整。
  // 否则窗口/拖拽产生小数宽度（如 522.75）后，save_settings 会因
  // 反序列化失败而报「保存失败」。
  const setRightPanelWidthInternal = useCallback((width: number) => {
    setRightPanelWidthState(Math.round(width));
  }, []);

  const setRightPanelWidth = useCallback(
    (width: number) => {
      setRightPanelWidthInternal(width);
    },
    [setRightPanelWidthInternal]
  );

  const mainRef = useRef<HTMLElement>(null);
  const isDraggingRef = useRef(false);

  const [availableWidth, setAvailableWidth] = useState(() =>
    Math.max(0, window.innerWidth - DIVIDER_WIDTH)
  );

  useEffect(() => {
    const updateWidth = () => {
      const width =
        mainRef.current?.getBoundingClientRect().width ?? window.innerWidth;
      setAvailableWidth(Math.max(0, width - DIVIDER_WIDTH));
    };

    updateWidth();

    const resizeObserver = new ResizeObserver(updateWidth);
    if (mainRef.current) {
      resizeObserver.observe(mainRef.current);
    }
    window.addEventListener("resize", updateWidth);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateWidth);
    };
  }, []);

  // Restore default right panel width if no persisted value exists.
  useEffect(() => {
    if (rightPanelWidth > 0) return;
    const availableWidth = Math.max(
      0,
      (mainRef.current?.getBoundingClientRect().width ?? window.innerWidth) -
        DIVIDER_WIDTH
    );
    setRightPanelWidthInternal(
      Math.max(
        availableWidth * RIGHT_PANEL_DEFAULT_FRACTION,
        RIGHT_PANEL_MIN_WIDTH
      )
    );
  }, [rightPanelWidth, setRightPanelWidthInternal]);

  // Sync external layout values when they change (e.g. settings loaded from
  // the backend). Only apply real changes to avoid resetting user interaction.
  useEffect(() => {
    if (
      initialLayoutRef.current.visible === initialLayout.visible &&
      initialLayoutRef.current.width === initialLayout.width
    ) {
      return;
    }
    initialLayoutRef.current = initialLayout;
    setRightVisible(initialLayout.visible);
    if (initialLayout.width > 0) {
      setRightPanelWidthInternal(initialLayout.width);
    }
  }, [initialLayout, setRightPanelWidthInternal]);

  // Notify the caller of visibility changes immediately. Only save when a
  // real width has been resolved; width 0 means "use default" and should not
  // be persisted yet. We read width from a ref so width changes do not double
  // fire the callback (they are handled by the debounced effect below).
  useEffect(() => {
    if (rightPanelWidthRef.current <= 0) return;
    onLayoutChange({
      visible: rightVisible,
      width: rightPanelWidthRef.current,
    });
  }, [rightVisible, onLayoutChange]);

  // Debounce width changes so dragging does not hammer the backend.
  useEffect(() => {
    if (rightPanelWidth <= 0) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      onLayoutChange({ visible: rightVisible, width: rightPanelWidth });
    }, LAYOUT_SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [rightPanelWidth, rightVisible, onLayoutChange]);

  // Global mouse events for panel resizing.
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !mainRef.current) return;

      const rect = mainRef.current.getBoundingClientRect();
      const availableWidth = rect.width - DIVIDER_WIDTH;
      const x = e.clientX - rect.left;
      const newLeftPx = Math.max(
        MIN_PANEL_WIDTH,
        Math.min(availableWidth - RIGHT_PANEL_MIN_WIDTH, x)
      );
      const newRightPx = Math.max(
        RIGHT_PANEL_MIN_WIDTH,
        availableWidth - newLeftPx
      );
      setRightPanelWidthInternal(newRightPx);
    };

    const handleMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [setRightPanelWidthInternal]);

  const startResize = useCallback(() => {
    if (!mainRef.current) return;
    isDraggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const toggleLeft = useCallback(() => setLeftVisible((v) => !v), []);
  const toggleRight = useCallback(() => setRightVisible((v) => !v), []);
  const openRightPanel = useCallback(() => setRightVisible(true), []);

  const effectiveRightWidth =
    rightPanelWidth > 0
      ? Math.max(
          RIGHT_PANEL_MIN_WIDTH,
          Math.min(
            Math.max(RIGHT_PANEL_MIN_WIDTH, availableWidth - MIN_PANEL_WIDTH),
            rightPanelWidth
          )
        )
      : Math.max(
          availableWidth * RIGHT_PANEL_DEFAULT_FRACTION,
          RIGHT_PANEL_MIN_WIDTH
        );
  const leftPct =
    availableWidth > 0
      ? ((availableWidth - effectiveRightWidth) / availableWidth) * 100
      : 100 - RIGHT_PANEL_DEFAULT_FRACTION * 100;
  const rightPct =
    availableWidth > 0
      ? (effectiveRightWidth / availableWidth) * 100
      : RIGHT_PANEL_DEFAULT_FRACTION * 100;

  // 返回对象用 useMemo 固定引用，避免 App 层依赖它的回调每次渲染重建。
  return useMemo(
    () => ({
      mainRef,
      leftVisible,
      rightVisible,
      rightPanelWidth,
      setRightPanelWidth,
      toggleLeft,
      toggleRight,
      openRightPanel,
      startResize,
      effectiveRightWidth,
      leftPct,
      rightPct,
    }),
    [
      leftVisible,
      rightVisible,
      rightPanelWidth,
      setRightPanelWidth,
      toggleLeft,
      toggleRight,
      openRightPanel,
      startResize,
      effectiveRightWidth,
      leftPct,
      rightPct,
    ]
  );
}
