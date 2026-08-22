import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, describe, test } from "node:test";
import { createEnv, createWsEnv } from "./helpers";

const PROVIDER = "claude";
process.env.AGENT_SECRET_KEY ??= randomBytes(32).toString("base64");

async function exchange(baseUrl: string, pairingCode: string) {
  const response = await fetch(`${baseUrl}/api/agent-pairings/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairingCode }),
  });
  return { status: response.status, body: await response.json() };
}

describe("agent HTTP invites", async () => {
  const env = await createEnv();
  after(() => env.close());

  test("humans can create, list and revoke agent invites", async () => {
    const human = await env.actor("human", "dana");
    const create = await env.api("POST", "/api/agents", human.token, { name: "helper", provider: PROVIDER });
    assert.equal(create.status, 201, create.body.message);
    assert.equal(create.body.name, "helper");
    assert.equal(create.body.provider, PROVIDER);
    assert.equal(typeof create.body.token, "string");
    assert.equal(create.body.token.length, 64);

    const list = await env.api("GET", "/api/agents", human.token);
    assert.equal(list.status, 200);
    assert.equal(list.body.agents.length, 1);
    assert.equal(list.body.agents[0].id, create.body.id);

    const revoke = await env.api("DELETE", `/api/agents/${create.body.id}`, human.token);
    assert.equal(revoke.status, 200);

    const list2 = await env.api("GET", "/api/agents", human.token);
    assert.equal(list2.body.agents.length, 0);
  });

  test("new profiles have bounded defaults and list responses contain no secrets", async () => {
    const human = await env.actor("human", "profile-owner");
    const created = await env.api("POST", "/api/agents", human.token, {
      name: "default-profile",
      provider: PROVIDER,
    });
    assert.equal(created.status, 201, created.body.message);
    assert.equal(created.body.instructions, "");
    assert.equal(created.body.requestedModel, null);
    assert.deepEqual(created.body.access, { mode: "workspace", selectedActorIds: [] });
    assert.equal(created.body.configRevision, 1);
    assert.equal(created.body.pairing.expiresAt - created.body.pairing.createdAt, 10 * 60 * 1000);
    assert.equal(created.body.token.length, 64);
    assert.equal(created.body.pairingCode.length, 64);

    const listed = await env.api("GET", "/api/agents", human.token);
    const profile = listed.body.agents.find((agent: { id: string }) => agent.id === created.body.id);
    assert.ok(profile);
    const serialized = JSON.stringify(profile);
    assert.equal(serialized.includes(created.body.token), false);
    assert.equal(serialized.includes(created.body.pairingCode), false);
    assert.equal("token" in profile, false);
    assert.equal("pairingCode" in profile, false);

    const [inviteSecret] = await env.db.sql<{ token_hash: string }[]>`
      SELECT token_hash FROM agent_invites WHERE id = ${created.body.id}
    `;
    const [pairingSecret] = await env.db.sql<{ token_hash: string }[]>`
      SELECT token_hash FROM agent_pairings WHERE id = ${created.body.pairing.id}
    `;
    assert.notEqual(inviteSecret.token_hash, created.body.token);
    assert.notEqual(pairingSecret.token_hash, created.body.pairingCode);
  });

  test("profile validation and updates increment revision exactly once", async () => {
    const human = await env.actor("human", "profile-editor");
    const tooLong = await env.api("POST", "/api/agents", human.token, {
      name: "invalid-profile",
      provider: PROVIDER,
      instructions: "x".repeat(20001),
    });
    assert.equal(tooLong.status, 400);

    const created = await env.api("POST", "/api/agents", human.token, {
      name: "editable-profile",
      provider: PROVIDER,
    });
    const invalidAccess = await env.api("PATCH", `/api/agents/${created.body.id}`, human.token, {
      access: { mode: "selected", selectedActorIds: [] },
    });
    assert.equal(invalidAccess.status, 400);
    assert.equal(invalidAccess.body.error, "BAD_ACCESS");

    const patched = await env.api("PATCH", `/api/agents/${created.body.id}`, human.token, {
      instructions: "Follow workspace policy.",
      model: "claude-sonnet",
      access: { mode: "creator", selectedActorIds: [] },
      createdBy: "body-must-not-win",
      actorId: "body-must-not-win",
    });
    assert.equal(patched.status, 200, patched.body.message);
    assert.equal(patched.body.instructions, "Follow workspace policy.");
    assert.equal(patched.body.requestedModel, "claude-sonnet");
    assert.deepEqual(patched.body.access, { mode: "creator", selectedActorIds: [] });
    assert.equal(patched.body.configRevision, 2);
    assert.equal(patched.body.createdBy, human.actor.id);
    assert.equal(patched.body.actorId, created.body.actorId);
  });

  test("selected access accepts human members and rejects agents and nonmembers", async () => {
    const owner = await env.actor("human", "access-owner");
    const member = await env.db.createHuman("selected-member-id", "selected-member", "member@example.com");
    const nonmember = await env.actor("human", "selected-nonmember");
    const agent = await env.actor("agent", "selected-agent-member");
    const created = await env.api("POST", "/api/agents", owner.token, {
      name: "access-profile",
      provider: PROVIDER,
    });

    const valid = await env.api("PATCH", `/api/agents/${created.body.id}`, owner.token, {
      access: { mode: "selected", selectedActorIds: [member.id] },
    });
    assert.equal(valid.status, 200, valid.body.message);
    assert.deepEqual(valid.body.access.selectedActorIds, [member.id]);

    for (const actorId of [nonmember.actor.id, agent.actor.id]) {
      const invalid = await env.api("PATCH", `/api/agents/${created.body.id}`, owner.token, {
        access: { mode: "selected", selectedActorIds: [actorId] },
      });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error, "BAD_ACCESS");
    }
  });

  test("pairings expire, are replaced, and can only be exchanged once under a race", async () => {
    const human = await env.actor("human", "pairing-owner");
    const created = await env.api("POST", "/api/agents", human.token, {
      name: "pairing-agent",
      provider: PROVIDER,
    });
    const replacement = await env.api(
      "POST",
      `/api/agents/${created.body.id}/pairings`,
      human.token,
    );
    assert.equal(replacement.status, 201);
    assert.equal((await exchange(env.baseUrl, created.body.pairingCode)).status, 401);

    const raced = await Promise.all([
      exchange(env.baseUrl, replacement.body.pairingCode),
      exchange(env.baseUrl, replacement.body.pairingCode),
    ]);
    assert.deepEqual(raced.map((result) => result.status).sort(), [200, 401]);
    const success = raced.find((result) => result.status === 200)!;
    assert.equal(success.body.installationToken.length, 64);
    assert.equal(success.body.agent.id, created.body.id);
    assert.equal(success.body.workspace.id, env.db.workspaceId);
    assert.equal(success.body.apiUrl, env.baseUrl);
    assert.equal(success.body.wsUrl, `${env.baseUrl.replace("http", "ws")}/ws/${env.db.workspaceId}`);
    const [installationCount] = await env.db.sql<{ count: number }[]>`
      SELECT count(*) AS count FROM agent_installations WHERE invite_id = ${created.body.id}
    `;
    assert.equal(installationCount.count, 1);
    const [stored] = await env.db.sql<{ token_hash: string }[]>`
      SELECT token_hash FROM agent_installations WHERE id = ${success.body.installation.id}
    `;
    assert.notEqual(stored.token_hash, success.body.installationToken);
  });

  test("mintInstallation issues a fresh installation without a pairing code", async () => {
    const human = await env.actor("human", "mint-owner");
    const created = await env.api("POST", "/api/agents", human.token, {
      name: "mint-agent",
      provider: PROVIDER,
    });
    const { AgentInvites } = await import("../src/auth/AgentInvites");
    const invites = new AgentInvites(env.db);
    const minted = await invites.mintInstallation(created.body.id);
    assert.ok(minted);
    assert.equal(minted!.invite.id, created.body.id);
    assert.equal(minted!.installationToken.length, 64);
    const [installationCount] = await env.db.sql<{ count: number }[]>`
      SELECT count(*) AS count FROM agent_installations WHERE invite_id = ${created.body.id}
    `;
    assert.equal(installationCount.count, 1);
  });

  test("mintInstallation returns null for a revoked invite", async () => {
    const human = await env.actor("human", "mint-revoked-owner");
    const created = await env.api("POST", "/api/agents", human.token, {
      name: "mint-revoked-agent",
      provider: PROVIDER,
    });
    await env.api("DELETE", `/api/agents/${created.body.id}`, human.token);
    const { AgentInvites } = await import("../src/auth/AgentInvites");
    const invites = new AgentInvites(env.db);
    const minted = await invites.mintInstallation(created.body.id);
    assert.equal(minted, null);
  });

  test("create() can store an encrypted API key, never returned by list/get", async () => {
    const human = await env.actor("human", "keyed-owner");
    const { AgentInvites } = await import("../src/auth/AgentInvites");
    const invites = new AgentInvites(env.db);
    const { invite } = await invites.create(
      "keyed-agent",
      "openai",
      human.actor,
      { instructions: "", requestedModel: null, access: { mode: "workspace", selectedActorIds: [] } },
      "fake-ciphertext",
    );
    const serialized = JSON.stringify(invite);
    assert.equal(serialized.includes("fake-ciphertext"), false);
    const [row] = await env.db.sql<{ api_key_ciphertext: string | null }[]>`
      SELECT api_key_ciphertext FROM agent_invites WHERE id = ${invite.id}
    `;
    assert.equal(row.api_key_ciphertext, "fake-ciphertext");
  });

  test("listOpenAiWithKeys returns only openai invites with a stored key", async () => {
    const human = await env.actor("human", "list-keys-owner");
    const { AgentInvites } = await import("../src/auth/AgentInvites");
    const invites = new AgentInvites(env.db);
    const withKey = await invites.create(
      "with-key",
      "openai",
      human.actor,
      { instructions: "", requestedModel: null, access: { mode: "workspace", selectedActorIds: [] } },
      "ciphertext-a",
    );
    const withoutKey = await invites.create("without-key", "openai", human.actor);
    await invites.create("claude-agent", "claude", human.actor);
    const listed = await invites.listOpenAiWithKeys();
    const ids = listed.map((entry) => entry.invite.id);
    assert.ok(ids.includes(withKey.invite.id));
    assert.equal(ids.includes(withoutKey.invite.id), false);
    const entry = listed.find((candidate) => candidate.invite.id === withKey.invite.id);
    assert.equal(entry!.apiKeyCiphertext, "ciphertext-a");
  });

  test("a machine can forget only its own installation credential", async () => {
    const human = await env.actor("human", "unpair-owner");
    const created = await env.api("POST", "/api/agents", human.token, {
      name: "unpair-agent",
      provider: PROVIDER,
    });
    const exchanged = await exchange(env.baseUrl, created.body.pairingCode);
    assert.equal(exchanged.status, 200);
    const token = exchanged.body.installationToken as string;

    const missing = await fetch(`${env.baseUrl}/api/agent-installations`, { method: "DELETE" });
    assert.equal(missing.status, 401);
    const wrong = await fetch(`${env.baseUrl}/api/agent-installations`, {
      method: "DELETE",
      headers: { Authorization: "Bearer not-an-installation" },
    });
    assert.equal(wrong.status, 401);
    const humanAttempt = await fetch(`${env.baseUrl}/api/agent-installations`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${human.token}` },
    });
    assert.equal(humanAttempt.status, 401);

    const ok = await fetch(`${env.baseUrl}/api/agent-installations`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(ok.status, 200);
    const [count] = await env.db.sql<{ count: number }[]>`
      SELECT count(*) AS count FROM agent_installations WHERE invite_id = ${created.body.id}
    `;
    assert.equal(count.count, 0);
    const again = await fetch(`${env.baseUrl}/api/agent-installations`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(again.status, 401);
    assert.equal(await env.db.isMember(created.body.actorId), true);
  });

  test("expired and agent-revoked pairings are rejected", async () => {
    const human = await env.actor("human", "pairing-revoker");
    const expired = await env.api("POST", "/api/agents", human.token, {
      name: "expired-pairing",
      provider: PROVIDER,
    });
    await env.db.sql`
      UPDATE agent_pairings SET expires_at = ${Date.now() - 1} WHERE id = ${expired.body.pairing.id}
    `;
    assert.equal((await exchange(env.baseUrl, expired.body.pairingCode)).status, 401);

    const revoked = await env.api("POST", "/api/agents", human.token, {
      name: "revoked-pairing",
      provider: PROVIDER,
    });
    await env.api("DELETE", `/api/agents/${revoked.body.id}`, human.token);
    assert.equal((await exchange(env.baseUrl, revoked.body.pairingCode)).status, 401);
  });

  test("the profile credential tables have deny-all RLS enabled", async () => {
    const rows = await env.db.sql<{ relname: string; relrowsecurity: boolean }[]>`
      SELECT relname, relrowsecurity
      FROM pg_class
      WHERE oid IN ('agent_pairings'::regclass, 'agent_installations'::regclass)
      ORDER BY relname
    `;
    assert.deepEqual(Array.from(rows), [
      { relname: "agent_installations", relrowsecurity: true },
      { relname: "agent_pairings", relrowsecurity: true },
    ]);
  });

  test("agent names must be unique", async () => {
    const human = await env.actor("human", "harris");
    const first = await env.api("POST", "/api/agents", human.token, { name: "twin", provider: PROVIDER });
    assert.equal(first.status, 201);
    const second = await env.api("POST", "/api/agents", human.token, { name: "twin", provider: PROVIDER });
    assert.equal(second.status, 409);
  });

  test("agent names cannot be noodle", async () => {
    const human = await env.actor("human", "name-owner");
    const reserved = await env.api("POST", "/api/agents", human.token, { name: "noodle", provider: PROVIDER });
    assert.equal(reserved.status, 409);
    assert.equal(reserved.body.error, "NAME_RESERVED");
  });

  test("agent names cannot match a human member", async () => {
    const human = await env.actor("human", "dana");
    await env.db.sql`
      INSERT INTO workspace_members (workspace_id, actor_id, role, joined_at)
      VALUES (${env.db.workspaceId}, ${human.actor.id}, 'member', ${Date.now()})
    `;
    const conflict = await env.api("POST", "/api/agents", human.token, { name: "dana", provider: PROVIDER });
    assert.equal(conflict.status, 409);
  });

  test("only humans can create agents", async () => {
    const human = await env.actor("human", "harris");
    const mule = await env.actor("agent", "mule");

    const attempt = await env.api("POST", "/api/agents", mule.token, { name: "another", provider: PROVIDER });
    assert.equal(attempt.status, 403);
  });

  test("unknown invite cannot be revoked", async () => {
    const human = await env.actor("human", "harris");
    const res = await env.api("DELETE", "/api/agents/not-a-uuid", human.token);
    assert.equal(res.status, 404);
  });

  test("revoking an agent frees its name for a brand-new agent identity", async () => {
    const human = await env.actor("human", "priya");
    const first = await env.api("POST", "/api/agents", human.token, { name: "clone", provider: PROVIDER });
    assert.equal(first.status, 201);
    assert.equal(await env.db.isMember(first.body.actorId), true);

    const revoke = await env.api("DELETE", `/api/agents/${first.body.id}`, human.token);
    assert.equal(revoke.status, 200);
    // The agent has no existence outside the workspace: once removed, it
    // is no longer a member (unlike a removed human, whose actor row
    // stays a global identity even if this workspace's membership ends).
    assert.equal(await env.db.isMember(first.body.actorId), false);

    const second = await env.api("POST", "/api/agents", human.token, { name: "clone", provider: PROVIDER });
    assert.equal(second.status, 201, second.body.message);
    // A genuinely new identity, not a resurrection of the old one.
    assert.notEqual(second.body.actorId, first.body.actorId);
  });
});

