import { useWorkspace } from "../hooks/WorkspaceContext";
import { ThemeToggle } from "./ThemeToggle";

export type WorkspaceView = "chat" | "board";

/**
 * The application chrome: view switch, sidebar toggle, theme, jump-to, and
 * the pending-approval signal — everything that operates on the app rather
 * than on the conversation. Lives on the canvas above both the sidebar and
 * the content panel, so the panel itself only ever contains the work.
 *
 * The brand mark is a mask over `text-body`, not an <img>: the same shape
 * renders as ink in both themes with no theme branching.
 */
export function AppBar({
  view,
  onSetView,
  sidebarOpen,
  onToggleSidebar,
  onOpenSwitcher,
  onToggleQueue,
}: {
  view: WorkspaceView;
  onSetView: (view: WorkspaceView) => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenSwitcher: () => void;
  onToggleQueue: () => void;
}) {
  const { board, pendingInteractions } = useWorkspace();
  const pendingCount =
    board.filter((i) => i.status === "proposed").length + pendingInteractions.length;

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
    <header className="relative flex h-12 shrink-0 items-center gap-3 px-3">
      <span
        aria-hidden="true"
        className="h-5 w-5 shrink-0 bg-body"
        style={{
          WebkitMaskImage: "url(/mark-black.svg)",
          maskImage: "url(/mark-black.svg)",
          WebkitMaskSize: "contain",
          maskSize: "contain",
          WebkitMaskRepeat: "no-repeat",
          maskRepeat: "no-repeat",
        }}
      />
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
      <div role="tablist" aria-label="Workspace view" className="flex items-center gap-1">
        {tab("chat", "Chat")}
        {tab("board", "Board")}
      </div>

      {/* Dead-center: the jump-to field, where eyes land first. */}
      <button
        onClick={onOpenSwitcher}
        aria-label="Jump to a channel (⌘K)"
        className="absolute left-1/2 flex w-64 -translate-x-1/2 cursor-pointer items-center gap-2 rounded-md border border-divider bg-input px-3 py-1.5 text-sm text-faint transition select-none hover:bg-subtle-hover"
      >
        <svg
          className="h-3.5 w-3.5 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <span className="flex-1 text-left">Jump to…</span>
        <kbd className="font-mono text-[10px] text-faint">⌘K</kbd>
      </button>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {pendingCount > 0 && (
          <button
            onClick={onToggleQueue}
            aria-label={`Review ${pendingCount} pending approvals`}
            className="flex cursor-pointer items-center gap-1.5 rounded-md bg-accent/15 px-2 py-1 font-mono text-[11px] font-bold text-accent transition select-none hover:bg-accent/25"
          >
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
            </span>
            {pendingCount} waiting
          </button>
        )}
        <ThemeToggle />
      </div>
    </header>
  );
}
