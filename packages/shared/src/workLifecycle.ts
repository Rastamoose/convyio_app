import type { BoardItem } from "./board";
import type { BoardPlan, ContextEntry } from "./context";

export type WorkLifecycleState =
  | "understanding"
  | "planning"
  | "waiting_for_you"
  | "assigned"
  | "working"
  | "blocked"
  | "verified";

export const WORK_LIFECYCLE_LABEL: Record<WorkLifecycleState, string> = {
  understanding: "Understanding",
  planning: "Planning",
  waiting_for_you: "Waiting for you",
  assigned: "Assigned",
  working: "Working",
  blocked: "Blocked",
  verified: "Verified",
};

export interface WorkLifecycle {
  state: WorkLifecycleState;
  label: string;
  nextAction: string;
  ownerName?: string;
  resourceName?: string;
}

export function workLifecycle(input: {
  plan?: BoardPlan | null;
  ticket?: BoardItem | null;
  running?: boolean;
  pendingInteraction?: boolean;
  blockers?: ContextEntry[];
}): WorkLifecycle {
  const ticket = input.ticket ?? null;
  const plan = input.plan ?? null;
  const ownerName = ticket?.ownerName ?? plan?.assumedOwnerName;
  const resourceName = plan?.assumedProjectName;
  const blockers = (input.blockers ?? []).filter((entry) => !entry.supersededBy);
  const state = resolveState(plan, ticket, input.running === true, input.pendingInteraction === true, blockers.length > 0);
  return {
    state,
    label: WORK_LIFECYCLE_LABEL[state],
    nextAction: nextAction(state, ticket),
    ownerName,
    resourceName,
  };
}

function resolveState(
  plan: BoardPlan | null,
  ticket: BoardItem | null,
  running: boolean,
  pendingInteraction: boolean,
  blockedByContext: boolean,
): WorkLifecycleState {
  if (ticket?.status === "done") return "verified";
  if (ticket?.status === "blocked" || blockedByContext || pendingInteraction) return "blocked";
  if (ticket?.status === "in_progress" || running) return "working";
  if (ticket?.status === "approved") return "assigned";
  if (ticket?.status === "proposed" || (plan && (plan.status === "proposed" || plan.status === "draft"))) {
    return "waiting_for_you";
  }
  if (plan?.status === "accepted") return "planning";
  return "understanding";
}

function nextAction(state: WorkLifecycleState, ticket: BoardItem | null): string {
  switch (state) {
    case "understanding":
      return "Discuss the work until a plan can be proposed.";
    case "planning":
      return "Propose the next ticket from this plan.";
    case "waiting_for_you":
      return ticket ? "Approve, deny, or discuss this ticket." : "Accept, refine, or add a constraint.";
    case "assigned":
      return "The owner can start the authorized work.";
    case "working":
      return "Watch progress and answer any checkpoint.";
    case "blocked":
      return "A human decision is needed before work can continue.";
    case "verified":
      return "Review the result in this thread.";
  }
}
