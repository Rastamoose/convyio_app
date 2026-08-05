/** The "AGENT" pill shown beside agent names, identical everywhere. */
export function AgentBadge({ className = "" }: { className?: string }) {
  return (
    <span
      className={`rounded bg-blurple px-1 py-px text-[10px] font-bold text-mention-text ${className}`}
    >
      AGENT
    </span>
  );
}
