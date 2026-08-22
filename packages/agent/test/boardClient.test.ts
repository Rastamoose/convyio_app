import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionResultEvent, ClientEvent, PromptEnvelope } from "@workspace/shared";
import { BoardClient } from "../src/boardClient";
import type { AgentSocket } from "../src/socket";

test("BoardClient summary omits channel context from other channels and never mentions plans or tickets", () => {
  const socket = { onEvent: () => undefined } as unknown as AgentSocket;
  const client = new BoardClient(socket);
  const envelope: PromptEnvelope = {
    generatedAt: 1,
    seq: 1,
    policy: [],
    workspace: { id: "workspace-1", name: "test" },
    actor: { id: "agent-1", kind: "agent", displayName: "claude", workspaceId: "workspace-1" },
    context: [
      { id: "context-workspace", workspaceId: "workspace-1", kind: "fact", scope: "workspace", subjectId: null, body: "Shared fact", createdBy: "human-1", supersededBy: null, createdAt: 1 },
      { id: "context-pitch", workspaceId: "workspace-1", kind: "constraint", scope: "channel", subjectId: "channel-pitch", body: "Pitch constraint", createdBy: "human-1", supersededBy: null, createdAt: 1 },
      { id: "context-billing", workspaceId: "workspace-1", kind: "constraint", scope: "channel", subjectId: "channel-billing", body: "Ledger constraint", createdBy: "human-1", supersededBy: null, createdAt: 1 },
    ],
    notes: [],
    members: [],
    permissionMode: "default",
  };
  (client as unknown as { envelope: PromptEnvelope }).envelope = envelope;

  const summary = client.summary("channel-pitch");

  assert.match(summary, /Pitch constraint|Shared fact/);
  assert.doesNotMatch(summary, /Ledger constraint/);
  assert.doesNotMatch(summary, /<plans>|<tickets>|board_propose/);
});

/**
 * The server's folder-consent gate (gateFolderAccess) can prompt the folder
 * owner for any project action, reads included, under "ask" policy — not
 * just the mutating kinds ACTION_CAPABILITY lists. requestAction must treat
 * every project_* action as approval-capable so its wait outlasts that
 * prompt instead of racing the short no-approval timeout.
 */
function mockSocket(): { socket: AgentSocket; sent: ClientEvent[]; resolve: (event: ActionResultEvent) => void } {
  const sent: ClientEvent[] = [];
  let listener: ((event: ActionResultEvent) => void) | null = null;
  const socket = {
    onEvent: (l: (event: ActionResultEvent) => void) => {
      listener = l;
      return () => {};
    },
    send: (event: ClientEvent) => sent.push(event),
  } as unknown as AgentSocket;
  return {
    socket,
    sent,
    resolve: (event) => listener?.(event),
  };
}

test("requestAction suspends the run for a project read, not just mutations", async () => {
  const { socket, sent, resolve } = mockSocket();
  const client = new BoardClient(socket);
  const suspended: string[] = [];
  let resumed = false;
  client.setRunHooks(
    (reason) => suspended.push(reason),
    () => { resumed = true; },
  );

  const pending = client.requestAction({ kind: "project_list_files", projectId: "proj-1" }, null);
  assert.equal(suspended.length, 1, "a project action must suspend the run even though it's a read");
  const requestId = (sent[0] as { requestId: string }).requestId;
  resolve({ type: "action_result", requestId, ok: true, output: "[]" });
  await pending;
  assert.ok(resumed, "resuming must fire once the result arrives");
});

test("requestAction does not suspend the run for a plain, non-project read", async () => {
  const { socket, sent, resolve } = mockSocket();
  const client = new BoardClient(socket);
  const suspended: string[] = [];
  client.setRunHooks((reason) => suspended.push(reason), () => {});

  const pending = client.requestAction({ kind: "list_files" }, null);
  assert.equal(suspended.length, 0, "a legacy, non-project read has no folder-consent gate to wait on");
  const requestId = (sent[0] as { requestId: string }).requestId;
  resolve({ type: "action_result", requestId, ok: true, output: "[]" });
  await pending;
});
