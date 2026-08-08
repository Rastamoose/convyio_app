import { useRef } from "react";

export type ActionTone =
  | "approve"
  | "deny"
  | "neutral"
  | "primary"
  | "destructive";

const PRESS =
  "border-2 border-body shadow-hard-sm active:translate-x-px active:translate-y-px active:shadow-none";

const TONE_CLASSES: Record<ActionTone, string> = {
  approve: `${PRESS} bg-online text-mention-text hover:opacity-90`,
  deny: `${PRESS} bg-dead text-mention-text hover:opacity-90`,
  neutral: `${PRESS} bg-popup text-body hover:bg-mention-bg-hover`,
  primary: `${PRESS} bg-blurple text-mention-text hover:opacity-90`,
  destructive: "border-2 border-dead bg-transparent text-dead hover:bg-dead/10",
};

/** One button style for board item actions (approve/deny/start/…). */
export function ActionButton({
  label,
  tone,
  onClick,
  compact = false,
}: {
  label: string;
  tone: ActionTone;
  onClick: () => void;
  /** Card layout: buttons share the row and shrink their padding. */
  compact?: boolean;
}) {
  // Optimistic updates flip status synchronously, so a clicked button usually
  // unmounts before a double-click's second press — but not always (fetches in
  // flight, rollbacks). Swallow the repeat press instead of firing twice.
  const lastFired = useRef(0);
  return (
    <button
      onClick={() => {
        const now = Date.now();
        if (now - lastFired.current < 500) return;
        lastFired.current = now;
        onClick();
      }}
      className={`rounded text-xs font-semibold transition duration-150 ${
        compact ? "flex-1 px-2 py-1" : "px-3 py-1.5"
      } ${TONE_CLASSES[tone]}`}
    >
      {label}
    </button>
  );
}
