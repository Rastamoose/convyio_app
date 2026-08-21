import { useState } from "react";
import type { BoardItem, BoardPlan } from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { formatFullDateTime, relativeTime } from "../lib/format";
import { ActionButton } from "./ActionButton";
import { WorkCardField } from "./WorkCardField";
import { WorkLifecycleStrip } from "./WorkLifecycleStrip";

export function PlanCard({
  plan,
  tickets,
  onDiscuss,
  onOpenBoard,
}: {
  plan: BoardPlan;
  tickets: BoardItem[];
  onDiscuss: (item: { ref: string; title: string }) => void;
  onOpenBoard: (plan: BoardPlan) => void;
}) {
  const { acceptPlan, addPlanConstraint, createBoardItem, context, fetchActors } = useWorkspace();
  const [constraint, setConstraint] = useState("");
  const [adding, setAdding] = useState(false);
  const [proposing, setProposing] = useState(false);
  const liveTicket = tickets.find((item) => item.status !== "denied" && item.status !== "done") ?? tickets[0];
  const latestChange = (plan.changeLog ?? []).at(-1);

  const submitConstraint = () => {
    const text = constraint.trim();
    if (!text || adding) return;
    setAdding(true);
    void addPlanConstraint(plan.id, text).then((ok) => {
      if (ok) setConstraint("");
      setAdding(false);
    });
  };

  const proposeTicket = () => {
    if (proposing || plan.status !== "accepted" || liveTicket) return;
    setProposing(true);
    void fetchActors().then((actors) => {
      const owner = plan.assumedOwnerId ?? actors.find((actor) => actor.kind === "agent")?.id;
      return createBoardItem({
        title: plan.title,
        why: plan.objective,
        effect: plan.outline[0] ?? plan.objective,
        planId: plan.id,
        owner,
        channel: plan.originChannelName,
        scopePaths: ["."],
        acceptanceCriteria: plan.acceptanceCriteria.length > 0 ? plan.acceptanceCriteria : ["The requested outcome is true"],
        impactMap: plan.impactMap,
      });
    }).finally(() => setProposing(false));
  };

  return (
    <div data-onboarding-target="plan-card" data-demo-plan-ref={plan.ref} className="rounded-lg bg-subtle p-3">
      <div className="mb-2 flex items-baseline gap-2 text-xs">
        <span className="shrink-0 rounded bg-accent px-1 py-px text-[10px] font-bold text-on-accent">{plan.ref}</span>
        <span className="truncate font-medium text-body">{plan.title}</span>
        <span className="ml-auto shrink-0 text-faint" title={formatFullDateTime(plan.createdAt)}>
          {relativeTime(plan.createdAt)}
        </span>
      </div>
      <WorkLifecycleStrip
        plan={plan}
        ticket={liveTicket}
        blockers={context.filter((entry) => entry.kind === "blocker" && entry.subjectId === plan.id)}
      />
      <WorkCardField label="Intended outcome" value={plan.objective} />
      {plan.outline.length > 0 && <WorkCardField label="Proposed approach" value={plan.outline.join("; ")} />}
      {plan.constraints.length > 0 && <WorkCardField label="Constraints" value={plan.constraints.join("; ")} />}
      {plan.clarifications.length > 0 && <WorkCardField label="Open questions" value={plan.clarifications.join("; ")} />}
      {plan.acceptanceCriteria.length > 0 && <WorkCardField label="Done when" value={plan.acceptanceCriteria.join("; ")} />}
      {plan.assumedOwnerName && <WorkCardField label="Proposed owner" value={plan.assumedOwnerName} />}
      {plan.assumedProjectName && <WorkCardField label="Likely resource" value={plan.assumedProjectName} />}
      {latestChange && (
        <div data-demo-plan-change={plan.ref} className="mb-2 rounded-md bg-input px-2 py-1.5 text-xs text-body">
          <div className="text-[10px] font-bold tracking-wider text-accent uppercase">Changed before execution</div>
          <div>{latestChange.summary}</div>
          {latestChange.actorName && <div className="text-faint">{latestChange.actorName}</div>}
        </div>
      )}
      {(plan.status === "proposed" || plan.status === "draft" || plan.status === "accepted") && (
        <div className="mb-2 flex gap-1.5">
          <input
            value={constraint}
            onChange={(e) => setConstraint(e.target.value)}
            aria-label="Add constraint"
            placeholder="Add a constraint…"
            className="min-w-0 flex-1 rounded-md bg-input px-2 py-1 text-xs text-body outline-none focus:ring-2 focus:ring-accent"
          />
          <ActionButton compact label={adding ? "Adding…" : "Add constraint"} tone="neutral" onClick={submitConstraint} />
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {plan.status === "proposed" && (
          <span data-demo-plan-accept={plan.ref}>
            <ActionButton compact label="Accept" tone="approve" onClick={() => void acceptPlan(plan.id)} />
          </span>
        )}
        {plan.status === "accepted" && !liveTicket && (
          <ActionButton compact label={proposing ? "Proposing…" : "Propose ticket"} tone="primary" onClick={proposeTicket} />
        )}
        <ActionButton compact label="Discuss" tone="neutral" onClick={() => onDiscuss(plan)} />
        <ActionButton compact label="Open Board" tone="neutral" onClick={() => onOpenBoard(plan)} />
      </div>
    </div>
  );
}
