import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { createEnv, createWsEnv } from "./helpers";

describe("workspace membership removal", async () => {
  const env = await createEnv();
  after(() => env.close());

  // A plain human actor (env.actor/upsertActor) is an identity, not a
  // member (see db.test.ts); removal only makes sense against a real
  // member, so tests here register one via createHuman.
  const registeredHuman = (name: string) => env.db.createHuman(randomUUID(), name, null);

  test("a human can remove another human from the workspace", async () => {
    const remover = await registeredHuman("priya");
    const removerToken = env.sessions.issue(remover.id);
    const target = await registeredHuman("quinn");

    const res = await env.api("DELETE", `/api/actors/${target.id}`, removerToken);
    assert.equal(res.status, 200);
    assert.equal(await env.db.isMember(target.id), false);
    // The actor row survives removal for message/board attribution.
    assert.ok(await env.db.getActor(target.id));
  });

  test("agents cannot be targeted here — they keep their invite-revoke flow", async () => {
    const remover = await env.actor("human", "rae");
    const agent = await env.actor("agent", "shipbot");

    const res = await env.api("DELETE", `/api/actors/${agent.actor.id}`, remover.token);
    assert.equal(res.status, 404);
    assert.equal(await env.db.isMember(agent.actor.id), true);
  });

  test("a human cannot remove themselves", async () => {
    const self = await env.actor("human", "sam");
    const res = await env.api("DELETE", `/api/actors/${self.actor.id}`, self.token);
    assert.equal(res.status, 400);
  });

  test("an agent cannot remove anyone", async () => {
    const agent = await env.actor("agent", "toolbot");
    const target = await env.actor("human", "uma");
    const res = await env.api("DELETE", `/api/actors/${target.actor.id}`, agent.token);
    assert.equal(res.status, 403);
  });

  test("removing an unknown or already-removed member is 404", async () => {
    const remover = await env.actor("human", "vik");
    const missing = await env.api("DELETE", "/api/actors/00000000-0000-0000-0000-000000000000", remover.token);
    assert.equal(missing.status, 404);

    const target = await registeredHuman("wren");
    const first = await env.api("DELETE", `/api/actors/${target.id}`, remover.token);
    assert.equal(first.status, 200);
    const again = await env.api("DELETE", `/api/actors/${target.id}`, remover.token);
    assert.equal(again.status, 404);
  });
});

describe("workspace membership removal evicts a live connection", async () => {
  const env = await createWsEnv();
  after(() => env.close());

  test("removing a human closes its socket and drops it from the roster", async () => {
    const remover = await env.db.upsertActor("human", "xena");
    const removerToken = env.sessions.issue(remover.id);
    // Guest-mode join reuses an existing actor by name (upsertActor), so
    // registering membership first, then connecting, yields a live human
    // participant who is also an actual workspace member.
    await env.db.createHuman(randomUUID(), "yara", null);
    const target = await env.connect("yara", "human");

    const res = await fetch(`${env.baseUrl}/api/actors/${target.welcome.self.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${removerToken}` },
    });
    assert.equal(res.status, 200);

    // The removed connection gets an error frame then is closed — once
    // closed it can never see the presence_sync fan-out that follows, so
    // roster removal is checked from a fresh join instead.
    await target.next((e) => e.type === "error" && e.error === "removed from workspace");

    const observer = await env.connect("zeph", "human");
    assert.ok(!observer.welcome.participants.some((p: any) => p.name === "yara"));
  });
});
