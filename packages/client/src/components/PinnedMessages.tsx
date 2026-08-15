import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";

/** Pushpin glyph (Material push_pin); sized by the caller via className. */
export function PinIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z" />
    </svg>
  );
}

/**
 * Sticky bar summarizing the channel's pinned messages, with a dropdown
 * panel to jump to or unpin each one. Renders nothing when none are pinned.
 */
export function PinnedMessages({
  messages,
  onJump,
}: {
  messages: ChatMessage[];
  onJump: (messageId: string) => void;
}) {
  const { pinMessage } = useWorkspace();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const pinned = messages
    .filter((m) => m.pinnedAt != null)
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
  if (pinned.length === 0) return null;

  return (
    <div ref={ref} className="sticky top-0 z-10">
      <div className="border-b border-divider bg-popup px-4 py-1.5">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center gap-1.5 font-mono text-[11px] font-semibold text-muted hover:text-body"
        >
          <PinIcon className="h-3.5 w-3.5" />
          {pinned.length} pinned
        </button>
      </div>
      {open && (
        <div className="elevated absolute top-full right-3 z-20 mt-1 max-h-[60vh] w-80 overflow-y-auto rounded-lg p-3">
          <h2 className="mb-2 font-mono text-[10px] font-bold tracking-wider text-muted uppercase">
            Pinned messages
          </h2>
          <div className="space-y-1">
            {pinned.map((m) => (
              <div
                key={m.id}
                className="flex items-start gap-2 rounded-md bg-subtle p-2 hover:bg-subtle-hover"
              >
                <button
                  onClick={() => {
                    onJump(m.id);
                    setOpen(false);
                  }}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-sm font-medium text-body">
                      {m.authorName}
                    </span>
                    <span className="shrink-0 text-[10px] text-faint">
                      Pinned by {m.pinnedBy}
                    </span>
                  </div>
                  <p className="truncate text-sm text-muted">
                    {m.content || `${m.attachments?.length ?? 0} attachment(s)`}
                  </p>
                </button>
                <button
                  onClick={() => pinMessage(m.id, false)}
                  title="Unpin message"
                  className="shrink-0 rounded p-0.5 text-muted hover:text-body"
                >
                  <svg
                    className="h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M6 6l12 12M18 6L6 18"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
