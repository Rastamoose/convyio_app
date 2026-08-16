import { useEffect, useRef } from "react";
import type { BoardItem, InteractionRequest } from "@workspace/shared";
import { ProposalCard } from "./ProposalCard";
import { PermissionCard } from "./PermissionCard";

/** Compact index of the same cards chat already shows. Not a second home. */
export function ApprovalQueue({
  items,
  interactions,
  onResolveInteraction,
  onDiscuss,
  onClose,
}: {
  items: BoardItem[];
  /** Runs paused mid-flight; they block an agent right now, so they sort first. */
  interactions: InteractionRequest[];
  onResolveInteraction: (requestId: string, decision: "approve" | "deny") => void;
  onDiscuss: (item: BoardItem) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  // The board hook prepends new items, but sort defensively: newest first.
  const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div
      ref={ref}
      className="elevated fixed top-11 right-3 z-50 max-h-[70vh] w-80 animate-pop-in overflow-y-auto rounded-lg p-3"
    >
      <h2 className="mb-2 text-[10px] font-bold tracking-wider text-muted uppercase">
        Awaiting approval — {items.length + interactions.length}
      </h2>
      {sorted.length + interactions.length === 0 ? (
        <div className="flex items-center gap-1.5 px-1 py-2 text-xs text-faint">
          <svg
            className="h-3.5 w-3.5 shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
            <path
              d="M8.5 12.5l2.5 2.5 4.5-5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Nothing waiting on you
        </div>
      ) : (
        <div className="space-y-2">
          {interactions.map((request) => (
            <PermissionCard
              key={request.id}
              request={request}
              onResolve={onResolveInteraction}
            />
          ))}
          {sorted.map((item) => (
            <ProposalCard key={item.id} item={item} onDiscuss={onDiscuss} />
          ))}
        </div>
      )}
    </div>
  );
}
