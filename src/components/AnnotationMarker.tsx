import { useTranslation } from "react-i18next";
import { useRef, useState } from "react";
import { Annotation } from "../services/annotations";
import Icon from "./Icon";
import "./AnnotationMarker.css";

interface InterpretedStashIconProps {
  groupSize: number;
  index: number;
}

function InterpretedStashIcon({ groupSize, index }: InterpretedStashIconProps) {
  const points = [];
  const cx = 10;
  const cy = 10;
  const outer = 9;
  const inner = 4;
  for (let i = 0; i < groupSize * 2; i++) {
    const angle = (Math.PI / 2 + (i * Math.PI) / groupSize) * -1;
    const r = i % 2 === 0 ? outer : inner;
    points.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
  }
  const selfAngle = (Math.PI / 2 + (index * 2 * Math.PI) / groupSize) * -1;
  const hx = cx + outer * Math.cos(selfAngle);
  const hy = cy + outer * Math.sin(selfAngle);

  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      className="interpreted-stash-icon"
    >
      <polygon points={points.join(" ")} className="interpreted-stash-star" />
      <circle cx={hx} cy={hy} r="2.5" className="interpreted-stash-highlight" />
    </svg>
  );
}

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
  const { t } = useTranslation();
  const [isDragging, setIsDragging] = useState(false);
  const hasMovedRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  const left = annotation.position.x * scale;
  const top = annotation.position.y * scale;
  const isStash = annotation.type === "stash";
  const isInterpretedStash =
    isStash &&
    typeof annotation.interpretedGroupSize === "number" &&
    typeof annotation.interpretedIndex === "number";
  const isDraggable = !isStash || isInterpretedStash;
  const isClickable = annotation.type !== "stash" || isInterpretedStash;

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isDraggable) return;
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
    if (!isClickable) return;
    const shouldClick = !hasMovedRef.current;
    hasMovedRef.current = false;
    if (shouldClick) {
      e.stopPropagation();
      onClick();
    }
  };

  const className = isStash
    ? `annotation-marker stash ${highlighted ? "highlighted" : ""} ${
        isInterpretedStash ? "interpreted" : ""
      }`
    : `annotation-marker ${annotation.type} ${highlighted ? "highlighted" : ""} ${
        isDragging ? "dragging" : ""
      }`;

  const label = isStash
    ? isInterpretedStash
      ? t("marker.interpretedStash")
      : t("marker.stash")
    : annotation.type === "translate"
      ? t("marker.translate")
      : t("marker.explain");

  return (
    <div
      className={className}
      style={{ left, top }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onClick={handleClick}
      aria-label={label}
      title={label}
    >
      {isStash ? (
        isInterpretedStash ? (
          <InterpretedStashIcon
            groupSize={annotation.interpretedGroupSize!}
            index={annotation.interpretedIndex!}
          />
        ) : (
          <Icon name="stash" size={12} />
        )
      ) : (
        <Icon
          name={annotation.type === "translate" ? "translate" : "explain"}
          size={12}
        />
      )}
    </div>
  );
}
