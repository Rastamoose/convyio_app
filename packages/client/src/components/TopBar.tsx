import { useWorkspace } from "../hooks/WorkspaceContext";

export type WorkspaceView = "chat" | "board";

export function TopBar({
  channel,
  view,
  onSetView,
}: {
  channel: string;
  view: WorkspaceView;
  onSetView: (view: WorkspaceView) => void;
}) {
  const { demoChannels, startDemo } = useWorkspace();

  const tab = (target: WorkspaceView, label: string) => (
    <button
      role="tab"
      aria-selected={view === target}
      onClick={() => onSetView(target)}
      className={`rounded-lg px-3 py-1 text-sm font-semibold transition ${
        view === target
          ? "bg-input text-body"
          : "text-muted hover:bg-input/50 hover:text-body"
      }`}
    >
      {label}
    </button>
  );

  return (
    <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-sidebar-dark bg-sidebar-dark px-4">
      <div role="tablist" aria-label="Workspace view" className="flex items-center gap-2.5">
        {tab("chat", "Chat")}
        {tab("board", "Board")}
      </div>
      {view === "chat" && (
        <>
          <span className="ml-1.5 font-semibold text-body">{channel}</span>
          <span className="rounded bg-sidebar px-1.5 py-px text-[10px] font-bold tracking-wide text-muted uppercase">
            room
          </span>
        </>
      )}
      {demoChannels.includes(channel) && (
        <button
          onClick={() => startDemo(channel)}
          className="ml-auto flex items-center gap-1.5 rounded-lg bg-blurple px-3 py-1 text-sm font-semibold text-mention-text transition hover:bg-working"
          title="Play the scripted demo conversation"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M8 5v14l11-7z" />
          </svg>
          Run demo
        </button>
      )}
    </header>
  );
}
