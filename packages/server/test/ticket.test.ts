import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { acceptedPlan, createEnv, PROPOSAL, proposeTicket } from "./helpers";
import { authorizeMutation } from "../src/board/Toolman";

describe("ticket lifecycle", async () => {
  const env = await createEnv();
  const human = await env.actor("human", "dana");
  const owner = await env.actor("agent", "noodle");
  const other = await env.actor("agent", "pepper");
  after(() => env.close());

  test("human and agent tickets both start proposed", async () => {
    const planId = await acceptedPlan(env, human.token, "proposed-both");
    const humanTicket = await env.api("POST", "/api/board/items", human.token, {
      ...PROPOSAL,
      title: "Human ticket",
      planId,
      owner: owner.actor.id,
    });
    assert.equal(humanTicket.status, 201);
    assert.equal(humanTicket.body.item.status, "proposed");
    assert.equal(humanTicket.body.item.approvedBy, null);
  });

  test("approval is human-only and requires owner, criteria, and impact", async () => {
    const incomplete = await env.api("POST", "/api/board/items", owner.token, {
      ...PROPOSAL,
      planId: await acceptedPlan(env, human.token, "incomplete"),
      acceptanceCriteria: [],
      impactMap: undefined,
    });
    assert.equal(incomplete.status, 201);
    const missing = await env.api("POST", `/api/board/items/${incomplete.body.item.id}/approve`, human.token);
    assert.equal(missing.status, 400);

    const ready = await env.api("POST", "/api/board/items", owner.token, {
      ...PROPOSAL,
      planId: await acceptedPlan(env, human.token, "ready"),
      owner: owner.actor.id,
    });
    const agentApprove = await env.api("POST", `/api/board/items/${ready.body.item.id}/approve`, owner.token);
    assert.equal(agentApprove.status, 403);
    const approved = await env.api("POST", `/api/board/items/${ready.body.item.id}/approve`, human.token, {
      owner: owner.actor.id,
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.item.owner, owner.actor.id);
  });

  test("only the assigned owner may start, mutate, or complete", async () => {
    const item = await proposeTicket(env, owner.actor, await acceptedPlan(env, human.token, "owner"), {
      owner: owner.actor.id,
    });
    await env.service.approve(human.actor, item.id, owner.actor.id);
    await assert.rejects(
      env.service.start(other.actor, item.id),
      (err: unknown) => err instanceof Error && "code" in err && (err as { code: string }).code === "OWNER_MISMATCH",
    );
    await env.service.start(owner.actor, item.id);
    const otherMutate = await authorizeMutation(
      other.actor,
      item.ref,
      { name: "write_file", path: "out.md" },
      env.service,
    );
    assert.equal(otherMutate.allow, false);
    assert.equal(!otherMutate.allow && otherMutate.code, "OWNER_MISMATCH");
    const ownerMutate = await authorizeMutation(
      owner.actor,
      item.ref,
      { name: "write_file", path: "out.md" },
      env.service,
    );
    assert.equal(ownerMutate.allow, true);
    await assert.rejects(
      env.service.complete(owner.actor, item.id),
      (err: unknown) => err instanceof Error && "code" in err && (err as { code: string }).code === "EVIDENCE_REQUIRED",
    );
    const done = await env.service.complete(owner.actor, item.id, "tests pass");
    assert.equal(done.status, "done");
    assert.equal(done.verificationEvidence, "tests pass");
  });

  test("an accepted plan may have only one live ticket", async () => {
    const planId = await acceptedPlan(env, human.token, "one-live");
    const first = await env.api("POST", "/api/board/items", owner.token, {
      ...PROPOSAL,
      planId,
      owner: owner.actor.id,
    });
    assert.equal(first.status, 201);
    const second = await env.api("POST", "/api/board/items", owner.token, {
      ...PROPOSAL,
      title: "Second",
      planId,
      owner: owner.actor.id,
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, "LIVE_TICKET_EXISTS");
  });

  test("approving an owned ticket queues durable work for that owner only", async () => {
    const item = await proposeTicket(env, owner.actor, await acceptedPlan(env, human.token, "dispatch"), {
      owner: owner.actor.id,
    });
    const approved = await env.service.approve(human.actor, item.id, owner.actor.id);
    const channel = await env.channels.get("general");
    assert.ok(channel);
    const queued = await env.agentWork.queueApprovedTicket({
      actor: human.actor,
      owner: { id: owner.actor.id, displayName: owner.actor.displayName, kind: "agent" },
      item: { id: approved.id, ref: approved.ref, title: approved.title },
      channelId: channel.id,
      channelName: channel.name,
    });
    assert.ok(queued);
    assert.equal(queued.request.agentId, owner.actor.id);
    assert.match(queued.message.content, new RegExp(approved.ref));
    const pending = await env.agentWork.listPending(owner.actor.id);
    assert.ok(pending.some((row) => row.id === queued.request.id));
    const otherPending = await env.agentWork.listPending(other.actor.id);
    assert.equal(otherPending.length, 0);
  });
});
