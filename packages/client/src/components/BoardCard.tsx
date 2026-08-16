import type { BoardItem } from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { formatFullDateTime, relativeTime } from "../lib/format";
import { Avatar } from "./Avatar";
import { AgentBadge } from "./AgentBadge";
import { ActionButton } from "./ActionButton";

export function BoardCard({
  item,
  highlighted,
  planRef,
  onOpen,
  onDiscuss,
  onJumpToTrace,
}: {
  item: BoardItem;
  highlighted: boolean;
  planRef?: string;
  onOpen: (itemId: string) => void;
  onDiscuss: (item: BoardItem) => void;
  onJumpToTrace: (runId: string) => void;
}) {
  const { activeRuns, approveItem, denyItem } = useWorkspace();
  const liveRun =
    item.status === "in_progress"
      ? (activeRuns.find((r) => r.agentName === item.ownerName) ??
        activeRuns[0])
      : undefined;

  return (
    <div
      id={`board-item-${item.ref}`}
      onClick={() => onOpen(item.id)}
      className={`cursor-pointer rounded-lg border border-divider bg-input p-3 transition duration-150 hover:ring-1 hover:ring-accent ${
        highlighted ? "bg-subtle ring-1 ring-accent" : ""
      }`}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className="shrink-0 rounded bg-accent px-1 py-px text-[10px] font-bold text-on-accent">
          {item.ref}
        </span>
        {planRef && <span className="truncate text-[10px] text-faint">{planRef}</span>}
        {item.ownerName && (
          <span className="ml-auto shrink-0" title={item.ownerName}>
            <Avatar name={item.ownerName} size={16} />
          </span>
        )}
      </div>
      <div
        title={item.title}
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
      {item.status === "proposed" && item.scopePaths && item.scopePaths.length > 0 && (
        <div
          className="mt-1 truncate text-[10px] text-faint"
          title={item.scopePaths.join(", ")}
        >
          {item.scopePaths.join(" · ")}
        </div>
      )}
      <div className="mt-2 flex items-center gap-2 text-[10px] text-faint">
        {item.origin === "agent" && <AgentBadge />}
        <span title={formatFullDateTime(item.createdAt)}>
          {relativeTime(item.createdAt)}
        </span>
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
              className="text-accent hover:underline"
            >
              live
            </button>
          </span>
        )}
      </div>
      {item.status === "proposed" && (
        <div className="mt-2 flex gap-1.5" onClick={(e) => e.stopPropagation()}>
          <ActionButton
            compact
            label="Approve"
            tone="approve"
            onClick={() => approveItem(item.id, item.owner ?? undefined)}
          />
          <ActionButton
            compact
            label="Deny"
            tone="deny"
            onClick={() => denyItem(item.id)}
          />
          <ActionButton
            compact
            label="Discuss"
            tone="neutral"
            onClick={() => onDiscuss(item)}
          />
        </div>
      )}
    </div>
  );
}
