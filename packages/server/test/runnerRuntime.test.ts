import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { RUNNER_PROTOCOL_VERSION, type AgentAccessPolicy } from "@workspace/shared";
import { createWsEnv, type FakeSupabaseUser, type WsClient } from "./helpers";

const users: Record<string, FakeSupabaseUser | "unavailable"> = {};
let env: Awaited<ReturnType<typeof createWsEnv>>;

before(async () => {
  env = await createWsEnv({ auth: { users, agentToken: "global-agent-token" } });
});

afterEach(async () => {
  await env.reset();
  for (const token of Object.keys(users)) delete users[token];
});

after(async () => {
  if (env) await env.close();
});

async function connectHuman(id: string, name: string): Promise<WsClient> {
  const token = `token-${id}`;
  users[token] = { id, email: `${name}@example.com` };
  await env.db.createHuman(id, name, `${name}@example.com`);
  const joined = await env.join({ type: "join", kind: "human", authToken: token });
  assert.ok(joined.client);
  return joined.client;
}

async function connectInstallation(
  creatorId: string,
  name: string,
  access: AgentAccessPolicy = { mode: "workspace", selectedActorIds: [] },
): Promise<{ client: WsClient; inviteId: string; actorId: string }> {
  const creator = (await env.db.getActor(creatorId))!;
  const { invite } = await env.agentInvites.create(name, "claude", creator, {
    instructions: "Use the stored profile.",
    requestedModel: "claude-sonnet",
    access,
  });
  const pairing = await env.agentInvites.createPairing(invite.id, creator);
  assert.ok(pairing);
  const installation = await env.agentInvites.exchangePairing(pairing.pairingCode);
  assert.ok(installation);
  const joined = await env.join({
    type: "join",
    kind: "agent",
    authToken: installation.installationToken,
  });
  assert.ok(joined.client);
  assert.deepEqual(joined.welcome?.agentConfig, invite);
  return { client: joined.client, inviteId: invite.id, actorId: invite.actorId };
}

function hello(client: WsClient, harness = "claude", protocolVersion = RUNNER_PROTOCOL_VERSION): void {
  client.ws.send(
    JSON.stringify({
      type: "runner_hello",
      protocolVersion,
      harness: { id: harness, version: "0.1.0" },
      options: [
        {
          id: "model",
          label: "Model",
          category: "model",
          kind: "select",
          value: "claude-sonnet",
          choices: [{ value: "claude-sonnet", label: "Claude Sonnet" }],
        },
      ],
    }),
  );
}

function status(client: WsClient, configRevision: number, health = "ready"): void {
  client.ws.send(
    JSON.stringify({
      type: "runner_status",
      configRevision,
      health,
      effectiveModel: "claude-sonnet",
      diagnosticCode: health === "degraded" ? "LIMITED_MODE" : undefined,
    }),
  );
}

async function postMention(human: WsClient, agentName: string, suffix: string): Promise<any> {
  const content = `@${agentName} ${suffix}`;
  human.ws.send(JSON.stringify({ type: "message", content }));
  return human.next((event) => event.type === "message" && event.message.content === content);
}

