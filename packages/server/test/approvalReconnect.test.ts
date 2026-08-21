import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { emptyImpactMap } from "@workspace/shared";
import { createWsEnv } from "./helpers";

const PROPOSAL = {
  title: "T",
  why: "test",
  effect: "test",
  scopePaths: ["out.md"],
  acceptanceCriteria: ["done"],
  impactMap: emptyImpactMap(),
};

describe("approval survives agent reconnect", async () => {
  const env = await createWsEnv();
  after(async () => await env.close());

  test("action_result reaches a reconnecting agent after approval", async () => {
    const human = await env.connect("dana", "human");
    const agent = await env.connect("noodle", "agent");

    const humanActor = await env.db.upsertActor("human", "dana");
    const agentActor = await env.db.upsertActor("agent", "noodle");

    const plan = await env.plans.create(humanActor, {
      title: "Plan",
      objective: "Test",
      outline: ["Propose", "Approve"],
      clarifications: ["fixture"],
      impactMap: PROPOSAL.impactMap,
    });
    await env.plans.accept(humanActor, plan.ref);

    const proposed = await env.service.create(agentActor, {
      ...PROPOSAL,
      planId: plan.id,
      owner: agentActor.id,
    });
    await human.next((e) => e.type === "item.proposed" && e.item.id === proposed.id);
    await env.service.approve(humanActor, proposed.ref, agentActor.id);

    // Agent sends a mutating action and the server pauses on human approval.
    const requestId = randomUUID();
    agent.ws.send(JSON.stringify({
      type: "action_request",
      requestId,
      boardItemRef: proposed.ref,
      action: { kind: "write_file", path: "out.md", content: "x" },
    }));
    const prompt = await human.next((e) => e.type === "interaction_request");

    // Simulate an agent reconnect before the human answers.
    agent.ws.terminate();
    await new Promise((r) => setTimeout(r, 200));
    const agent2 = await env.connect("noodle", "agent");

    // Human approves from the same UI.
    human.ws.send(JSON.stringify({
      type: "interaction_resolve",
      requestId: prompt.request.id,
      decision: "approve",
    }));

    // The reconnected agent must receive the action result so it can resume.
    const allowed = await agent2.next((e) => e.type === "action_result" && e.requestId === requestId, 3000);
    assert.equal(allowed.ok, true);

    agent2.ws.terminate();
    human.ws.terminate();
  });
});