describe("agent invite websocket joins", async () => {
  const env = await createWsEnv({ auth: { users: {} } });
  after(() => env.close());

  test("a user-created agent can join with its invite token", async () => {
    const humanActor = await env.db.upsertActor("human", "harris");
    const { token } = await env.agentInvites.create("claude-1", "claude", humanActor);

    const joined = await env.join({ type: "join", kind: "agent", authToken: token, name: "ignored" });
    assert.equal(joined.welcome?.self.name, "claude-1");
    assert.equal(joined.welcome?.self.kind, "agent");
    assert.equal(joined.error, null);
    assert.equal(joined.closed, false);
  });

  test("a revoked token is rejected", async () => {
    const humanActor = await env.db.upsertActor("human", "harris");
    const { invite, token } = await env.agentInvites.create("claude-2", "claude", humanActor);
    await env.agentInvites.revoke(invite.id);

    const joined = await env.join({ type: "join", kind: "agent", authToken: token, name: "ignored" });
    assert.equal(joined.welcome, null);
    assert.equal(joined.error, "unauthenticated");
    assert.equal(joined.closed, true);
  });

  test("an exchanged durable installation credential joins as its stored agent", async () => {
    const humanActor = await env.db.upsertActor("human", "installer");
    const { invite } = await env.agentInvites.create("installed-agent", "codex", humanActor, {
      instructions: "Use the stored profile.",
      requestedModel: null,
      access: { mode: "creator", selectedActorIds: [] },
    });
    const pairing = await env.agentInvites.createPairing(invite.id, humanActor);
    assert.ok(pairing);
    const installed = await env.agentInvites.exchangePairing(pairing.pairingCode);
    assert.ok(installed);

    const joined = await env.join({
      type: "join",
      kind: "agent",
      authToken: installed.installationToken,
      name: "spoofed-name",
    });
    assert.equal(joined.welcome?.self.id, invite.actorId);
    assert.equal(joined.welcome?.self.name, "installed-agent");
    assert.equal(joined.error, null);

    await env.agentInvites.revoke(invite.id);
    const rejected = await env.join({
      type: "join",
      kind: "agent",
      authToken: installed.installationToken,
      name: "installed-agent",
    });
    assert.equal(rejected.welcome, null);
    assert.equal(rejected.error, "unauthenticated");
  });
});

