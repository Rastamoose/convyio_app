import { useWorkspace } from "../hooks/WorkspaceContext";
import type { WorkspaceView } from "./AppBar";

/**
 * The bottom strip of the instrument: connection, workspace, where you are,
 * what the agents are doing, and the two shortcuts worth teaching. Full
 * window width, always on — the one readout that never scrolls away.
 */
export function StatusBar({
  channel,
  view,
}: {
  channel: string;
  view: WorkspaceView;
}) {
  const { workspace, participants, connected } = useWorkspace();
  const working = participants.filter(
    (p) => p.kind === "agent" && p.runState === "working",
  ).length;
  const online = participants.filter((p) => p.online).length;

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-divider px-3 font-mono text-[10px] tracking-wide text-faint select-none">
      <span className="flex items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-online" : "animate-pulse bg-dead"}`}
        />
        <span className="text-muted">{workspace?.name}</span>
      </span>
      {view === "chat" && <span># {channel}</span>}
      <span>
        {working > 0 ? (
          <span className="text-working">
            {working} agent{working === 1 ? "" : "s"} working
          </span>
        ) : (
          `${online} online`
        )}
      </span>
      <span className="ml-auto">⌘K jump · ⌘B sidebar</span>
    </footer>
  );
}
