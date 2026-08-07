import { useCallback, useRef, useState } from "react";

export type ToastKind = "error" | "info" | "success";

/** Clickable action a toast can carry, e.g. jump to the board item it's about. */
export interface ToastAction {
  label: string;
  itemId: string;
}

export interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
  action?: ToastAction;
}

/**
 * Transient user-facing notices (failed board operations, server errors).
 * The hook only owns the list; auto-expiry (with hover pause) lives in the
 * `Toasts` component so timers can react to pointer state.
 */
export function useToasts(): {
  toasts: Toast[];
  push: (text: string, kind?: ToastKind, action?: ToastAction) => void;
  dismiss: (id: number) => void;
} {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextIdRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Default "error": every pre-existing caller pushes failure notices.
  const push = useCallback(
    (text: string, kind: ToastKind = "error", action?: ToastAction) => {
      const id = ++nextIdRef.current;
      setToasts((prev) => [...prev, { id, text, kind, action }]);
    },
    [],
  );

  return { toasts, push, dismiss };
}
