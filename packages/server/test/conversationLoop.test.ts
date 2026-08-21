import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { authorizeMutation } from "../src/board/Toolman";
import { Toolman } from "../src/board/Toolman";
import { acceptedPlan, createEnv } from "./helpers";

describe("conversation-native work loop", async () => {
  const env = await createEnv();
  const human = await env.actor("human", "tom");
  const agent = await env.actor("agent", "noodle");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "convyio-loop-"));
  const toolman = new Toolman(env.service, root);
  await toolman.init();
  after(async () => {
    await env.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  test("constraint changes the same plan, reaches the agent envelope, and returns evidence on the origin thread", async () => {
    await fs.writeFile(path.join(root, "invoice.ts"), "export const total = 10.1;\n");
    await fs.writeFile(path.join(root, "ledger.ts"), "export const stripeCharge = 10.10;\n");

    const created = await env.api("POST", "/api/board/plans", agent.token, {
      title: "Align billing totals",
      objective: "Invoice, PDF and ledger surfaces must stop disagreeing",
      outline: ["Inspect the three surfaces", "Normalize invoice and PDF rounding"],
      clarifications: ["Asked whether the ledger may be renormalized"],
      constraints: ["Do not invent a new currency conversion path"],
      channel: "general",
      assumedOwnerId: agent.actor.id,
      impactMap: {
        protocol: "na",
        server: "affected",
        client: "na",
        agent: "na",
        database: "na",
        security: "na",
        deploy: "na",
        tests: "affected",
        demos: "na",
        docs: "na",
        notes: { server: "Invoice render only", tests: "Keep ledger fixtures" },
      },
    });
    assert.equal(created.status, 201);
    assert.ok(created.body.plan.originChannelId);
    assert.equal(created.body.plan.originEventId != null, true);

    const constrained = await env.api("POST", `/api/board/plans/${created.body.plan.id}/constraints`, human.token, {
      constraint: "Ledger output must remain identical to existing Stripe charges",
    });
    assert.equal(constrained.status, 200);
    assert.ok(constrained.body.plan.constraints.includes("Ledger output must remain identical to existing Stripe charges"));
    assert.ok((constrained.body.plan.changeLog ?? []).some((change: { summary: string }) =>
      change.summary.includes("Changed before execution"),
    ));

    const accepted = await env.api("POST", `/api/board/plans/${created.body.plan.id}/accept`, human.token);
    assert.equal(accepted.status, 200);

    const ticket = await env.api("POST", "/api/board/items", agent.token, {
      title: "Fix invoice render",
      why: "Invoice and PDF disagree",
      effect: "Invoice and PDF agree; ledger stays identical",
      planId: created.body.plan.id,
      owner: agent.actor.id,
      channel: "general",
      scopePaths: ["invoice.ts"],
      acceptanceCriteria: ["Invoice and PDF agree", "Ledger fixtures remain unchanged"],
    });
    assert.equal(ticket.status, 201);
    assert.deepEqual(ticket.body.item.impactMap, accepted.body.plan.impactMap);
    assert.ok(ticket.body.item.originChannelId);
    assert.equal(ticket.body.item.originChannelId, created.body.plan.originChannelId);

    const channel = await env.channels.get("general");
    assert.ok(channel);
    const accessRequest = await env.resourceAccess.request(agent.actor, {
      resourceKind: "channel",
      resourceId: channel.id,
      reason: "Continue the approved billing conversation",
    });
    await env.resourceAccess.resolve(human.actor, accessRequest.id, "approved");
    const envelope = await env.api("GET", "/api/workspace/prompt-envelope", agent.token);
    assert.equal(envelope.status, 200);
    const body = envelope.body.envelope;
    assert.ok(body.plans.some((plan: { constraints: string[]; assumedOwnerName?: string }) =>
      plan.constraints.includes("Ledger output must remain identical to existing Stripe charges") &&
      plan.assumedOwnerName === "noodle",
    ));
    assert.ok(body.tickets.some((item: { ownerName?: string }) => item.ownerName === "noodle"));
    assert.ok(body.context.some((entry: { body: string }) => entry.body.includes("Ledger output must remain identical")));

    const approved = await env.api("POST", `/api/board/items/${ticket.body.item.id}/approve`, human.token, {
      owner: agent.actor.id,
    });
    assert.equal(approved.status, 200);

    await env.service.start(agent.actor, ticket.body.item.id);
    const denied = await authorizeMutation(
      agent.actor,
      ticket.body.item.ref,
      { name: "write_file", path: "ledger.ts" },
      env.service,
    );
    assert.equal(denied.allow, false);
    const allowed = await authorizeMutation(
      agent.actor,
      ticket.body.item.ref,
      { name: "write_file", path: "invoice.ts" },
      env.service,
    );
    assert.equal(allowed.allow, true);
    const written = await toolman.execute(agent.actor, {
      kind: "write_file",
      path: "invoice.ts",
      content: "export const total = 10.10;\n",
    }, ticket.body.item.ref);
    assert.equal(written.ok, true);
    assert.equal(await fs.readFile(path.join(root, "ledger.ts"), "utf8"), "export const stripeCharge = 10.10;\n");

    const done = await env.service.complete(
      agent.actor,
      ticket.body.item.id,
      "Invoice total now matches the PDF. Ledger fixtures were left unchanged.",
    );
    assert.equal(done.status, "done");
    assert.match(done.verificationEvidence ?? "", /Ledger fixtures were left unchanged/);

    const events = await env.threadEvents.list({
      workspaceId: env.db.workspaceId,
      channelId: created.body.plan.originChannelId,
      limit: 50,
    });
    const kinds = events.map((event) => event.kind);
    assert.ok(kinds.includes("plan.created") || kinds.includes("plan.proposed"));
    assert.ok(kinds.includes("plan.edited"));
    assert.ok(kinds.includes("plan.accepted"));
    assert.ok(kinds.includes("item.proposed"));
    assert.ok(kinds.includes("item.approved"));
    assert.ok(kinds.includes("item.completed"));
    assert.ok(events.some((event) => event.kind === "context.created"));
  });

  test("acceptedPlan helper still produces origin-backed plans", async () => {
    const planId = await acceptedPlan(env, human.token, "helper-origin");
    const found = await env.api("GET", `/api/board/plans/${planId}`, human.token);
    assert.equal(found.status, 200);
    assert.ok(found.body.plan.originChannelId);
  });
});
