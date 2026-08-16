import type { WorkspaceView } from "./AppBar";

/**
 * The content panel's own header: the sidebar toggle and the room name,
 * nothing else — the view switch and theme are app-level chrome and live in
 * the AppBar above the panel.
 */
export function PanelHeader({
  view,
  sidebarOpen,
  onToggleSidebar,
  channel,
}: {
  view: WorkspaceView;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  channel: string;
}) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b border-divider px-3">
      <button
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        aria-expanded={sidebarOpen}
        title="Toggle sidebar (⌘B)"
        className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition select-none hover:bg-subtle-hover hover:text-body"
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
      {view === "chat" && (
        <span className="min-w-0 truncate text-lg font-bold tracking-tight text-body select-none">
          <span className="text-accent">#</span>
          {channel}
        </span>
      )}
    </header>
  );
}
