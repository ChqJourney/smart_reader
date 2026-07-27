import { useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import "./IconSelect.css";

export interface IconSelectOption {
  value: string;
  label: string;
  /** 为 true 时在选项最左侧显示绿色圆点（如平台已配置 API Key） */
  configured?: boolean;
}

interface IconSelectProps {
  value: string;
  options: IconSelectOption[];
  onChange: (value: string) => void;
  /** 绿点的悬停提示文案（如“已配置”） */
  configuredTitle?: string;
}

/**
 * 自定义下拉选择器：替代原生 select，以便在选项内展示图标——
 * 已配置项最左侧绿色圆点，当前选中项最右侧绿色对勾。
 */
export default function IconSelect({
  value,
  options,
  onChange,
  configuredTitle,
}: IconSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 打开后：点击外部关闭；Escape 在组件 onKeyDown 中处理并 stopPropagation，
  // 避免冒泡到 useModal 的 document 监听把整个设置弹窗一起关掉。
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div
      ref={rootRef}
      className={`icon-select${open ? " open" : ""}`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="icon-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {current?.configured && (
          <span className="icon-select-dot" title={configuredTitle} />
        )}
        <span className="icon-select-value">{current?.label ?? value}</span>
        <Icon name="chevron-down" size={14} />
      </button>
      {open && (
        <div className="icon-select-list" role="listbox">
          {options.map((o) => (
            <button
              type="button"
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`icon-select-option${
                o.value === value ? " selected" : ""
              }`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span className="icon-select-dot-slot">
                {o.configured && (
                  <span className="icon-select-dot" title={configuredTitle} />
                )}
              </span>
              <span className="icon-select-option-label">{o.label}</span>
              {o.value === value && (
                <svg
                  className="icon-select-check"
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden
                >
                  <path
                    d="M3 8.5l3 3 7-7"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
