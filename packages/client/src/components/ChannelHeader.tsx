import { useWorkspace } from "../hooks/WorkspaceContext";

/**
 * The conversation panel's own header: which room you're in, plus the one
 * channel-scoped action (demo playback). App-level chrome — the view switch,
 * sidebar and theme toggles — lives in AppBar, above the panel.
 */
export function ChannelHeader({ channel }: { channel: string }) {
  const { demoChannels, startDemo } = useWorkspace();

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-divider px-4">
      <span className="min-w-0 truncate text-lg font-bold tracking-tight text-body select-none">
        <span className="text-accent">#</span>
        {channel}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-2.5">
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
      </div>
    </header>
  );
}
