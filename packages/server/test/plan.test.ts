import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { emptyImpactMap } from "@workspace/shared";
import { createEnv } from "./helpers";

function acceptableImpact() {
  const map = emptyImpactMap();
  map.server = "affected";
  map.notes.server = "PlanService is new coordination only";
  return map;
}

describe("plan lifecycle", async () => {
  const env = await createEnv();
  const human = await env.actor("human", "dana");
  const agent = await env.actor("agent", "noodle");
  after(() => env.close());

  test("agent and human can create a proposed plan; acceptance is human-only and grants no work", async () => {
    const created = await env.api("POST", "/api/board/plans", agent.token, {
      title: "Workspace workflow",
      objective: "Humans and agents share one planning record",
      outline: ["Classify work", "Accept the plan", "Create the next ticket later"],
      clarifications: ["Confirmed this is megaplan work, not a one-file edit"],
      impactMap: acceptableImpact(),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.plan.status, "proposed");
    assert.match(created.body.plan.ref, /^plan-\d+$/);

    const denied = await env.api("POST", `/api/board/plans/${created.body.plan.id}/accept`, agent.token);
    assert.equal(denied.status, 403);

    const accepted = await env.api("POST", `/api/board/plans/${created.body.plan.id}/accept`, human.token);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.plan.status, "accepted");
    assert.equal(accepted.body.plan.acceptedBy, human.actor.id);

    const snapshot = await env.api("GET", "/api/workspace/snapshot", human.token);
    assert.equal(snapshot.status, 200);
    assert.ok(snapshot.body.plans.some((plan: { id: string }) => plan.id === created.body.plan.id));
    assert.ok(created.body.plan.originChannelId);
    const events = await env.threadEvents.list({
      workspaceId: env.db.workspaceId,
      channelId: created.body.plan.originChannelId,
      limit: 20,
    });
    assert.ok(events.some((event) => event.kind === "plan.created" || event.kind === "plan.proposed"));
  });

  test("acceptance requires clarification and a complete impact map", async () => {
    const created = await env.api("POST", "/api/board/plans", agent.token, {
      title: "Incomplete",
      objective: "Should not accept",
      outline: ["Do something"],
    });
    assert.equal(created.status, 201);
    const rejected = await env.api("POST", `/api/board/plans/${created.body.plan.id}/accept`, human.token);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error, "CLARIFICATION_REQUIRED");
  });

  test("accepted plans are append-only for discoveries", async () => {
    const created = await env.api("POST", "/api/board/plans", human.token, {
      title: "Record decisions",
      objective: "Keep objective stable",
      outline: ["Accept", "Append"],
      clarifications: ["Asked whether this replaces an existing plan; it does not"],
      impactMap: acceptableImpact(),
    });
    await env.api("POST", `/api/board/plans/${created.body.plan.id}/accept`, human.token);
    const appended = await env.api("POST", `/api/board/plans/${created.body.plan.id}/decisions`, human.token, {
      decision: "Tickets still need their own approval",
    });
    assert.equal(appended.status, 200);
    assert.ok(appended.body.plan.decisions.includes("Tickets still need their own approval"));
  });

  test("adding a constraint changes the same plan and writes attributed context", async () => {
    const created = await env.api("POST", "/api/board/plans", agent.token, {
      title: "Billing",
      objective: "Align invoice surfaces",
      outline: ["Inspect", "Change invoice only"],
      clarifications: ["Asked whether the ledger may change"],
      impactMap: acceptableImpact(),
    });
    const constrained = await env.api("POST", `/api/board/plans/${created.body.plan.id}/constraints`, human.token, {
      constraint: "Ledger output must remain identical to existing Stripe charges",
    });
    assert.equal(constrained.status, 200);
    assert.ok(constrained.body.plan.constraints.includes("Ledger output must remain identical to existing Stripe charges"));
    assert.ok((constrained.body.plan.changeLog ?? []).some((change: { field: string }) => change.field === "constraints"));
    const channel = await env.channels.get("general");
    assert.ok(channel);
    const accessRequest = await env.resourceAccess.request(agent.actor, {
      resourceKind: "channel",
      resourceId: channel.id,
      reason: "Continue the billing plan",
    });
    await env.resourceAccess.resolve(human.actor, accessRequest.id, "approved");
    const envelope = await env.api("GET", "/api/workspace/prompt-envelope", agent.token);
    assert.match(JSON.stringify(envelope.body.envelope), /Ledger output must remain identical/);
  });
});
