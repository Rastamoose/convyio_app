import { useEffect, useMemo, useRef, useState } from "react";

/** Case-insensitive substring match — deliberately not fuzzy, keeps this small. */
function matches(channel: string, query: string): boolean {
  return channel.toLowerCase().includes(query.toLowerCase());
}

/**
 * Ctrl/Cmd+K overlay: type to filter channels, arrows to move the
 * highlight, Enter to jump. Opened/closed by App, which owns the single
 * window keydown listener this pairs with.
 */
export function QuickSwitcher({
  channels,
  unreadCount,
  onSelect,
  onClose,
}: {
  channels: string[];
  unreadCount: (channel: string) => number;
  onSelect: (channel: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) {
      // Empty query: everything, unread first (stable sort keeps display order within each group).
      return [...channels].sort(
        (a, b) => Number(unreadCount(b) > 0) - Number(unreadCount(a) > 0),
      );
    }
    return channels.filter((c) => matches(c, q));
  }, [channels, query, unreadCount]);

  useEffect(() => setHighlighted(0), [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (results.length === 0) {
      if (e.key === "Escape") onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => (h + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => (h - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      onSelect(results[highlighted]);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 animate-fade-in bg-backdrop/80">
      <div
        ref={ref}
        className="elevated animate-pop-in mx-auto mt-24 w-full max-w-md overflow-hidden rounded-xl"
      >
        <input
          ref={inputRef}
          aria-label="Jump to channel"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Jump to channel…"
          className="w-full border-b border-divider bg-transparent px-4 py-3 text-body outline-none placeholder:text-faint"
        />
        <ul className="max-h-80 overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-faint">No matching channels</li>
          ) : (
            results.map((c, i) => {
              const unreads = unreadCount(c);
              return (
                <li key={c}>
                  <button
                    className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm ${
                      i === highlighted ? "bg-subtle text-body" : "text-body"
                    }`}
                    onMouseEnter={() => setHighlighted(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onSelect(c);
                    }}
                  >
                    <span className="shrink-0 text-faint">#</span>
                    <span className="min-w-0 flex-1 truncate">{c}</span>
                    {unreads > 0 && (
                      <span className="ml-auto shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-bold text-on-accent">
                        {unreads > 99 ? "99+" : unreads}
                      </span>
                    )}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
