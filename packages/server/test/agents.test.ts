import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { createEnv, createWsEnv } from "./helpers";

const PROVIDER = "claude";

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

  test("agent names must be unique", async () => {
    const human = await env.actor("human", "harris");
    const first = await env.api("POST", "/api/agents", human.token, { name: "twin", provider: PROVIDER });
    assert.equal(first.status, 201);
    const second = await env.api("POST", "/api/agents", human.token, { name: "twin", provider: PROVIDER });
    assert.equal(second.status, 409);
  });

  test("agent names cannot match a human", async () => {
    const human = await env.actor("human", "dana");
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
});

describe("global agent token", async () => {
  const globalToken = "global-secret";
  const env = await createWsEnv({ auth: { users: {}, agentToken: globalToken } });
  after(() => env.close());

  test("global AGENT_TOKEN still works", async () => {
    const joined = await env.join({ type: "join", kind: "agent", authToken: globalToken, name: "noodle" });
    assert.equal(joined.welcome?.self.name, "noodle");
    assert.equal(joined.error, null);
  });
});
