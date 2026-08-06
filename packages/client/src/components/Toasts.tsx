import { useEffect, useRef, useState } from "react";
import type { Toast, ToastKind } from "../hooks/useToasts";

const LIFETIME_MS = 8000;
/** Fresh (shorter) countdown armed when the pointer leaves a hovered toast. */
const RESUME_MS = 2500;
/** Removes a closing toast even if animationend never fires (reduced motion, jsdom). */
const CLOSE_FALLBACK_MS = 300;

const KIND_STYLE: Record<ToastKind, { border: string; icon: string; glyph: string }> = {
  error: { border: "border-dead/50", icon: "text-dead", glyph: "M12 8v5m0 3.5h.01" },
  info: { border: "border-blurple/50", icon: "text-blurple", glyph: "M12 11v5m0-8.5h.01" },
  success: { border: "border-online/50", icon: "text-online", glyph: "M8.5 12.5l2.5 2.5 4.5-5" },
};

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: number) => void;
}) {
  const [closing, setClosing] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  const style = KIND_STYLE[toast.kind];

  useEffect(() => {
    timerRef.current = window.setTimeout(() => setClosing(true), LIFETIME_MS);
    return () => window.clearTimeout(timerRef.current);
  }, []);

  useEffect(() => {
    if (!closing) return;
    const t = window.setTimeout(() => onDismiss(toast.id), CLOSE_FALLBACK_MS);
    return () => window.clearTimeout(t);
  }, [closing, onDismiss, toast.id]);

  return (
    <div
      onMouseEnter={() => window.clearTimeout(timerRef.current)}
      onMouseLeave={() => {
        if (closing) return;
        window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setClosing(true), RESUME_MS);
      }}
      onAnimationEnd={() => {
        if (closing) onDismiss(toast.id);
      }}
      className={`flex items-start gap-2 rounded-lg border bg-popup px-3 py-2 text-sm text-body shadow-lg ${
        style.border
      } ${closing ? "animate-toast-out" : "animate-slide-up-fade"}`}
    >
      <svg
        className={`mt-0.5 h-4 w-4 shrink-0 ${style.icon}`}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
        <path
          d={style.glyph}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="min-w-0 flex-1 break-words">{toast.text}</span>
      <button
        onClick={() => setClosing(true)}
        aria-label="Dismiss notification"
        className="shrink-0 rounded p-0.5 text-muted hover:text-body"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M6 6l12 12M18 6L6 18"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}

/** Fixed overlay listing transient notices, each auto-expiring and dismissible. */
export function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 z-[60] flex w-full max-w-md -translate-x-1/2 flex-col gap-2 px-4"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
