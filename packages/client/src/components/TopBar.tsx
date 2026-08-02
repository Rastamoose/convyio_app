export function TopBar({
  channel,
  onRunDemo,
  boardOpen,
  onToggleBoard,
}: {
  channel: string;
  onRunDemo?: () => void;
  boardOpen: boolean;
  onToggleBoard: () => void;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-sidebar-dark bg-sidebar-dark px-4">
      <span className="font-semibold text-body">{channel}</span>
      <span className="rounded bg-sidebar px-1.5 py-px text-[10px] font-bold tracking-wide text-muted uppercase">
        room
      </span>
      <div className="ml-auto flex items-center gap-4">
        {onRunDemo && (
          <button
            onClick={onRunDemo}
            className="flex items-center gap-1.5 rounded-lg bg-blurple px-3 py-1 text-sm font-semibold text-mention-text transition hover:bg-working"
            title="Play the scripted demo conversation"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
            Run demo
          </button>
        )}
        <button
          onClick={onToggleBoard}
          className={`rounded-lg px-3 py-1 text-sm font-semibold transition ${
            boardOpen
              ? "bg-blurple text-mention-text"
              : "bg-input text-body hover:bg-mention-bg-hover"
          }`}
          title="Toggle the canonical board"
        >
          Board
        </button>
        <div className="flex h-6 w-40 items-center rounded-lg bg-sidebar px-2">
          <input
            className="w-full bg-transparent text-sm text-body outline-none placeholder:text-faint"
            placeholder="Search"
          />
          <svg className="h-4 w-4 shrink-0 text-faint" viewBox="0 0 24 24" fill="none">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
            <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
      </div>
    </header>
  );
}
