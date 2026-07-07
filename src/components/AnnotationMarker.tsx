import { useRef, useState } from "react";
import { Annotation } from "../services/annotations";
import Icon from "./Icon";

interface AnnotationMarkerProps {
  annotation: Annotation;
  scale: number;
  highlighted?: boolean;
  onClick: () => void;
  onMove: (deltaX: number, deltaY: number) => void;
}

export default function AnnotationMarker({
  annotation,
  scale,
  highlighted,
  onClick,
  onMove,
}: AnnotationMarkerProps) {
  const [isDragging, setIsDragging] = useState(false);
  const hasMovedRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  const left = annotation.position.x * scale;
  const top = annotation.position.y * scale;

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setIsDragging(true);
    hasMovedRef.current = false;
    dragStartRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !dragStartRef.current) return;
    e.preventDefault();

    const start = dragStartRef.current;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;

    if (Math.hypot(dx, dy) > 2) {
      hasMovedRef.current = true;
    }

    dragStartRef.current = { x: e.clientX, y: e.clientY };
    onMove(dx, dy);
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (!isDragging) return;
    e.preventDefault();
    setIsDragging(false);
    dragStartRef.current = null;
  };

  const handleClick = (e: React.MouseEvent) => {
    const shouldClick = !hasMovedRef.current;
    hasMovedRef.current = false;
    if (shouldClick) {
      e.stopPropagation();
      onClick();
    }
  };

  const iconName = annotation.type === "translate" ? "translate" : "explain";

  return (
    <div
      className={`annotation-marker ${annotation.type} ${highlighted ? "highlighted" : ""} ${
        isDragging ? "dragging" : ""
      }`}
      style={{ left, top }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onClick={handleClick}
      aria-label={annotation.type === "translate" ? "翻译" : "解读"}
      title={annotation.type === "translate" ? "翻译" : "解读"}
    >
      <Icon name={iconName} size={12} />
    </div>
  );
}
