import type { BoardItem } from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { formatFullDateTime, relativeTime } from "../lib/format";
import { ActionButton } from "./ActionButton";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="mb-1.5">
      <div className="text-[10px] font-bold tracking-wide text-muted uppercase">
        {label}
      </div>
      <div className="text-sm leading-snug break-words text-body">{value}</div>
    </div>
  );
}

export function ProposalCard({
  item,
  onDiscuss,
}: {
  item: BoardItem;
  onDiscuss: (item: BoardItem) => void;
}) {
  const { approveItem, denyItem } = useWorkspace();
  return (
    <div className="rounded-lg border-2 border-body bg-input p-3 shadow-hard-sm">
      <div className="mb-2 flex items-baseline gap-2 text-xs">
        <span className="shrink-0 rounded bg-blurple px-1 py-px font-bold text-mention-text">
          {item.ref}
        </span>
        <span className="truncate font-medium text-body">
          {item.createdByName}
        </span>
        <span
          className="ml-auto shrink-0 text-faint"
          title={formatFullDateTime(item.createdAt)}
        >
          {relativeTime(item.createdAt)}
        </span>
      </div>
      <Field label="What" value={item.title} />
      {item.proposalWhy && <Field label="Why" value={item.proposalWhy} />}
      {item.proposalEffect && (
        <Field label="Expected effect" value={item.proposalEffect} />
      )}
      {item.scopePaths && item.scopePaths.length > 0 && (
        <div className="mb-1.5">
          <div className="text-[10px] font-bold tracking-wide text-muted uppercase">
            Scope
          </div>
          <div className="font-mono text-xs leading-snug break-all text-body">
            {item.scopePaths.join(", ")}
          </div>
        </div>
      )}
      <div className="mt-2 flex gap-1.5">
        <ActionButton
          compact
          label="Approve"
          tone="approve"
          onClick={() => approveItem(item.id)}
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
    </div>
  );
}
