import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import type { Actor } from "@workspace/shared";
import { BoardService } from "../src/board/BoardService";
import { PlanService } from "../src/board/PlanService";
import { Toolman } from "../src/board/Toolman";
import { ThreadEventStore } from "../src/chat/ThreadEventStore";
import { acceptedPlan, createEnv, PROPOSAL, proposeTicket } from "./helpers";
import { createTestDb } from "./pgSchema";

describe("pressure: HTTP edges", async () => {
  const env = await createEnv();
  const human = await env.actor("human", "dana");
  const agent = await env.actor("agent", "noodle");
  after(() => env.close());

  test("malformed JSON body → 400", async () => {
    const res = await env.api("POST", "/api/board/items", human.token, undefined, "{nope");
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "BAD_JSON");
  });

  test("oversized body → 413", async () => {
    const res = await env.api("POST", "/api/board/items", human.token, {
      title: "big",
      description: "x".repeat(300 * 1024),
    });
    assert.equal(res.status, 413);
  });

  test("title over 200 chars → 400", async () => {
    const res = await env.api("POST", "/api/board/items", human.token, { title: "x".repeat(201) });
    assert.equal(res.status, 400);
  });

  test("bad/missing token → 401", async () => {
    const res = await env.api("GET", "/api/board/items", "not-a-token");
    assert.equal(res.status, 401);
    const res2 = await fetch(`${env.baseUrl}/api/board/items`, { method: "POST" });
    assert.equal(res2.status, 401);
  });

  test("invalid status filter → 400; explicit denied filter returns denied", async () => {
    const bad = await env.api("GET", "/api/board/items?status=sprint", human.token);
    assert.equal(bad.status, 400);
    const item = await proposeTicket(env, agent.actor, await acceptedPlan(env, human.token, "denied"), {
      owner: agent.actor.id,
    });
    await env.service.deny(human.actor, item.id);
    const denied = await env.api("GET", "/api/board/items?status=denied", human.token);
    assert.equal(denied.status, 200);
    assert.ok(denied.body.items.some((i: any) => i.id === item.id));
  });

  test("unknown routes and methods → 404/405", async () => {
    assert.equal((await env.api("GET", "/api/nope", human.token)).status, 404);
    assert.equal((await env.api("PUT", "/api/board/items/xyz", human.token, {})).status, 405);
    assert.equal((await env.api("POST", "/api/board/items/xyz/promote", human.token, {})).status, 404);
  });

  test("actions on unknown item → 404", async () => {
    const res = await env.api("POST", "/api/board/items/task-999/approve", human.token);
    assert.equal(res.status, 404);
  });

  test("PATCH with unknown owner → 400 OWNER_NOT_FOUND; valid owner sticks; null clears", async () => {
    const { body: created } = await env.api("POST", "/api/board/items", human.token, {
      ...PROPOSAL,
      title: "ownable",
      planId: await acceptedPlan(env, human.token, "ownable"),
      owner: agent.actor.id,
    });
    const bad = await env.api("PATCH", `/api/board/items/${created.item.id}`, human.token, {
      owner: randomUUID(),
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "OWNER_NOT_FOUND");
    const ok = await env.api("PATCH", `/api/board/items/${created.item.id}`, human.token, {
      owner: agent.actor.id,
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.item.ownerName, "noodle");
    const cleared = await env.api("PATCH", `/api/board/items/${created.item.id}`, human.token, {
      owner: null,
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.item.owner, null);
  });

  test("no-op PATCH emits no event", async () => {
    const { body: created } = await env.api("POST", "/api/board/items", human.token, {
      ...PROPOSAL,
      title: "static",
      planId: await acceptedPlan(env, human.token, "static"),
      owner: agent.actor.id,
    });
    env.envelopes.length = 0;
    const res = await env.api("PATCH", `/api/board/items/${created.item.id}`, human.token, {
      title: "static",
    });
    assert.equal(res.status, 200);
    assert.equal(env.envelopes.length, 0);
  });

  test("double-approve race: exactly one 200 and one 409", async () => {
    const { body: created } = await env.api("POST", "/api/board/items", agent.token, {
      ...PROPOSAL,
      planId: await acceptedPlan(env, human.token, "double-approve"),
      owner: agent.actor.id,
    });
    const [a, b] = await Promise.all([
      env.api("POST", `/api/board/items/${created.item.id}/approve`, human.token, { owner: agent.actor.id }),
      env.api("POST", `/api/board/items/${created.item.id}/approve`, human.token, { owner: agent.actor.id }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  });

  test("approve/deny race: one wins, item ends in the winner's state", async () => {
    const { body: created } = await env.api("POST", "/api/board/items", agent.token, {
      ...PROPOSAL,
      planId: await acceptedPlan(env, human.token, "approve-deny"),
      owner: agent.actor.id,
    });
    const [a, b] = await Promise.all([
      env.api("POST", `/api/board/items/${created.item.id}/approve`, human.token, { owner: agent.actor.id }),
      env.api("POST", `/api/board/items/${created.item.id}/deny`, human.token),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const item = (await env.service.find(env.db.workspaceId, created.item.id))!;
    assert.ok(["approved", "denied"].includes(item.status));
  });

  test("full lifecycle including reopen", async () => {
    const { body: created } = await env.api("POST", "/api/board/items", human.token, {
      ...PROPOSAL,
      title: "cycle",
      planId: await acceptedPlan(env, human.token, "cycle"),
      owner: agent.actor.id,
    });
    const id = created.item.id;
    await env.api("POST", `/api/board/items/${id}/approve`, human.token, { owner: agent.actor.id });
    assert.equal((await env.api("POST", `/api/board/items/${id}/block`, agent.token, { reason: "r" })).status, 409);
    assert.equal((await env.api("POST", `/api/board/items/${id}/start`, agent.token)).status, 200);
    assert.equal((await env.api("POST", `/api/board/items/${id}/block`, agent.token, { reason: "waiting" })).status, 200);
    assert.equal((await env.api("POST", `/api/board/items/${id}/unblock`, agent.token)).status, 200);
    assert.equal((await env.api("POST", `/api/board/items/${id}/complete`, agent.token, { evidence: "tests pass" })).status, 200);
    const reopenAgent = await env.api("POST", `/api/board/items/${id}/reopen`, agent.token);
    assert.equal(reopenAgent.status, 403);
    const reopened = await env.api("POST", `/api/board/items/${id}/reopen`, human.token);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.item.status, "approved");
    assert.equal(reopened.body.item.completedAt, null);
    // Owner survives the round trip and the item is workable again.
    assert.equal((await env.api("POST", `/api/board/items/${id}/start`, agent.token)).status, 200);
  });

  test("events endpoint returns the full ordered audit trail", async () => {
    const { body: created } = await env.api("POST", "/api/board/items", agent.token, {
      ...PROPOSAL,
      planId: await acceptedPlan(env, human.token, "events"),
      owner: agent.actor.id,
    });
    const id = created.item.id;
    await env.api("POST", `/api/board/items/${id}/approve`, human.token, { owner: agent.actor.id });
    await env.api("POST", `/api/board/items/${id}/start`, agent.token);
    await env.api("POST", `/api/board/items/${id}/complete`, agent.token, { evidence: "tests pass" });
    const res = await env.api("GET", `/api/board/items/${id}/events`, human.token);
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.events.map((e: any) => e.type),
      ["item.proposed", "item.approved", "item.started", "item.completed"],
    );
    assert.equal(res.body.events[1].actorName, "dana");
  });

  test("actors endpoint lists workspace members only", async () => {
    // dana came through upsertActor (guest identity, not registered);
    // noodle is an agent (auto-registered); signup registers a human.
    const registered = await env.db.createHuman(randomUUID(), "member-mia", "mia@example.com");
    const res = await env.api("GET", "/api/actors", human.token);
    assert.equal(res.status, 200);
    const names = res.body.actors.map((a: any) => a.displayName);
    assert.ok(names.includes("noodle"));
    assert.ok(names.includes(registered.displayName));
    assert.ok(!names.includes("dana"));
  });

  test("operating on a deleted item → 409 everywhere", async () => {
    const { body: created } = await env.api("POST", "/api/board/items", human.token, {
      ...PROPOSAL,
      title: "gone",
      planId: await acceptedPlan(env, human.token, "gone"),
      owner: agent.actor.id,
    });
    await env.api("DELETE", `/api/board/items/${created.item.id}`, human.token);
    for (const action of ["start", "complete", "reopen"]) {
      const res = await env.api("POST", `/api/board/items/${created.item.id}/${action}`, human.token);
      assert.equal(res.status, 409, `${action} on deleted item`);
    }
    const patch = await env.api("PATCH", `/api/board/items/${created.item.id}`, human.token, { title: "back" });
    assert.equal(patch.status, 409);
    const del = await env.api("DELETE", `/api/board/items/${created.item.id}`, human.token);
    assert.equal(del.status, 409);
  });
});

describe("pressure: toolman sandbox", async () => {
  const { db, drop } = await createTestDb();
  const threadEvents = new ThreadEventStore(db);
  const plans = new PlanService(db, threadEvents);
  const service = new BoardService(db, threadEvents, plans);
  const root = path.join("/tmp", `toolman-pressure-${randomUUID()}`);
  const toolman = new Toolman(service, root);
  await toolman.init();
  const human = await db.upsertActor("human", "dana");
  const agent = await db.upsertActor("agent", "noodle");
  const plan = await plans.create(human, {
    title: "sandbox",
    objective: "sandbox work",
    outline: ["Write files"],
    clarifications: ["fixture"],
    impactMap: PROPOSAL.impactMap,
  });
  await plans.accept(human, plan.id);
  const item = await service.create(human, {
    ...PROPOSAL,
    title: "sandbox work",
    planId: plan.id,
    owner: agent.id,
  });
  await service.approve(human, item.id, agent.id);
  after(async () => {
    await drop();
    await fs.rm(root, { recursive: true, force: true });
  });

  test("path traversal variants all refused", async () => {
    for (const p of ["../escape.txt", "../../etc/passwd", "a/../../escape.txt", "/etc/passwd"]) {
      const res = await toolman.execute(agent, { kind: "write_file", path: p, content: "x" }, item.ref);
      assert.equal(res.ok, false, `path ${p} must be refused`);
    }
  });

  test("nested writes inside the sandbox work", async () => {
    const res = await toolman.execute(
      agent,
      { kind: "write_file", path: "deep/nested/dir/file.txt", content: "hello" },
      item.ref,
    );
    assert.equal(res.ok, true);
    const read = await toolman.execute(agent, { kind: "read_file", path: "deep/nested/dir/file.txt" }, null);
    assert.equal(read.output, "hello");
  });

  test("read of missing file is a clean error, not a crash", async () => {
    const res = await toolman.execute(agent, { kind: "read_file", path: "missing.txt" }, null);
    assert.equal(res.ok, false);
    assert.ok(res.error);
  });

  test("humans are never gated by the board", async () => {
    const res = await toolman.execute(human, { kind: "write_file", path: "human.txt", content: "y" }, null);
    assert.equal(res.ok, true);
  });

  test("agent write against wrong-workspace item → ITEM_WRONG_SERVER shape holds", async () => {
    // Same DB is single-workspace; simulate by faking the agent's workspace id.
    const foreign: Actor = { ...agent, workspaceId: randomUUID() };
    const res = await toolman.execute(foreign, { kind: "write_file", path: "f.txt", content: "z" }, item.ref);
    assert.equal(res.ok, false);
    assert.equal(res.code, "ITEM_WRONG_SERVER");
  });
});