describe("global agent token", async () => {
  const globalToken = "global-secret";
  const env = await createWsEnv({ auth: { users: {}, agentToken: globalToken } });
  after(() => env.close());

  test("global AGENT_TOKEN still works", async () => {
    const joined = await env.join({ type: "join", kind: "agent", authToken: globalToken, name: "noodle" });
    assert.equal(joined.welcome?.self.name, "noodle");
    assert.equal(joined.welcome?.self.managedAgent, "noodle");
    assert.equal(joined.error, null);
  });

  test("AGENT_TOKEN cannot invent a name or restore a removed noodle", async () => {
    const spoofed = await env.join({ type: "join", kind: "agent", authToken: globalToken, name: "impostor" });
    assert.equal(spoofed.welcome, null);

    const [noodle] = await env.db.sql<{ id: string }[]>`
      SELECT id FROM actors WHERE managed_agent = 'noodle'
    `;
    await env.db.removeMember(noodle.id);
    const removed = await env.join({ type: "join", kind: "agent", authToken: globalToken, name: "noodle" });
    assert.equal(removed.welcome, null);
  });
});

describe("hosted agent workspace manifest", async () => {
  const token = "hosted-secret";
  const env = await createEnv({ hostedAgentToken: token });
  after(() => env.close());

  test("AGENT_TOKEN lists workspaces that still have noodle as a member", async () => {
    const refused = await fetch(`${env.baseUrl}/api/hosted-agent/workspaces`);
    assert.equal(refused.status, 401);

    const listed = await fetch(`${env.baseUrl}/api/hosted-agent/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as { workspaces: Array<{ id: string; actorId: string; wsUrl: string }> };
    assert.equal(body.workspaces.length, 1);
    assert.equal(body.workspaces[0].id, env.db.workspaceId);
    assert.match(body.workspaces[0].wsUrl, /\/ws\//);

    const [noodle] = await env.db.sql<{ id: string }[]>`SELECT id FROM actors WHERE managed_agent = 'noodle'`;
    await env.db.removeMember(noodle.id);
    const empty = await fetch(`${env.baseUrl}/api/hosted-agent/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const emptyBody = (await empty.json()) as { workspaces: unknown[] };
    assert.equal(emptyBody.workspaces.length, 0);
  });
});

describe("hosted OpenAI agents (paste a key, no local pairing)", async () => {
  test("a valid key creates the agent, stores it encrypted, and starts it — no pairing code returned", async () => {
    const started: Array<{ actorId: string; apiKey: string }> = [];
    const env = await createEnv({
      onCreateAgent: (invite, apiKey) => started.push({ actorId: invite.actorId, apiKey }),
      validateOpenAiKey: async () => true,
    });
    try {
      const human = await env.actor("human", "hosted-owner");
      const created = await env.api("POST", "/api/agents", human.token, {
        name: "hosted-agent",
        provider: "openai",
        apiKey: "sk-valid-key",
      });
      assert.equal(created.status, 201, created.body.message);
      assert.equal("pairingCode" in created.body, false);
      assert.equal(started.length, 1);
      assert.equal(started[0]!.actorId, created.body.actorId);
      assert.equal(started[0]!.apiKey, "sk-valid-key");

      const [row] = await env.db.sql<{ api_key_ciphertext: string | null }[]>`
        SELECT api_key_ciphertext FROM agent_invites WHERE id = ${created.body.id}
      `;
      assert.ok(row.api_key_ciphertext);
      assert.notEqual(row.api_key_ciphertext, "sk-valid-key");

      const list = await env.api("GET", "/api/agents", human.token);
      const serialized = JSON.stringify(list.body);
      assert.equal(serialized.includes("sk-valid-key"), false);
      assert.equal(serialized.includes(row.api_key_ciphertext!), false);
    } finally {
      await env.close();
    }
  });

  test("an invalid key is rejected and no agent is created", async () => {
    const started: unknown[] = [];
    const env = await createEnv({
      onCreateAgent: (invite, apiKey) => started.push({ invite, apiKey }),
      validateOpenAiKey: async () => false,
    });
    try {
      const human = await env.actor("human", "hosted-bad-key-owner");
      const created = await env.api("POST", "/api/agents", human.token, {
        name: "hosted-bad-key-agent",
        provider: "openai",
        apiKey: "sk-bad-key",
      });
      assert.equal(created.status, 400);
      assert.equal(created.body.error, "INVALID_API_KEY");
      assert.equal(started.length, 0);
      const list = await env.api("GET", "/api/agents", human.token);
      assert.equal(list.body.agents.length, 0);
    } finally {
      await env.close();
    }
  });

  test("an openai agent created without an apiKey falls back to the normal pairing flow", async () => {
    const started: unknown[] = [];
    const env = await createEnv({ onCreateAgent: (invite, apiKey) => started.push({ invite, apiKey }) });
    try {
      const human = await env.actor("human", "no-key-owner");
      const created = await env.api("POST", "/api/agents", human.token, {
        name: "no-key-agent",
        provider: "openai",
      });
      assert.equal(created.status, 201, created.body.message);
      assert.equal(typeof created.body.pairingCode, "string");
      assert.equal(started.length, 0);
    } finally {
      await env.close();
    }
  });
});
