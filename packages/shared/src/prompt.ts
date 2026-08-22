import type { Actor } from "./board";
import type { PermissionMode } from "./agentWork";
import type { ContextEntry } from "./context";
import type { ContextNote } from "./resource";

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
  context: ContextEntry[];
  notes: ContextNote[];
  members: Actor[];
  permissionMode: PermissionMode;
}

export function renderPromptEnvelope(envelope: PromptEnvelope): string {
  const policy = envelope.policy
    .map((ref) => `<policy id="${ref.id}" version="${ref.version}" hash="${ref.hash}">\n${ref.text}\n</policy>`)
    .join("\n\n");
  const context = envelope.context.length
    ? envelope.context
        .map((entry) => {
          const who = entry.createdByName ? ` by ${entry.createdByName}` : "";
          return `[${entry.kind}/${entry.scope}${who}] ${entry.body}`;
        })
        .join("\n")
    : "(no active context entries)";
  const notes = envelope.notes?.length
    ? envelope.notes
        .map((note) => `[${note.scope}${note.createdByName ? ` by ${note.createdByName}` : ""}] ${note.body}`)
        .join("\n")
    : "(no active notes)";
  const members = envelope.members
    .map((member) => `${member.displayName} (${member.kind})`)
    .join(", ");
  return [
    policy,
    `<workspace id="${envelope.workspace.id}" seq="${envelope.seq}">${envelope.workspace.name}</workspace>`,
    `<actor>${envelope.actor.displayName} (${envelope.actor.kind})</actor>`,
    `<permission-mode>${envelope.permissionMode}</permission-mode>`,
    `<members>${members || "(none)"}</members>`,
    `<context>\n${context}\n</context>`,
    `<notes>\n${notes}\n</notes>`,
  ].join("\n\n");
}
