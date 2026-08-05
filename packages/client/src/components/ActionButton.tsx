export type ActionTone =
  | "approve"
  | "deny"
  | "neutral"
  | "primary"
  | "destructive";

const TONE_CLASSES: Record<ActionTone, string> = {
  approve: "bg-online text-mention-text hover:opacity-90",
  deny: "bg-dead text-mention-text hover:opacity-90",
  neutral: "bg-popup text-body hover:bg-mention-bg-hover",
  primary: "bg-blurple text-mention-text hover:opacity-90",
  destructive: "border border-dead/50 bg-transparent text-dead hover:bg-dead/10",
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
  return (
    <button
      onClick={onClick}
      className={`rounded text-xs font-semibold ${
        compact ? "flex-1 px-2 py-1" : "px-3 py-1.5"
      } ${TONE_CLASSES[tone]}`}
    >
      {label}
    </button>
  );
}
