import { useWorkspace } from "../hooks/WorkspaceContext";
import { ThemeToggle } from "./ThemeToggle";

export type WorkspaceView = "chat" | "board";

/**
 * The application chrome as one slim strip on the canvas above the content
 * panel: brand + sidebar toggle on the left, the view switch dead-center,
 * pending approvals + demo + theme on the right. Everything here operates on
 * the app, never on the conversation; the panel below only ever contains the
 * work (its room tab carries the channel name).
 */
export function AppBar({
  view,
  onSetView,
  sidebarOpen,
  onToggleSidebar,
  onToggleQueue,
  channel,
}: {
  view: WorkspaceView;
  onSetView: (view: WorkspaceView) => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onToggleQueue: () => void;
  channel: string;
}) {
  const { board, pendingInteractions, demoChannels, startDemo } = useWorkspace();
  const pendingCount =
    board.filter((i) => i.status === "proposed").length + pendingInteractions.length;

  const tab = (target: WorkspaceView, label: string) => (
    <button
      role="tab"
      aria-selected={view === target}
      onClick={() => onSetView(target)}
      className={`cursor-pointer rounded-md px-4 py-1.5 font-mono text-xs font-bold tracking-wider uppercase transition select-none ${
        view === target
          ? "bg-popup text-body shadow-sm"
          : "text-muted hover:text-body"
      }`}
    >
      {label}
    </button>
  );

  return (
    <header className="relative flex h-12 shrink-0 items-center gap-3 px-3">
      <img
        src="/mark-yellow.svg"
        alt="convyio"
        draggable={false}
        className="h-6 w-6 shrink-0 select-none"
      />
      <button
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        aria-expanded={sidebarOpen}
        title="Toggle sidebar (⌘B)"
        className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition select-none hover:bg-subtle-hover hover:text-body"
      >
        <svg
          className="h-4.5 w-4.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
        </svg>
      </button>
      {/* Dead-center: the view switch, where eyes land first. */}
      <div
        role="tablist"
        aria-label="Workspace view"
        className="absolute left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-lg bg-subtle p-0.5"
      >
        {tab("chat", "Chat")}
        {tab("board", "Board")}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {demoChannels.includes(channel) && (
          <button
            onClick={() => startDemo(channel)}
            className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent transition select-none hover:bg-accent-hover"
            title="Play the scripted demo conversation"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
            Run demo
          </button>
        )}
        {pendingCount > 0 && (
          <button
            onClick={onToggleQueue}
            aria-label={`Review ${pendingCount} pending approvals`}
            className="flex cursor-pointer items-center gap-1.5 rounded-md bg-accent/15 px-2.5 py-1.5 font-mono text-xs font-bold text-accent transition select-none hover:bg-accent/25"
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
            </span>
            {pendingCount} waiting
          </button>
        )}
        <ThemeToggle />
      </div>
    </header>
  );
}
