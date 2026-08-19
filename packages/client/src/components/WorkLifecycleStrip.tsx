import { workLifecycle, type BoardItem, type BoardPlan, type ContextEntry } from "@workspace/shared";

export function WorkLifecycleStrip({
  plan,
  ticket,
  running,
  pendingInteraction,
  blockers,
}: {
  plan?: BoardPlan | null;
  ticket?: BoardItem | null;
  running?: boolean;
  pendingInteraction?: boolean;
  blockers?: ContextEntry[];
}) {
  const life = workLifecycle({ plan, ticket, running, pendingInteraction, blockers });
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
      <span className="rounded bg-accent px-1.5 py-px font-bold text-on-accent">{life.label}</span>
      {life.ownerName && <span className="text-muted">Owner {life.ownerName}</span>}
      {life.resourceName && <span className="text-muted">Resource {life.resourceName}</span>}
      <span className="text-faint">{life.nextAction}</span>
    </div>
  );
}
