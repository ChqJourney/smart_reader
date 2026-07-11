import { useEffect, useRef } from "react";

interface UseModalOptions {
  open: boolean;
  onClose: () => void;
}

/**
 * Shared modal behavior: close on Escape, trap focus while open, and restore
 * focus to the previously focused element when the modal closes.
 */
export function useModal({ open, onClose }: UseModalOptions) {
  const contentRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<Element | null>(null);

  // Close on Escape and trap Tab focus while the modal is open.
  useEffect(() => {
    if (!open) return;

    previouslyFocusedRef.current = document.activeElement;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
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
  }, [open, onClose]);

  return { contentRef };
}
