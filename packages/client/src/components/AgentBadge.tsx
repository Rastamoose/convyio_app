/** The "AGENT" pill shown beside agent names, identical everywhere. */
export function AgentBadge({ className = "" }: { className?: string }) {
  return (
    <span
      className={`rounded bg-accent px-1 py-px text-[9px] font-bold tracking-wide text-on-accent ${className}`}
    >
      AGENT
    </span>
  );
}
