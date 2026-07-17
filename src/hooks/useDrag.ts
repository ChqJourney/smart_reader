import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Reusable drag hook with global mouse listeners.
 *
 * Why global listeners: binding `mousemove`/`mouseup` on the dragged element
 * (or its header/body children) loses the event as soon as the cursor leaves
 * that element — the classic "popup won't drag / drag stutters" bug. This hook
 * attaches listeners to `window` on `mousedown` and removes them on `mouseup`,
 * so dragging continues smoothly even when the cursor moves outside the popup.
 *
 * Delta model: `onMove(dx, dy)` receives the incremental movement since the
 * last move (not since mousedown), so callers can apply it directly to a
 * position. Movement below `threshold` is ignored (avoids micro-jitter
 * registering as a drag and suppressing a subsequent click).
 *
 * Click suppression: callers that need to distinguish a click from a
 * drag-then-release should set a `movedRef` inside their `onMove` callback and
 * check (and clear) it in their `onClick` handler — `onMove` is only invoked
 * once the threshold is exceeded, so "onMove called" is a reliable signal.
 */
export interface UseDragOptions {
  /** Incremental drag callback, invoked once movement exceeds `threshold`. */
  onMove: (dx: number, dy: number) => void;
  /** Invoked once when the gesture ends (mouse up), regardless of threshold. */
  onEnd?: () => void;
  /** Minimum movement to start reporting deltas. Default 2px. */
  threshold?: number;
  /** Gate the gesture (e.g. disable drag for non-draggable markers). Default true. */
  enabled?: boolean;
}

export interface UseDragResult {
  isDragging: boolean;
  /** Spread onto the element that initiates the drag (e.g. a popup header). */
  handlers: { onMouseDown: (e: React.MouseEvent) => void };
}

export function useDrag({
  onMove,
  onEnd,
  threshold = 2,
  enabled = true,
}: UseDragOptions): UseDragResult {
  const [isDragging, setIsDragging] = useState(false);
  const draggingRef = useRef(false);
  const startedRef = useRef(false);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);

  // Keep the latest callbacks in refs so the window listeners (bound on
  // mousedown) always invoke the freshest closures without re-binding.
  // Synced in effects (not during render) per the React concurrent-mode rule
  // against render-phase ref writes.
  const onMoveRef = useRef(onMove);
  const onEndRef = useRef(onEnd);
  useEffect(() => {
    onMoveRef.current = onMove;
    onEndRef.current = onEnd;
  }, [onMove, onEnd]);

  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!draggingRef.current || !lastPosRef.current) return;
      const dx = e.clientX - lastPosRef.current.x;
      const dy = e.clientY - lastPosRef.current.y;
      if (!startedRef.current) {
        if (Math.hypot(dx, dy) < threshold) return;
        startedRef.current = true;
        setIsDragging(true);
      }
      lastPosRef.current = { x: e.clientX, y: e.clientY };
      onMoveRef.current(dx, dy);
    },
    [threshold]
  );

  const handleMouseUp = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    lastPosRef.current = null;
    const wasStarted = startedRef.current;
    startedRef.current = false;
    if (wasStarted) setIsDragging(false);
    window.removeEventListener("mousemove", handleMouseMove);
    window.removeEventListener("mouseup", handleMouseUp);
    onEndRef.current?.();
  }, [handleMouseMove]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!enabledRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      draggingRef.current = true;
      startedRef.current = false;
      lastPosRef.current = { x: e.clientX, y: e.clientY };
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [handleMouseMove, handleMouseUp]
  );

  // Clean up any lingering listeners if the component unmounts mid-drag.
  useEffect(() => {
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  return { isDragging, handlers: { onMouseDown: handleMouseDown } };
}
