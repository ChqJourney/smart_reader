import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const DIVIDER_WIDTH = 6;
const MIN_PANEL_WIDTH = 240;
const RIGHT_PANEL_MIN_WIDTH = 180;
const RIGHT_PANEL_DEFAULT_FRACTION = 3 / 8;
const RIGHT_PANEL_LAYOUT_KEY = "pdfAgent.rightPanelLayout";

function loadRightPanelLayout(): { visible: boolean; width: number } {
  try {
    const raw = localStorage.getItem(RIGHT_PANEL_LAYOUT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        visible: typeof parsed.visible === "boolean" ? parsed.visible : true,
        width: typeof parsed.width === "number" ? parsed.width : 0,
      };
    }
  } catch {
    // ignore
  }
  return { visible: true, width: 0 };
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

export function useRightPanelLayout(): UseRightPanelLayoutReturn {
  const rightPanelLayout = useMemo(() => loadRightPanelLayout(), []);
  const [leftVisible, setLeftVisible] = useState(true);
  const [rightVisible, setRightVisible] = useState(rightPanelLayout.visible);
  const [rightPanelWidth, setRightPanelWidthInternal] = useState<number>(rightPanelLayout.width);

  const setRightPanelWidth = useCallback((width: number) => {
    setRightPanelWidthInternal(width);
  }, []);

  const mainRef = useRef<HTMLElement>(null);
  const isDraggingRef = useRef(false);

  // Restore default right panel width if no persisted value exists
  useEffect(() => {
    if (rightPanelWidth > 0) return;
    const availableWidth = Math.max(
      0,
      (mainRef.current?.getBoundingClientRect().width ?? window.innerWidth) - DIVIDER_WIDTH
    );
    setRightPanelWidthInternal(Math.max(availableWidth * RIGHT_PANEL_DEFAULT_FRACTION, RIGHT_PANEL_MIN_WIDTH));
  }, [rightPanelWidth]);

  // Persist right panel width and visibility
  useEffect(() => {
    if (rightPanelWidth <= 0) return;
    try {
      localStorage.setItem(
        RIGHT_PANEL_LAYOUT_KEY,
        JSON.stringify({ visible: rightVisible, width: rightPanelWidth })
      );
    } catch {
      // ignore
    }
  }, [rightVisible, rightPanelWidth]);

  // Global mouse events for panel resizing
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
      const newRightPx = Math.max(RIGHT_PANEL_MIN_WIDTH, availableWidth - newLeftPx);
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
  }, []);

  const startResize = useCallback(() => {
    if (!mainRef.current) return;
    isDraggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const toggleLeft = useCallback(() => setLeftVisible((v) => !v), []);
  const toggleRight = useCallback(() => setRightVisible((v) => !v), []);
  const openRightPanel = useCallback(() => setRightVisible(true), []);

  const availableWidth = Math.max(
    0,
    (mainRef.current?.getBoundingClientRect().width ?? window.innerWidth) - DIVIDER_WIDTH
  );
  const effectiveRightWidth =
    rightPanelWidth > 0
      ? Math.max(
          RIGHT_PANEL_MIN_WIDTH,
          Math.min(
            Math.max(RIGHT_PANEL_MIN_WIDTH, availableWidth - MIN_PANEL_WIDTH),
            rightPanelWidth
          )
        )
      : Math.max(availableWidth * RIGHT_PANEL_DEFAULT_FRACTION, RIGHT_PANEL_MIN_WIDTH);
  const leftPct = availableWidth > 0 ? ((availableWidth - effectiveRightWidth) / availableWidth) * 100 : 100 - RIGHT_PANEL_DEFAULT_FRACTION * 100;
  const rightPct = availableWidth > 0 ? (effectiveRightWidth / availableWidth) * 100 : RIGHT_PANEL_DEFAULT_FRACTION * 100;

  return {
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
  };
}
