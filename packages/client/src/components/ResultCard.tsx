import type { BoardItem, BoardPlan, ToolExecution } from "@workspace/shared";
import { formatFullDateTime, relativeTime } from "../lib/format";
import { ActionButton } from "./ActionButton";
import { WorkCardField } from "./WorkCardField";
import { WorkLifecycleStrip } from "./WorkLifecycleStrip";

export function ResultCard({
  item,
  plan,
  executions,
  onDiscuss,
  onOpenBoard,
}: {
  item: BoardItem;
  plan?: BoardPlan;
  executions: ToolExecution[];
  onDiscuss: (item: BoardItem) => void;
  onOpenBoard: (item: BoardItem) => void;
}) {
  const changed = item.scopePaths?.join(", ") ?? "Authorized paths only";
  const preserved = plan?.constraints.join("; ") || "No extra constraints were recorded.";
  const artifacts = executions
    .filter((execution) => execution.boardItemRef === item.ref)
    .map((execution) => execution.summary)
    .filter(Boolean);
  return (
    <div data-onboarding-target="result-card" className="rounded-lg bg-subtle p-3">
      <div className="mb-2 flex items-baseline gap-2 text-xs">
        <span className="shrink-0 rounded bg-accent px-1 py-px text-[10px] font-bold text-on-accent">{item.ref}</span>
        <span className="truncate font-medium text-body">Result</span>
        <span className="ml-auto shrink-0 text-faint" title={formatFullDateTime(item.completedAt ?? item.createdAt)}>
          {relativeTime(item.completedAt ?? item.createdAt)}
        </span>
      </div>
      <WorkLifecycleStrip plan={plan} ticket={item} />
      <WorkCardField label="Requested outcome" value={item.title} />
      {item.proposalEffect && <WorkCardField label="What happened" value={item.proposalEffect} />}
      <WorkCardField label="What changed" value={changed} />
      <WorkCardField label="What deliberately did not change" value={preserved} />
      {item.verificationEvidence && <WorkCardField label="Checks" value={item.verificationEvidence} />}
      {item.acceptanceCriteria.length > 0 && (
        <WorkCardField label="Done when" value={item.acceptanceCriteria.join("; ")} />
      )}
      {artifacts.length > 0 && <WorkCardField label="Artifacts" value={artifacts.join("; ")} />}
      {plan && <WorkCardField label="Plan" value={`${plan.ref} ${plan.title}`} />}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <ActionButton compact label="Discuss" tone="neutral" onClick={() => onDiscuss(item)} />
        <ActionButton compact label="Open Board" tone="neutral" onClick={() => onOpenBoard(item)} />
      </div>
    </div>
  );
}
