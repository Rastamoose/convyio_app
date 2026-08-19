import { useEffect, useState } from "react";
import type { BoardItem, BoardPlan } from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { formatFullDateTime, relativeTime } from "../lib/format";
import { ActionButton } from "./ActionButton";
import { WorkCardField } from "./WorkCardField";
import { WorkLifecycleStrip } from "./WorkLifecycleStrip";

export function TicketCard({
  item,
  plan,
  onDiscuss,
  onOpenBoard,
}: {
  item: BoardItem;
  plan?: BoardPlan;
  onDiscuss: (item: BoardItem) => void;
  onOpenBoard: (item: BoardItem) => void;
}) {
  const { approveItem, denyItem, fetchActors, pendingInteractions, activeRuns } = useWorkspace();
  const [owner, setOwner] = useState(item.owner ?? plan?.assumedOwnerId ?? "");
  const [actors, setActors] = useState<{ id: string; displayName: string }[]>([]);
  useEffect(() => {
    void fetchActors().then((list) =>
      setActors(list.map((actor) => ({ id: actor.id, displayName: actor.displayName }))),
    );
    // fetchActors is recreated each render; load the roster once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div data-onboarding-target="ticket-card" className="rounded-lg bg-subtle p-3">
      <div className="mb-2 flex items-baseline gap-2 text-xs">
        <span className="shrink-0 rounded bg-accent px-1 py-px text-[10px] font-bold text-on-accent">{item.ref}</span>
        <span className="truncate font-medium text-body">{item.title}</span>
        <span className="ml-auto shrink-0 text-faint" title={formatFullDateTime(item.createdAt)}>
          {relativeTime(item.createdAt)}
        </span>
      </div>
      <WorkLifecycleStrip
        plan={plan}
        ticket={item}
        running={activeRuns.some((run) => run.agentName === item.ownerName)}
        pendingInteraction={pendingInteractions.some((request) => request.boardItemRef === item.ref)}
      />
      {item.proposalWhy && <WorkCardField label="Why" value={item.proposalWhy} />}
      {item.proposalEffect && <WorkCardField label="May change" value={item.proposalEffect} />}
      {plan?.constraints.length ? <WorkCardField label="Must preserve" value={plan.constraints.join("; ")} /> : null}
      {item.ownerName && <WorkCardField label="Owner" value={item.ownerName} />}
      {plan?.assumedProjectName && <WorkCardField label="Resource" value={plan.assumedProjectName} />}
      {item.acceptanceCriteria.length > 0 && <WorkCardField label="Done when" value={item.acceptanceCriteria.join("; ")} />}
      {item.scopePaths && item.scopePaths.length > 0 && <WorkCardField label="Scope" value={item.scopePaths.join(", ")} />}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {item.status === "proposed" && (
          <>
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
            <ActionButton compact label="Approve" tone="approve" onClick={() => approveItem(item.id, owner || item.owner || undefined)} />
            <ActionButton compact label="Deny" tone="deny" onClick={() => denyItem(item.id)} />
          </>
        )}
        <ActionButton compact label="Discuss" tone="neutral" onClick={() => onDiscuss(item)} />
        <ActionButton compact label="Open Board" tone="neutral" onClick={() => onOpenBoard(item)} />
      </div>
    </div>
  );
}
