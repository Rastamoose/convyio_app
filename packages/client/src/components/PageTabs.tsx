/**
 * The open rooms as page tabs grown out of the conversation panel's top
 * edge — active page in the panel's own paper, background pages recessed.
 * The slanted hairline frame is two nested clip-paths (divider-colored
 * frame, page-colored fill), because clip-path clips ordinary borders away;
 * each tab overlaps the panel's hairline by 1px (-mb-px) to kill the seam.
 */
const TAB_CLIP = "polygon(10px 0, calc(100% - 10px) 0, 100% 100%, 0 100%)";

function TabFrame({
  fill,
  children,
}: {
  fill: string;
  children: React.ReactNode;
}) {
  return (
    <span className="group relative -mb-px bg-divider" style={{ clipPath: TAB_CLIP }}>
      <span
        aria-hidden="true"
        className={`absolute inset-x-px top-px bottom-0 ${fill}`}
        style={{ clipPath: TAB_CLIP }}
      />
      <span className="relative flex items-center">{children}</span>
    </span>
  );
}

export function PageTabs({
  pages,
  active,
  unreadCount,
  onSelect,
  onClose,
  onNew,
}: {
  pages: string[];
  active: string;
  unreadCount: (channel: string) => number;
  onSelect: (channel: string) => void;
  onClose: (channel: string) => void;
  onNew: () => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Open pages"
      className="absolute bottom-full left-3 z-20 flex items-end gap-1 select-none"
    >
      {pages.map((name) => {
        const isActive = name === active;
        const unreads = unreadCount(name);
        return (
          <TabFrame key={name} fill={isActive ? "bg-chat" : "bg-subtle"}>
            <button
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelect(name)}
              className={`flex cursor-pointer items-center gap-1.5 py-2 pl-4 text-sm font-bold tracking-tight ${
                isActive ? "text-body" : "text-muted hover:text-body"
              }`}
            >
              <span className={isActive ? "text-accent" : "text-faint"}>#</span>
              {name}
              {unreads > 0 && (
                <span className="font-mono text-[10px] font-bold text-accent">
                  {unreads > 99 ? "99+" : unreads}
                </span>
              )}
            </button>
            <button
              aria-label={`Close ${name}`}
              title={`Close ${name}`}
              onClick={() => onClose(name)}
              className={`cursor-pointer py-2 pr-4 pl-1 text-sm leading-none transition ${
                isActive
                  ? "text-faint hover:text-body"
                  : "text-faint opacity-0 group-hover:opacity-100 hover:text-body"
              }`}
            >
              ×
            </button>
          </TabFrame>
        );
      })}
      <TabFrame fill="bg-subtle">
        <button
          aria-label="Open a room"
          title="Open a room (⌘K)"
          onClick={onNew}
          className="cursor-pointer px-3 py-2 font-mono text-sm text-muted transition hover:text-body"
        >
          +
        </button>
      </TabFrame>
    </div>
  );
}
