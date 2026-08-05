import { useCallback, useRef, useState } from "react";

export interface Toast {
  id: number;
  text: string;
}

const TOAST_LIFETIME_MS = 8000;

/**
 * Transient user-facing notices (failed board operations, server errors).
 * Toasts auto-expire; `dismiss` removes one early.
 */
export function useToasts(): {
  toasts: Toast[];
  push: (text: string) => void;
  dismiss: (id: number) => void;
} {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextIdRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (text: string) => {
      const id = ++nextIdRef.current;
      setToasts((prev) => [...prev, { id, text }]);
      window.setTimeout(() => dismiss(id), TOAST_LIFETIME_MS);
    },
    [dismiss],
  );

  return { toasts, push, dismiss };
}
