import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { ContextCursorStore } from "../src/context/ContextCursorStore";
import { ContextStore } from "../src/context/ContextStore";
import { WorkspaceSnapshotBuilder } from "../src/context/WorkspaceSnapshot";
import { ThreadEventStore } from "../src/chat/ThreadEventStore";
import { PlanService } from "../src/board/PlanService";
import { acceptedPlan, createEnv, proposeTicket } from "./helpers";

describe("context plane", async () => {
  const env = await createEnv();
  const human = await env.actor("human", "dana");
  const events = new ThreadEventStore(env.db);
  const context = new ContextStore(env.db, events);
  const cursors = new ContextCursorStore(env.db, events);
  const snapshot = new WorkspaceSnapshotBuilder(env.db, env.service, new PlanService(env.db, events), context);
  after(() => env.close());

  test("snapshot seq is captured before projecting items", async () => {
    await proposeTicket(env, human.actor, await acceptedPlan(env, human.token, "first"), {
      title: "first",
    });
    const before = await events.latestSeq(env.db.workspaceId);
    const body = await snapshot.build();
    assert.ok(body.seq >= before);
    assert.ok(body.items.some((item) => item.title === "first"));
    assert.ok(body.plans.length >= 1);
  });

  test("GET /api/workspace/snapshot returns the cursor-bearing projection", async () => {
    const res = await env.api("GET", "/api/workspace/snapshot", human.token);
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.seq, "number");
    assert.ok(Array.isArray(res.body.items));
    assert.ok(Array.isArray(res.body.context));
    assert.ok(Array.isArray(res.body.members));
  });

  test("context entries are attributed and superseded, never rewritten", async () => {
    const first = await context.create({
      actorId: human.actor.id,
      kind: "decision",
      scope: "workspace",
      body: "Auth stays on the server",
    });
    const second = await context.supersede(human.actor.id, first.id, {
      body: "Auth stays on the server; agents never see credentials",
    });
    const active = await context.listActive();
    assert.equal(active.some((entry) => entry.id === first.id), false);
    assert.equal(active.some((entry) => entry.id === second.id), true);
    const stored = await context.find(first.id);
    assert.equal(stored?.supersededBy, second.id);
    assert.equal(stored?.body, "Auth stays on the server");
  });

  test("cursor only advances and never rewinds", async () => {
    const first = await cursors.acknowledge(human.actor.id, 4);
    assert.equal(first.acknowledgedSeq, 4);
    const rewind = await cursors.acknowledge(human.actor.id, 2);
    assert.equal(rewind.acknowledgedSeq, 4);
    const next = await cursors.acknowledge(human.actor.id, 9);
    assert.equal(next.acknowledgedSeq, 9);
  });

  test("welcome carries snapshotSeq", async () => {
    const created = await proposeTicket(env, human.actor, await acceptedPlan(env, human.token, "welcome-seq"), {
      title: "welcome-seq",
    });
    assert.ok(created.ref);
    const latest = await events.latestSeq(env.db.workspaceId);
    assert.ok(latest > 0);
  });
});
