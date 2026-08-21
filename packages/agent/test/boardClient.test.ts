import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardItem, BoardPlan, PromptEnvelope } from "@workspace/shared";
import { emptyImpactMap } from "@workspace/shared";
import { BoardClient } from "../src/boardClient";
import type { AgentSocket } from "../src/socket";

function plan(id: string, channelId: string, title: string): BoardPlan {
  return {
    id,
    workspaceId: "workspace-1",
    ref: id,
    title,
    objective: title,
    outline: [],
    impactMap: emptyImpactMap(),
    constraints: [],
    decisions: [],
    acceptanceCriteria: [],
    clarifications: [],
    status: "accepted",
    createdBy: "human-1",
    acceptedBy: "human-1",
    createdAt: 1,
    acceptedAt: 2,
    completedAt: null,
    originChannelId: channelId,
  };
}

function ticket(
  id: string,
  planId: string,
  channelId: string,
  title: string,
  status: BoardItem["status"] = "approved",
): BoardItem {
  return {
    id,
    workspaceId: "workspace-1",
    ref: id,
    title,
    description: null,
    status,
    origin: "human",
    createdBy: "human-1",
    approvedBy: "human-1",
    owner: "agent-1",
    planId,
    acceptanceCriteria: [],
    verificationEvidence: null,
    impactMap: emptyImpactMap(),
    proposalWhy: null,
    proposalEffect: null,
    scopePaths: ["/"],
    projectId: null,
    capabilities: ["file_write"],
    createdAt: 1,
    approvedAt: 2,
    startedAt: null,
    completedAt: null,
    deletedAt: null,
    originChannelId: channelId,
  };
}

test("BoardClient summary omits private plans, proposed tickets, and context from other channels", () => {
  const socket = { onEvent: () => undefined } as unknown as AgentSocket;
  const client = new BoardClient(socket);
  const envelope: PromptEnvelope = {
    generatedAt: 1,
    seq: 1,
    policy: [],
    workspace: { id: "workspace-1", name: "test" },
    actor: { id: "agent-1", kind: "agent", displayName: "claude", workspaceId: "workspace-1" },
    plans: [
      plan("plan-pitch", "channel-pitch", "Pitch plan"),
      plan("plan-billing", "channel-billing", "Billing plan"),
    ],
    tickets: [
      ticket("ticket-pitch", "plan-pitch", "channel-pitch", "Pitch ticket"),
      ticket("ticket-billing", "plan-billing", "channel-billing", "Billing ticket", "proposed"),
    ],
    context: [
      { id: "context-workspace", workspaceId: "workspace-1", kind: "fact", scope: "workspace", subjectId: null, body: "Shared fact", createdBy: "human-1", supersededBy: null, createdAt: 1 },
      { id: "context-pitch", workspaceId: "workspace-1", kind: "constraint", scope: "plan", subjectId: "plan-pitch", body: "Pitch constraint", createdBy: "human-1", supersededBy: null, createdAt: 1 },
      { id: "context-billing", workspaceId: "workspace-1", kind: "constraint", scope: "plan", subjectId: "plan-billing", body: "Ledger constraint", createdBy: "human-1", supersededBy: null, createdAt: 1 },
    ],
    notes: [],
    members: [],
    permissionMode: "default",
  };
  (client as unknown as { envelope: PromptEnvelope }).envelope = envelope;

  const summary = client.summary("channel-pitch");

  assert.match(summary, /Pitch plan|Pitch ticket|Pitch constraint|Shared fact/);
  assert.doesNotMatch(summary, /Billing plan|Billing ticket|Ledger constraint/);
});