describe("installation runner readiness", () => {
  test("checking gates queued work until current ready status", async () => {
    const human = await connectHuman("human-checking", "checking-human");
    const installation = await connectInstallation(human.welcome.self.id, "checking-agent");
    const workFrames: any[] = [];
    installation.client.ws.on("message", (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === "work_available") workFrames.push(event);
    });

    await postMention(human, "checking-agent", "wait for readiness");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(workFrames.length, 0);
    assert.equal(env.runnerRuntime.summary(installation.actorId, 1).health, "checking");

    hello(installation.client);
    status(installation.client, 1);
    const available = await installation.client.next((event) => event.type === "work_available");
    assert.equal(available.requestIds.length, 1);
    status(installation.client, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(workFrames.length, 1);
    assert.equal(env.runnerRuntime.summary(installation.actorId, 1).health, "ready");
  });

  test("stale revisions cannot re-enable work after a config patch", async () => {
    const human = await connectHuman("human-patch", "patch-human");
    const installation = await connectInstallation(human.welcome.self.id, "patch-agent");
    hello(installation.client);
    status(installation.client, 1);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const response = await fetch(`${env.baseUrl}/api/agents/${installation.inviteId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${human.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "claude-opus" }),
    });
    assert.equal(response.status, 200);
    const config = await installation.client.next(
      (event) => event.type === "agent_config" && event.profile.configRevision === 2,
    );
    assert.equal(config.profile.requestedModel, "claude-opus");
    assert.equal(env.runnerRuntime.summary(installation.actorId, 2).health, "checking");

    const message = await postMention(human, "patch-agent", "new revision");
    const [request] = await env.db.sql<{ id: string }[]>`
      SELECT id FROM agent_run_requests WHERE message_id = ${message.message.id}
    `;
    status(installation.client, 1);
    await assert.rejects(
      installation.client.next(
        (event) => event.type === "work_available" && event.requestIds.includes(request.id),
        100,
      ),
    );
    status(installation.client, 2, "degraded");
    const available = await installation.client.next(
      (event) => event.type === "work_available" && event.requestIds.includes(request.id),
    );
    assert.deepEqual(available.requestIds, [request.id]);
  });

  test("protocol and harness mismatches remain incompatible and cannot claim", async () => {
    const human = await connectHuman("human-mismatch", "mismatch-human");
    const installation = await connectInstallation(human.welcome.self.id, "mismatch-agent");
    const message = await postMention(human, "mismatch-agent", "must not run");
    const [request] = await env.db.sql<{ id: string }[]>`
      SELECT id FROM agent_run_requests WHERE message_id = ${message.message.id}
    `;

    hello(installation.client, "codex");
    status(installation.client, 1);
    installation.client.ws.send(JSON.stringify({ type: "work_claim", requestIds: [request.id] }));
    const harnessError = await installation.client.next(
      (event) => event.type === "error" && event.error === "runner is not ready",
    );
    assert.equal(harnessError.error, "runner is not ready");
    assert.deepEqual(env.runnerRuntime.summary(installation.actorId, 1).diagnosticCode, "HARNESS_MISMATCH");

    hello(installation.client, "claude", RUNNER_PROTOCOL_VERSION + 1);
    installation.client.ws.send(JSON.stringify({ type: "status_set", status: "protocol barrier" }));
    await human.next(
      (event) =>
        event.type === "presence_sync" &&
        event.participants.some(
          (participant: { id: string; status: string }) =>
            participant.id === installation.actorId && participant.status === "protocol barrier",
        ),
    );
    assert.deepEqual(env.runnerRuntime.summary(installation.actorId, 1).diagnosticCode, "PROTOCOL_UNSUPPORTED");
  });

  test("disconnect and revoke clear runtime facts and API summaries expose no local or secret fields", async () => {
    const human = await connectHuman("human-runtime", "runtime-human");
    const installation = await connectInstallation(human.welcome.self.id, "runtime-agent");
    hello(installation.client);
    status(installation.client, 1);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const listed = await fetch(`${env.baseUrl}/api/agents`, {
      headers: { Authorization: `Bearer ${human.token}` },
    });
    const body = await listed.json();
    const runtime = body.agents[0].runtime;
    assert.equal(runtime.connected, true);
    assert.equal(runtime.health, "ready");
    assert.equal(runtime.harness.id, "claude");
    assert.equal(JSON.stringify(runtime).includes("token"), false);
    assert.equal(JSON.stringify(runtime).includes("localPath"), false);
    assert.equal(JSON.stringify(runtime).includes("env"), false);

    installation.client.ws.terminate();
    await human.next(
      (event) =>
        event.type === "presence_sync" &&
        event.participants.some(
          (participant: { id: string; online: boolean }) =>
            participant.id === installation.actorId && !participant.online,
        ),
    );
    assert.equal(env.runnerRuntime.summary(installation.actorId, 1).connected, false);

    env.runnerRuntime.connect((await env.agentInvites.findByActorId(installation.actorId))!);
    await fetch(`${env.baseUrl}/api/agents/${installation.inviteId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${human.token}` },
    });
    assert.equal(env.runnerRuntime.summary(installation.actorId, 1).connected, false);
  });

  test("global agents remain immediately eligible for work", async () => {
    const human = await connectHuman("human-global", "global-human");
    const joined = await env.join({
      type: "join",
      kind: "agent",
      name: "noodle",
      authToken: "global-agent-token",
    });
    assert.ok(joined.client);
    await postMention(human, "noodle", "legacy compatibility");
    const available = await joined.client.next((event) => event.type === "work_available");
    assert.equal(available.requestIds.length, 1);
  });
});

describe("agent invite mention access", () => {
  test("workspace, creator, and selected policies authorize only their intended humans", async () => {
    const creator = await connectHuman("policy-creator", "policy-creator-name");
    const selected = await connectHuman("policy-selected", "policy-selected-name");
    const other = await connectHuman("policy-other", "policy-other-name");
    const creatorActor = (await env.db.getActor(creator.welcome.self.id))!;
    const workspace = await env.agentInvites.create("workspace-policy-agent", "claude", creatorActor);
    const creatorOnly = await env.agentInvites.create("creator-policy-agent", "claude", creatorActor, {
      instructions: "",
      requestedModel: null,
      access: { mode: "creator", selectedActorIds: [] },
    });
    const selectedOnly = await env.agentInvites.create("selected-policy-agent", "claude", creatorActor, {
      instructions: "",
      requestedModel: null,
      access: { mode: "selected", selectedActorIds: [selected.welcome.self.id] },
    });

    assert.equal(await env.agentInvites.allowsAuthor(workspace.invite.actorId, other.welcome.self.id), true);
    assert.equal(await env.agentInvites.allowsAuthor(creatorOnly.invite.actorId, creator.welcome.self.id), true);
    assert.equal(await env.agentInvites.allowsAuthor(creatorOnly.invite.actorId, other.welcome.self.id), false);
    assert.equal(await env.agentInvites.allowsAuthor(selectedOnly.invite.actorId, selected.welcome.self.id), true);
    assert.equal(await env.agentInvites.allowsAuthor(selectedOnly.invite.actorId, other.welcome.self.id), false);
  });

  test("unauthorized mentions remain chat while selected humans queue authoritative work", async () => {
    const creator = await connectHuman("human-creator", "access-creator");
    const selected = await connectHuman("human-selected", "access-selected");
    const outsider = await connectHuman("human-outsider", "access-outsider");
    const installation = await connectInstallation(creator.welcome.self.id, "selected-agent", {
      mode: "selected",
      selectedActorIds: [selected.welcome.self.id],
    });

    const denied = await postMention(outsider, "selected-agent", "ordinary chat");
    assert.deepEqual(denied.message.mentions, []);
    const [{ count: deniedCount }] = await env.db.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM agent_run_requests WHERE message_id = ${denied.message.id}
    `;
    assert.equal(deniedCount, 0);

    const allowed = await postMention(selected, "selected-agent", "authorized work");
    assert.deepEqual(allowed.message.mentions, [installation.actorId]);
    const [{ count: allowedCount }] = await env.db.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM agent_run_requests WHERE message_id = ${allowed.message.id}
    `;
    assert.equal(allowedCount, 1);
  });
});
