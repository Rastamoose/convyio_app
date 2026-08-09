import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { createWsEnv } from "./helpers";

describe("message pinning", async () => {
  test("humans pin and unpin; pins broadcast, persist, and survive rejoin", async () => {
    const env = await createWsEnv();
    const dana = await env.connect("dana", "human");
    const erik = await env.connect("erik", "human");

    dana.ws.send(JSON.stringify({ type: "message", content: "ship friday" }));
    const posted = await erik.next((e) => e.type === "message");
    const messageId = posted.message.id;

    // Pin: everyone gets the updated message with pinner attribution.
    erik.ws.send(JSON.stringify({ type: "pin", messageId, pinned: true }));
    const pinned = await dana.next((e) => e.type === "message_updated");
    assert.equal(pinned.message.id, messageId);
    assert.equal(pinned.message.pinnedBy, "erik");
    assert.ok(pinned.message.pinnedAt > 0);
    assert.equal(pinned.message.content, "ship friday");

    // The pin is in history for a fresh join.
    const fran = await env.connect("fran", "human");
    const inHistory = fran.welcome.history.find((m: any) => m.id === messageId);
    assert.equal(inHistory.pinnedBy, "erik");

    // Unpin clears both fields everywhere.
    dana.ws.send(JSON.stringify({ type: "pin", messageId, pinned: false }));
    const unpinned = await erik.next(
      (e) => e.type === "message_updated" && !e.message.pinnedAt,
    );
    assert.equal(unpinned.message.pinnedAt, undefined);
    assert.equal(unpinned.message.pinnedBy, undefined);
    assert.equal((await env.messages.list())[0].pinnedAt, undefined);

    await env.close();
  });

  test("agents cannot pin: mutations outside the toolman are refused", async () => {
    const env = await createWsEnv();
    const dana = await env.connect("dana", "human");
    const agent = await env.connect("noodle", "agent");

    dana.ws.send(JSON.stringify({ type: "message", content: "tempting" }));
    const posted = await dana.next((e) => e.type === "message");

    agent.ws.send(
      JSON.stringify({ type: "pin", messageId: posted.message.id, pinned: true }),
    );
    const refusal = await agent.next((e) => e.type === "error");
    assert.equal(refusal.error, "human-only event");
    assert.equal((await env.messages.list())[0].pinnedAt, undefined);

    await env.close();
  });

  test("pinning an unknown message → error frame", async () => {
    const env = await createWsEnv();
    const dana = await env.connect("dana", "human");

    const ghost = randomUUID();
    dana.ws.send(JSON.stringify({ type: "pin", messageId: ghost, pinned: true }));
    const refusal = await dana.next((e) => e.type === "error");
    assert.equal(refusal.error, `unknown message: ${ghost}`);

    await env.close();
  });
});
