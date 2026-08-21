import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { loadDemoScripts } from "../src/demo/script";
import { DemoOrchestrator } from "../src/demo/DemoOrchestrator";
import { createWsEnv } from "./helpers";

describe("walkthrough demo", async () => {
  const env = await createWsEnv();
  const scriptsDir = path.resolve(import.meta.dirname, "../assets/demo/scripts");
  const scripts = await loadDemoScripts(scriptsDir);
  const seedRoot = path.resolve(import.meta.dirname, "../assets/demo/seed");

  const orchestrator = new DemoOrchestrator(
    env.hub,
    env.roster,
    env.db,
    env.service,
    env.plans,
    env.toolman,
    env.workspaceDir,
    seedRoot,
    new Map([["demo", scripts.get("demo")!]]),
    0,
  );

  await env.channels.seed([{ name: "demo", isDemo: true }]);

  test("shared two-agent incident demo runs to completion with plan constraint and ticket evidence", async () => {
    const human = await env.db.upsertActor("human", "maya");

    const progress = (stage: string, message?: string) =>
      new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 10_000;
        const check = () => {
          const p = orchestrator.progress("demo");
          if (p.stage === stage && (!message || p.message.includes(message))) return resolve();
          if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${stage}: ${p.stage} (${p.message})`));
          setTimeout(check, 20);
        };
        check();
      });

    let planRef: string | undefined;
    let ticketRef: string | undefined;

    const planEventHandler = env.plans.onEvent;
    env.plans.onEvent = (event) => {
      if (event.type === "plan.created" || event.type === "plan.proposed") {
        planRef = event.plan.ref;
      }
      // Forward to hub so orchestrator sees accepted events too.
      env.hub.broadcastPlanEvent(event);
      if (planEventHandler) planEventHandler(event);
    };

    const boardEventHandler = env.service.onEvent;
    env.service.onEvent = (event) => {
      if (event.type === "item.proposed") {
        ticketRef = event.item.ref;
      }
      env.hub.broadcastBoardEvent(event);
      if (boardEventHandler) boardEventHandler(event);
    };

    env.hub.onDemoStart?.("demo", "walkthrough", human.id);

    await progress("waiting_continue", "Both founders");
    const firstChapter = (await env.messages.list()).filter((message) => message.channel === "demo");
    const noodleMessage = firstChapter.find((message) => message.authorName === "noodle");
    assert.ok(noodleMessage?.content.includes("Sentry spike"));
    assert.ok(firstChapter.some((message) => message.authorName === "maya" && message.content.includes("@noodle")));
    env.hub.onDemoControl?.("demo", "continue", human.id);

    await progress("waiting_continue", "Two independently owned agents");
    assert.ok(planRef, "plan was proposed after both agents contributed");
    const sharedAnalysis = (await env.messages.list()).filter((message) => message.channel === "demo");
    const hermesMessage = sharedAnalysis.find((message) => message.authorName === "hermes");
    assert.ok(hermesMessage?.content.includes("@noodle"));
    assert.ok(sharedAnalysis.some((message) => message.authorName === "tom" && message.content.includes("@hermes")));
    assert.ok(sharedAnalysis.some((message) => message.authorName === "noodle" && message.content.includes("@hermes")));
    env.hub.onDemoControl?.("demo", "continue", human.id);

    await progress("waiting_accept_plan");
    assert.equal(orchestrator.progress("demo").focus?.kind, "plan_accept");
    const planBeforeAccept = await env.plans.find(env.db.workspaceId, planRef);
    assert.ok(planBeforeAccept?.constraints.some((c) => c.includes("ledger-sync.ts")), "ledger constraint was added");
    await env.plans.accept(human, planRef);

    await progress("waiting_continue", "Ticket defines responsibility");
    assert.equal(orchestrator.progress("demo").focus?.kind, "guide");
    assert.ok(ticketRef, "ticket was proposed");
    env.hub.onDemoControl?.("demo", "continue", human.id);

    await progress("waiting_approve_ticket");
    assert.equal(orchestrator.progress("demo").focus?.kind, "ticket_approve");
    const ticketBeforeApprove = await env.service.find(env.db.workspaceId, ticketRef);
    assert.equal(ticketBeforeApprove?.status, "proposed");
    assert.deepEqual(ticketBeforeApprove?.scopePaths, ["billing/"]);
    await env.service.approve(human, ticketRef);

    await progress("waiting_continue", "outcome is reviewable");
    assert.equal(orchestrator.progress("demo").focus?.kind, "result");
    env.hub.onDemoControl?.("demo", "continue", human.id);
    await progress("completed");

    const ticket = await env.service.find(env.db.workspaceId, ticketRef);
    assert.equal(ticket?.status, "done");
    assert.ok(ticket?.verificationEvidence, "result has verification evidence");
    assert.match(ticket?.verificationEvidence ?? "", /PASS/);

    // Files were written into the workspace sandbox and ledger was left untouched.
    const billingDir = path.join(env.workspaceDir, "billing");
    assert.ok(fs.existsSync(path.join(billingDir, "totals.ts")), "totals.ts was written");
    const ledger = fs.readFileSync(path.join(billingDir, "ledger-sync.ts"), "utf8");
    assert.ok(ledger.includes("roundMoney"), "ledger-sync.ts preserved");
  });

  test("demo can be skipped", async () => {
    const human = await env.db.upsertActor("human", "alex");
    env.hub.onDemoStart?.("demo", "walkthrough", human.id);
    await new Promise((resolve) => setTimeout(resolve, 200));
    env.hub.onDemoControl?.("demo", "skip", human.id);
    const p = orchestrator.progress("demo");
    assert.equal(p.stage, "idle");
  });

  after(async () => await env.close());
});
