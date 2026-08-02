import type { BoardItem } from "@workspace/shared";
import type { ActiveRun } from "../hooks/useWorkspace";
import { Avatar } from "./Avatar";
import { relativeTime } from "./ProposalCard";

export function BoardCard({
  item,
  activeRuns,
  highlighted,
  onOpen,
  onApprove,
  onDeny,
  onDiscuss,
  onJumpToTrace,
}: {
  item: BoardItem;
  activeRuns: ActiveRun[];
  highlighted: boolean;
  onOpen: (itemId: string) => void;
  onApprove: (itemId: string) => void;
  onDeny: (itemId: string) => void;
  onDiscuss: (item: BoardItem) => void;
  onJumpToTrace: (runId: string) => void;
}) {
  const liveRun =
    item.status === "in_progress"
      ? (activeRuns.find((r) => r.agentName === item.ownerName) ??
        activeRuns[0])
      : undefined;

  return (
    <div
      id={`board-item-${item.ref}`}
      onClick={() => onOpen(item.id)}
      className={`cursor-pointer rounded bg-input p-3 transition hover:ring-1 hover:ring-blurple/60 ${
        highlighted ? "bg-blurple/20 ring-1 ring-blurple" : ""
      }`}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className="shrink-0 rounded bg-blurple px-1 text-[10px] font-bold text-mention-text">
          {item.ref}
        </span>
        {item.ownerName && (
          <span className="ml-auto shrink-0" title={item.ownerName}>
            <Avatar name={item.ownerName} size={16} />
          </span>
        )}
      </div>
      <div
        className={`line-clamp-2 text-sm ${
          item.status === "denied" ? "text-muted line-through" : "text-body"
        }`}
      >
        {item.title}
      </div>
      {item.status === "proposed" && item.proposalWhy && (
        <div className="mt-1 truncate text-xs text-muted italic">
          {item.proposalWhy}
        </div>
      )}
      <div className="mt-2 flex items-center gap-2 text-[11px] text-faint">
        {item.origin === "agent" && (
          <span className="rounded bg-blurple/30 px-1 py-px text-[9px] font-bold tracking-wide text-mention-text uppercase">
            agent
          </span>
        )}
        <span>{relativeTime(item.createdAt)}</span>
        {liveRun && (
          <span className="ml-auto flex items-center gap-1">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-online opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-online" />
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onJumpToTrace(liveRun.runId);
              }}
              className="text-blurple hover:underline"
            >
              live
            </button>
          </span>
        )}
      </div>
      {item.status === "proposed" && (
        <div className="mt-2 flex gap-1.5" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => onApprove(item.id)}
            className="flex-1 rounded bg-online px-2 py-1 text-xs font-semibold text-mention-text hover:opacity-90"
          >
            Approve
          </button>
          <button
            onClick={() => onDeny(item.id)}
            className="flex-1 rounded bg-dead px-2 py-1 text-xs font-semibold text-mention-text hover:opacity-90"
          >
            Deny
          </button>
          <button
            onClick={() => onDiscuss(item)}
            className="flex-1 rounded bg-popup px-2 py-1 text-xs font-semibold text-body hover:bg-mention-bg-hover"
          >
            Discuss
          </button>
        </div>
      )}
    </div>
  );
}
