import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, describe, test } from "node:test";
import type { ChatMessage } from "@workspace/shared";
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
    env.attachments,
    env.workspaceDir,
    seedRoot,
    new Map([["demo", scripts.get("demo")!]]),
    0,
  );

  await env.channels.seed([{ name: "demo", isDemo: true }]);

  test("hackathon one-pager demo runs to completion with no gates and a real permission checkpoint", async () => {
    const human = await env.db.upsertActor("human", "maya");
    const approver = await env.connect("maya-ui", "human");

    const progress = (stage: string) =>
      new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 10_000;
        const check = () => {
          const p = orchestrator.progress("demo");
          if (p.stage === stage) return resolve();
          if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${stage}: ${p.stage} (${p.message})`));
          setTimeout(check, 20);
        };
        check();
      });

    // The whole point of this script: it plays start to finish with zero
    // demoControl calls. No Board, no Plan. The one real gate is noodle's
    // opening permission checkpoint, which blocks on an actual Approve click.
    env.hub.onDemoStart?.("demo", "walkthrough", human.id);
    const noodleRequest = await approver.next(
      (e) => e.type === "interaction_request" && e.request.capability === "folder_read",
    );
    approver.ws.send(JSON.stringify({ type: "interaction_resolve", requestId: noodleRequest.request.id, decision: "approve" }));
    await progress("completed");

    const messages = (await env.messages.list()).filter((message) => message.channel === "demo");
    const byAuthor = (name: string) => messages.filter((message) => message.authorName === name);

    assert.ok(
      byAuthor("maya").some((message) => message.content.includes("@noodle") && message.content.includes("one-pager")),
      "maya asks her own agent to draft the spec",
    );
    assert.ok(
      byAuthor("tom").some((message) => message.content.includes("buzzwords")),
      "teammates banter with each other, not just with agents",
    );
    // The big-document beat: Noodle writes the shared context into one real
    // attachment instead of a wall of chat text.
    const draftMessage = byAuthor("noodle").find((message) => (message.attachments?.length ?? 0) > 0);
    assert.ok(draftMessage, "noodle posts the draft with a real attachment, not a chat wall");
    assert.ok(draftMessage!.content.includes("living brief"), "the short caption still carries the eureka line");
    const doc = draftMessage!.attachments![0];
    assert.ok(doc.mime.startsWith("text/"), "the context doc is a text file");
    assert.ok(doc.size > 1000, "the context doc is big enough to render as a file, not inline text");
    const downloaded = await env.attachments.get(doc.id);
    assert.ok(downloaded, "the attached document is actually stored and fetchable");
    const docText = await downloaded!.blob.text();
    assert.ok(docText.includes("MVP scope"), "the document carries the detail the short caption leaves out");

    // The headline beat: Maya points Tom at the doc instead of pasting it,
    // Tom asks Maya's agent for a real change, and Noodle sends back the
    // revised scope in the same thread.
    const pointer = byAuthor("maya").find((message) => message.content.includes("@tom") && message.content.includes("MVP scoping"));
    assert.ok(pointer, "maya points tom at the doc instead of forwarding it");
    const changeRequest = byAuthor("tom").find(
      (message) => message.timestamp > pointer!.timestamp && message.content.includes("@noodle") && message.content.includes("markdown"),
    );
    assert.ok(changeRequest, "tom asks noodle, someone else's agent, for a real change");
    assert.ok(
      byAuthor("noodle").some(
        (message) => message.timestamp > changeRequest!.timestamp && message.content.includes("updated") && message.content.includes("markdown"),
      ),
      "noodle sends back the revised scope in the same thread",
    );

    // Tom then hands the build to his own agent, not Maya's.
    assert.ok(
      byAuthor("tom").some((message) => message.content.includes("@hermes") && message.content.includes("doc-ingestion")),
      "tom assigns his own agent to implement",
    );
    assert.ok(
      byAuthor("hermes").some((message) => message.content.includes("permission")),
      "hermes confirms the task and asks for permission before touching anything",
    );
    assert.ok(
      byAuthor("hermes").some((message) => message.content.includes("approved") && message.content.includes("starting now")),
      "hermes starts implementing once permission is granted",
    );

    // No Board or Plan involvement at all.
    assert.equal((await env.plans.list(env.db.workspaceId)).length, 0, "no Plan is created");
    assert.equal((await env.service.list(env.db.workspaceId, {})).length, 0, "no Ticket is created");

    // The permission checkpoint is a real, resolved interaction request.
    const hermesActor = await env.db.upsertActor("agent", "hermes");
    const stillPending = await env.interactions.pendingForAgent(env.db.workspaceId, hermesActor.id);
    assert.equal(stillPending.length, 0, "hermes's permission request was resolved, not left pending");

    // Agents never address each other directly — only humans cross-mention.
    const agentMessages = messages.filter((message) => message.authorName === "noodle" || message.authorName === "hermes");
    assert.ok(
      agentMessages.every((message) => !/@(noodle|hermes)/i.test(message.content)),
      "agents never address each other directly",
    );

    // Scripted "@noodle"/"@hermes" lines must not hit the live @mention
    // pipeline: that pipeline requests channel access on the agent's behalf
    // and injects a synthetic "is waiting for a decision" reply ahead of the
    // next scripted line, wrecking both the pacing and the transcript.
    assert.equal(
      messages.filter((message) => /waiting for a decision|waiting for access/.test(message.content)).length,
      0,
      "scripted dialogue does not trigger the live agent-mention pipeline",
    );

    env.closeClients();
  });

  test("the trigger phrase starts the demo in whatever channel it's typed, without touching existing history", async () => {
    await env.channels.seed([{ name: "random", isDemo: false }]);
    const randomChannel = (await env.channels.get("random"))!;
    const seedActor = await env.db.upsertActor("human", "seed-user");
    const priorMessage: ChatMessage = {
      id: randomUUID(),
      authorId: seedActor.id,
      authorName: seedActor.displayName,
      authorKind: "human",
      content: "anyone free for lunch",
      timestamp: Date.now() - 60_000,
      channelId: randomChannel.id,
      channel: "random",
    };
    await env.messages.append(priorMessage);

    const progress = (stage: string) =>
      new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 10_000;
        const check = () => {
          const p = orchestrator.progress("random");
          if (p.stage === stage) return resolve();
          if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${stage}: ${p.stage} (${p.message})`));
          setTimeout(check, 20);
        };
        check();
      });

    const harris = await env.connect("harris", "human");
    harris.ws.send(JSON.stringify({ type: "message", content: "@noodle what's the update", channel: "random" }));
    const noodleRequest = await harris.next(
      (e) => e.type === "interaction_request" && e.request.capability === "folder_read",
    );
    harris.ws.send(JSON.stringify({ type: "interaction_resolve", requestId: noodleRequest.request.id, decision: "approve" }));
    await progress("completed");

    const messages = (await env.messages.list()).filter((message) => message.channel === "random");
    assert.ok(
      messages.some((message) => message.id === priorMessage.id),
      "the channel's real history is untouched, not wiped",
    );
    const trigger = messages.find((message) => message.authorName === "harris");
    assert.ok(trigger, "the real trigger message itself is stored and visible like any other message");
    const afterTrigger = messages.filter((message) => message.timestamp > trigger!.timestamp);
    assert.ok(
      !afterTrigger.some((message) => /waiting for a decision|waiting for access/.test(message.content)),
      "the trigger's own @noodle mention does not hit the live agent-mention pipeline",
    );
    assert.ok(
      afterTrigger.some((message) => message.authorName === "noodle" && message.content.includes("brainstormed")),
      "noodle replies to the update request first",
    );
    assert.ok(
      afterTrigger.some((message) => message.authorName === "hermes" && message.content.includes("starting now")),
      "the rest of the scripted demo plays out after the reply",
    );

    env.closeClients();
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
