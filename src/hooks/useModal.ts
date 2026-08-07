import { useEffect, useRef } from "react";

interface UseModalOptions {
  open: boolean;
  onClose: () => void;
  /** When false, pressing Escape does not close the modal. Defaults to true. */
  closeOnEscape?: boolean;
}

/**
 * Shared modal behavior: close on Escape (unless disabled), trap focus while
 * open, and restore focus to the previously focused element when the modal
 * closes.
 */
export function useModal({
  open,
  onClose,
  closeOnEscape = true,
}: UseModalOptions) {
  const contentRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<Element | null>(null);

  // onClose / closeOnEscape 走 ref：调用方常传内联回调（父组件每次渲染都是
  // 新引用），若作为下方 effect 的依赖，父组件任意重渲染都会让 effect 重跑——
  // cleanup 把焦点还给弹窗外元素、新 run 又把焦点抢到第一个可聚焦元素，
  // 输入过程中焦点被打断（自定义解读/打印弹窗均踩过）。effect 只应在 open
  // 切换时运行。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeOnEscapeRef = useRef(closeOnEscape);
  closeOnEscapeRef.current = closeOnEscape;

  // Close on Escape and trap Tab focus while the modal is open.
  useEffect(() => {
    if (!open) return;

    previouslyFocusedRef.current = document.activeElement;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!closeOnEscapeRef.current) return;
        e.preventDefault();
        onCloseRef.current();
        return;
      }

      if (e.key !== "Tab" || !contentRef.current) return;

      const focusable = Array.from(
        contentRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      ).filter(
        (el) =>
          !(
            el as
              | HTMLButtonElement
              | HTMLInputElement
              | HTMLSelectElement
              | HTMLTextAreaElement
          ).disabled && el.offsetParent !== null
      );

      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    const content = contentRef.current;
    const firstFocusable = content?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    firstFocusable?.focus();

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      // Restore focus only if focus is still inside the modal content.
      const prev = previouslyFocusedRef.current;
      if (
        prev instanceof HTMLElement &&
        content?.contains(document.activeElement)
      ) {
        prev.focus();
      }
    };
  }, [open]);

  return { contentRef };
}
