import type { Actor, BoardItem } from "./board";
import type { PermissionMode } from "./agentWork";
import type { BoardPlan, ContextEntry } from "./context";

export interface PolicyRef {
  id: string;
  version: string;
  hash: string;
  text: string;
}

export interface PromptEnvelope {
  generatedAt: number;
  seq: number;
  policy: PolicyRef[];
  workspace: { id: string; name: string };
  actor: Actor;
  plans: BoardPlan[];
  tickets: BoardItem[];
  context: ContextEntry[];
  members: Actor[];
  permissionMode: PermissionMode;
}

export function renderPromptEnvelope(envelope: PromptEnvelope): string {
  const policy = envelope.policy
    .map((ref) => `<policy id="${ref.id}" version="${ref.version}" hash="${ref.hash}">\n${ref.text}\n</policy>`)
    .join("\n\n");
  const plans = envelope.plans.length
    ? envelope.plans
        .map((plan) => {
          const constraints = plan.constraints.length
            ? ` constraints=${plan.constraints.join("; ")}`
            : "";
          const owner = plan.assumedOwnerName ? ` proposed-owner=${plan.assumedOwnerName}` : "";
          const resource = plan.assumedProjectName ? ` resource=${plan.assumedProjectName}` : "";
          return `${plan.ref} [${plan.status}] ${plan.title} — ${plan.objective}${owner}${resource}${constraints}`;
        })
        .join("\n")
    : "(no plans)";
  const tickets = envelope.tickets.length
    ? envelope.tickets
        .map((item) => {
          const owner = item.ownerName ? ` owner=${item.ownerName}` : "";
          const scope = item.scopePaths ? ` scope=${item.scopePaths.join(",")}` : "";
          const criteria = item.acceptanceCriteria.length
            ? ` done-when=${item.acceptanceCriteria.join("; ")}`
            : "";
          return `${item.ref} [${item.status}] ${item.title}${owner}${scope}${criteria}`;
        })
        .join("\n")
    : "(no live tickets)";
  const context = envelope.context.length
    ? envelope.context
        .map((entry) => {
          const who = entry.createdByName ? ` by ${entry.createdByName}` : "";
          return `[${entry.kind}/${entry.scope}${who}] ${entry.body}`;
        })
        .join("\n")
    : "(no active context entries)";
  const members = envelope.members
    .map((member) => `${member.displayName} (${member.kind})`)
    .join(", ");
  return [
    policy,
    `<workspace id="${envelope.workspace.id}" seq="${envelope.seq}">${envelope.workspace.name}</workspace>`,
    `<actor>${envelope.actor.displayName} (${envelope.actor.kind})</actor>`,
    `<permission-mode>${envelope.permissionMode}</permission-mode>`,
    `<members>${members || "(none)"}</members>`,
    `<plans>\n${plans}\n</plans>`,
    `<tickets>\n${tickets}\n</tickets>`,
    `<context>\n${context}\n</context>`,
  ].join("\n\n");
}
