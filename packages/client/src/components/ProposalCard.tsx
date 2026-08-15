import { useEffect, useState } from "react";
import type { BoardItem } from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { formatFullDateTime, relativeTime } from "../lib/format";
import { ActionButton } from "./ActionButton";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="mb-1.5">
      <div className="font-mono text-[10px] font-bold tracking-wider text-muted uppercase">
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
  const { approveItem, denyItem, fetchActors } = useWorkspace();
  const [owner, setOwner] = useState(item.owner ?? "");
  const [actors, setActors] = useState<{ id: string; displayName: string }[]>([]);
  useEffect(() => {
    void fetchActors().then((list) =>
      setActors(list.map((actor) => ({ id: actor.id, displayName: actor.displayName }))),
    );
    // fetchActors is recreated each render; load the roster once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="rounded-lg bg-subtle p-3">
      <div className="mb-2 flex items-baseline gap-2 text-xs">
        <span className="shrink-0 rounded bg-accent px-1 py-px font-mono text-[10px] font-bold text-on-accent">
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
      {item.ownerName && <Field label="Owner" value={item.ownerName} />}
      {item.acceptanceCriteria.length > 0 && (
        <Field label="Done when" value={item.acceptanceCriteria.join("; ")} />
      )}
      {item.scopePaths && item.scopePaths.length > 0 && (
        <div className="mb-1.5">
          <div className="font-mono text-[10px] font-bold tracking-wider text-muted uppercase">
            Scope
          </div>
          <div className="font-mono text-xs leading-snug break-all text-body">
            {item.scopePaths.join(", ")}
          </div>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <select
          aria-label="Approve as owner"
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          className="rounded-md bg-input px-2 py-1 text-xs text-body outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">Owner…</option>
          {actors.map((actor) => (
            <option key={actor.id} value={actor.id}>{actor.displayName}</option>
          ))}
        </select>
        <ActionButton
          compact
          label="Approve"
          tone="approve"
          onClick={() => approveItem(item.id, owner || item.owner || undefined)}
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
