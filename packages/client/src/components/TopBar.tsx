import { useWorkspace } from "../hooks/WorkspaceContext";
import { ThemeToggle } from "./ThemeToggle";

export type WorkspaceView = "chat" | "board";

export function TopBar({
  channel,
  view,
  onSetView,
  sidebarOpen,
  onToggleSidebar,
}: {
  channel: string;
  view: WorkspaceView;
  onSetView: (view: WorkspaceView) => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}) {
  const { demoChannels, startDemo } = useWorkspace();

  const tab = (target: WorkspaceView, label: string) => (
    <button
      role="tab"
      aria-selected={view === target}
      onClick={() => onSetView(target)}
      className={`cursor-pointer border-b-2 px-2 py-1 font-mono text-[11px] font-bold tracking-wider uppercase transition select-none ${
        view === target
          ? "border-accent text-body"
          : "border-transparent text-muted hover:text-body"
      }`}
    >
      {label}
    </button>
  );

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-divider px-4">
      <button
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        aria-expanded={sidebarOpen}
        title="Toggle sidebar (⌘B)"
        className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition select-none hover:bg-subtle-hover hover:text-body"
      >
        <svg
          className="h-4 w-4"
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
      {view === "chat" && (
        <span className="min-w-0 truncate text-lg font-bold tracking-tight text-body select-none">
          <span className="text-accent">#</span>
          {channel}
        </span>
      )}
      <div role="tablist" aria-label="Workspace view" className="ml-auto flex items-center gap-1">
        {tab("chat", "Chat")}
        {tab("board", "Board")}
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        {demoChannels.includes(channel) && (
          <button
            onClick={() => startDemo(channel)}
            className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-accent px-3 py-1 text-sm font-semibold text-on-accent transition select-none hover:bg-accent-hover"
            title="Play the scripted demo conversation"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
            Run demo
          </button>
        )}
        <ThemeToggle />
      </div>
    </header>
  );
}
