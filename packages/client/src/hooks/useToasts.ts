import { useCallback, useRef, useState } from "react";

export type ToastKind = "error" | "info" | "success";

export interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
}

/**
 * Transient user-facing notices (failed board operations, server errors).
 * The hook only owns the list; auto-expiry (with hover pause) lives in the
 * `Toasts` component so timers can react to pointer state.
 */
export function useToasts(): {
  toasts: Toast[];
  push: (text: string, kind?: ToastKind) => void;
  dismiss: (id: number) => void;
} {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextIdRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Default "error": every pre-existing caller pushes failure notices.
  const push = useCallback((text: string, kind: ToastKind = "error") => {
    const id = ++nextIdRef.current;
    setToasts((prev) => [...prev, { id, text, kind }]);
  }, []);

  return { toasts, push, dismiss };
}
