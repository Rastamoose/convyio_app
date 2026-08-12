import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, test } from "node:test";
import { clientEventSchema, type ChatMessage } from "@workspace/shared";
import { createWsEnv } from "./helpers";

let env: Awaited<ReturnType<typeof createWsEnv>>;

before(async () => {
  env = await createWsEnv();
});

afterEach(async () => {
  await env.reset();
});

after(async () => {
  if (env) await env.close();
});

/** Directly appends a fabricated message, bypassing the hub, so tests can
 *  control created_at exactly (including deliberate ties) without racing
 *  Date.now() resolution. */
async function seedMessage(
  env: Awaited<ReturnType<typeof createWsEnv>>,
  channel: string,
  content: string,
  timestamp: number,
): Promise<ChatMessage> {
  const message: ChatMessage = {
    id: randomUUID(),
    authorId: "seed-author",
    authorName: "seed",
    authorKind: "human",
    content,
    timestamp,
    channel,
  };
  await env.messages.append(message);
  return message;
}

describe("message editing", () => {

  test("author edits: content + editedAt broadcast, persist, and survive rejoin", async () => {
    const dana = await env.connect("dana", "human");
    const erik = await env.connect("erik", "human");

    dana.ws.send(JSON.stringify({ type: "message", content: "ship friday" }));
    const posted = await erik.next((e) => e.type === "message");
    const messageId = posted.message.id;

    dana.ws.send(JSON.stringify({ type: "message_edit", messageId, content: "ship monday" }));
    const updated = await erik.next((e) => e.type === "message_updated");
    assert.equal(updated.message.id, messageId);
    assert.equal(updated.message.content, "ship monday");
    assert.ok(updated.message.editedAt > 0);

    // The edit is in history for a fresh join.
    const fran = await env.connect("fran", "human");
    const inHistory = fran.welcome.history.find((m: any) => m.id === messageId);
    assert.equal(inHistory.content, "ship monday");
    assert.ok(inHistory.editedAt > 0);

  });

  test("only the author may edit", async () => {
    const dana = await env.connect("dana", "human");
    const erik = await env.connect("erik", "human");

    dana.ws.send(JSON.stringify({ type: "message", content: "mine" }));
    const posted = await erik.next((e) => e.type === "message");

    erik.ws.send(
      JSON.stringify({ type: "message_edit", messageId: posted.message.id, content: "hijacked" }),
    );
    const refusal = await erik.next((e) => e.type === "error");
    assert.equal(refusal.error, "not the message author");
    assert.equal((await env.messages.list())[0].content, "mine");
    assert.equal((await env.messages.list())[0].editedAt, undefined);

  });

  test("editing an unknown message → error frame", async () => {
    const dana = await env.connect("dana", "human");

    const ghost = randomUUID();
    dana.ws.send(JSON.stringify({ type: "message_edit", messageId: ghost, content: "boo" }));
    const refusal = await dana.next((e) => e.type === "error");
    assert.equal(refusal.error, `unknown message: ${ghost}`);
  });

});

describe("message deletion", () => {
  test("author deletes: message_deleted broadcast, row and reactions gone", async () => {
    const dana = await env.connect("dana", "human");
    const erik = await env.connect("erik", "human");

    dana.ws.send(JSON.stringify({ type: "message", content: "oops" }));
    const posted = await erik.next((e) => e.type === "message");
    const messageId = posted.message.id;

    // A reaction, so the delete has a cascade to prove.
    erik.ws.send(JSON.stringify({ type: "message_react", messageId, emoji: "👀", op: "add" }));
    await dana.next((e) => e.type === "message_updated");

    // Non-author refused first.
    erik.ws.send(JSON.stringify({ type: "message_delete", messageId }));
    const refusal = await erik.next((e) => e.type === "error");
    assert.equal(refusal.error, "not the message author");
    assert.equal((await env.messages.list()).length, 1);

    dana.ws.send(JSON.stringify({ type: "message_delete", messageId }));
    const deleted = await erik.next((e) => e.type === "message_deleted");
    assert.equal(deleted.messageId, messageId);
    assert.equal(deleted.channel, "general");
    assert.equal((await env.messages.list()).length, 0);
    const [orphans] = await env.db.sql<{ n: number }[]>`SELECT COUNT(*) AS n FROM message_reactions`;
    assert.equal(orphans.n, 0);

  });

  test("deleting an unknown message → error frame", async () => {
    const dana = await env.connect("dana", "human");

    const ghost = randomUUID();
    dana.ws.send(JSON.stringify({ type: "message_delete", messageId: ghost }));
    const refusal = await dana.next((e) => e.type === "error");
    assert.equal(refusal.error, `unknown message: ${ghost}`);
  });

});

describe("replies", () => {
  test("replyToId broadcasts, persists, and survives rejoin", async () => {
    const dana = await env.connect("dana", "human");
    const erik = await env.connect("erik", "human");

    dana.ws.send(JSON.stringify({ type: "message", content: "root" }));
    const root = await erik.next((e) => e.type === "message");

    erik.ws.send(
      JSON.stringify({ type: "message", content: "reply", replyToId: root.message.id }),
    );
    const reply = await dana.next((e) => e.type === "message" && e.message.content === "reply");
    assert.equal(reply.message.replyToId, root.message.id);

    const fran = await env.connect("fran", "human");
    const inHistory = fran.welcome.history.find((m: any) => m.id === reply.message.id);
    assert.equal(inHistory.replyToId, root.message.id);

  });

  test("replying to an unknown message → error, nothing posted", async () => {
    const dana = await env.connect("dana", "human");

    const ghost = randomUUID();
    dana.ws.send(JSON.stringify({ type: "message", content: "reply", replyToId: ghost }));
    const refusal = await dana.next((e) => e.type === "error");
    assert.equal(refusal.error, `unknown message: ${ghost}`);
    assert.equal((await env.messages.list()).length, 0);
  });

});

describe("reactions", () => {
  test("add/remove broadcast hydrated message_updated; duplicates are silent no-ops", async () => {
    const dana = await env.connect("dana", "human");
    const erik = await env.connect("erik", "human");
    let updates = 0;
    erik.ws.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type === "message_updated") updates += 1;
    });

    dana.ws.send(JSON.stringify({ type: "message", content: "react to me" }));
    const posted = await erik.next((e) => e.type === "message");
    const messageId = posted.message.id;

    dana.ws.send(JSON.stringify({ type: "message_react", messageId, emoji: "👍", op: "add" }));
    const first = await erik.next((e) => e.type === "message_updated");
    assert.deepEqual(first.message.reactions, [
      { emoji: "👍", actors: [{ id: dana.welcome.self.id, name: "dana" }] },
    ]);

    // A second actor joins the same emoji: one group, actors in reaction order.
    erik.ws.send(JSON.stringify({ type: "message_react", messageId, emoji: "👍", op: "add" }));
    const second = await dana.next(
      (e) => e.type === "message_updated" && e.message.reactions?.[0]?.actors.length === 2,
    );
    assert.deepEqual(second.message.reactions, [
      {
        emoji: "👍",
        actors: [
          { id: dana.welcome.self.id, name: "dana" },
          { id: erik.welcome.self.id, name: "erik" },
        ],
      },
    ]);
    // list() hydrates the same view.
    assert.deepEqual((await env.messages.list())[0].reactions, second.message.reactions);

    // All on dana's connection so server-side ordering is guaranteed: a
    // duplicate add and a phantom remove change nothing (no broadcast), then
    // a real remove lands as the third and final update.
    dana.ws.send(JSON.stringify({ type: "message_react", messageId, emoji: "👍", op: "add" }));
    dana.ws.send(JSON.stringify({ type: "message_react", messageId, emoji: "🎉", op: "remove" }));
    dana.ws.send(JSON.stringify({ type: "message_react", messageId, emoji: "👍", op: "remove" }));
    const third = await erik.next(
      (e) =>
        e.type === "message_updated" &&
        e.message.reactions?.[0]?.actors.length === 1 &&
        e.message.reactions[0].actors[0].name === "erik",
    );
    assert.deepEqual(third.message.reactions, [
      { emoji: "👍", actors: [{ id: erik.welcome.self.id, name: "erik" }] },
    ]);
    assert.equal(updates, 3);

  });

  test("cap: the 21st distinct emoji is refused, piling onto an existing one is not", async () => {
    const dana = await env.connect("dana", "human");

    dana.ws.send(JSON.stringify({ type: "message", content: "cap me" }));
    const posted = await dana.next((e) => e.type === "message");
    const messageId = posted.message.id;

    for (let i = 0; i < 20; i++) {
      dana.ws.send(
        JSON.stringify({ type: "message_react", messageId, emoji: `e${i}`, op: "add" }),
      );
    }
    await dana.next(
      (e) => e.type === "message_updated" && e.message.reactions?.length === 20,
      10000,
    );

    dana.ws.send(JSON.stringify({ type: "message_react", messageId, emoji: "e20", op: "add" }));
    const refusal = await dana.next((e) => e.type === "error");
    assert.equal(refusal.error, "reaction limit reached");

    // Another actor on an already-present emoji still fits at the cap.
    const erik = await env.connect("erik", "human");
    erik.ws.send(JSON.stringify({ type: "message_react", messageId, emoji: "e0", op: "add" }));
    const piled = await dana.next(
      (e) => e.type === "message_updated" && e.message.reactions?.[0]?.actors.length === 2,
    );
    assert.equal(piled.message.reactions.length, 20);

  });

  test("reacting to an unknown message → error frame", async () => {
    const dana = await env.connect("dana", "human");

    const ghost = randomUUID();
    dana.ws.send(
      JSON.stringify({ type: "message_react", messageId: ghost, emoji: "👍", op: "add" }),
    );
    const refusal = await dana.next((e) => e.type === "error");
    assert.equal(refusal.error, `unknown message: ${ghost}`);
  });

});

describe("typing indicator", () => {
  test("relayed to others, never echoed to the sender, never persisted", async () => {
    const dana = await env.connect("dana", "human");
    const erik = await env.connect("erik", "human");

    dana.ws.send(JSON.stringify({ type: "typing", channel: "general" }));
    const typing = await erik.next((e) => e.type === "typing");
    assert.equal(typing.actorId, dana.welcome.self.id);
    assert.equal(typing.name, "dana");
    assert.equal(typing.channel, "general");
    assert.ok(typing.timestamp > 0);

    // Barrier: dana's own later message arrives on her socket after any echo
    // would have, so a missing typing frame now means it never existed.
    dana.ws.send(JSON.stringify({ type: "message", content: "done typing" }));
    await dana.next((e) => e.type === "message");
    await assert.rejects(dana.next((e) => e.type === "typing", 50), /timeout/);

    // Ephemeral: only the real message persisted.
    assert.equal((await env.messages.list()).length, 1);
  });

});

describe("send nonce", () => {
  test("echoed top-level on the triggering broadcast, never persisted", async () => {
    const dana = await env.connect("dana", "human");
    const erik = await env.connect("erik", "human");

    dana.ws.send(JSON.stringify({ type: "message", content: "hi", nonce: "n-123" }));
    const mine = await dana.next((e) => e.type === "message");
    assert.equal(mine.nonce, "n-123");
    assert.equal(mine.message.nonce, undefined);

    // Not persisted: a fresh join's history carries no nonce.
    const fran = await env.connect("fran", "human");
    assert.equal("nonce" in fran.welcome.history[0], false);

    // A nonce-less send has no nonce key at all.
    erik.ws.send(JSON.stringify({ type: "message", content: "plain" }));
    const plain = await dana.next((e) => e.type === "message" && e.message.content === "plain");
    assert.equal("nonce" in plain, false);
  });

});

describe("message op schemas", () => {
  test("edit content, emoji, nonce, and op bounds hold", () => {
    const ok = clientEventSchema.parse({ type: "message_edit", messageId: "m", content: "x" });
    assert.equal(ok.type, "message_edit");
    assert.throws(() => clientEventSchema.parse({ type: "message_edit", messageId: "m", content: "" }));
    assert.throws(() =>
      clientEventSchema.parse({ type: "message_edit", messageId: "m", content: "x".repeat(4001) }),
    );
    assert.throws(() =>
      clientEventSchema.parse({ type: "message_react", messageId: "m", emoji: "", op: "add" }),
    );
    assert.throws(() =>
      clientEventSchema.parse({
        type: "message_react",
        messageId: "m",
        emoji: "x".repeat(33),
        op: "remove",
      }),
    );
    assert.throws(() =>
      clientEventSchema.parse({ type: "message_react", messageId: "m", emoji: "👍", op: "toggle" }),
    );
    assert.throws(() =>
      clientEventSchema.parse({ type: "message", content: "hi", nonce: "x".repeat(65) }),
    );
    assert.equal(clientEventSchema.parse({ type: "typing", channel: "general" }).type, "typing");
  });
});

describe("welcome workspace identity", () => {
  test("the welcome frame carries the workspace id and name", async () => {
    const dana = await env.connect("dana", "human");
    // The test DB bootstraps its workspace via ensureWorkspace, named "test_space".
    assert.deepEqual(dana.welcome.workspace, {
      id: env.db.workspaceId,
      name: "test_space",
    });
  });
});

describe("welcome history cap", () => {
  test("with >50 messages in 2 channels, each yields exactly its newest 50, ascending", async () => {
    const dana = await env.connect("dana", "human");
    const created = await fetch(`${env.baseUrl}/api/channels`, {
      method: "POST",
      headers: { Authorization: `Bearer ${dana.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "random" }),
    });
    assert.equal(created.status, 201);

    for (let i = 0; i < 55; i++) {
      await seedMessage(env, "general", `general-${i}`, 1000 + i);
      await seedMessage(env, "random", `random-${i}`, 2000 + i);
    }

    const erik = await env.connect("erik", "human");
    const general = erik.welcome.history.filter((m: ChatMessage) => m.channel === "general");
    const random = erik.welcome.history.filter((m: ChatMessage) => m.channel === "random");
    assert.equal(general.length, 50);
    assert.equal(random.length, 50);
    // Newest 50 kept (indices 5..54), oldest first.
    assert.deepEqual(
      general.map((m: ChatMessage) => m.content),
      Array.from({ length: 50 }, (_, i) => `general-${i + 5}`),
    );
    assert.deepEqual(
      random.map((m: ChatMessage) => m.content),
      Array.from({ length: 50 }, (_, i) => `random-${i + 5}`),
    );
    assert.ok(general[0].timestamp < general[general.length - 1].timestamp);
  });

});

describe("GET /api/messages", () => {
  test("returns the correct older page, ascending, and paging back never repeats or skips", async () => {
    const dana = await env.connect("dana", "human");

    // A and B deliberately share a millisecond; C/D/E do not.
    const a = await seedMessage(env, "general", "A", 1000);
    const b = await seedMessage(env, "general", "B", 1000);
    const c = await seedMessage(env, "general", "C", 2000);
    const d = await seedMessage(env, "general", "D", 3000);
    const e = await seedMessage(env, "general", "E", 4000);

    const page = async (before: number, limit: number) => {
      const res = await fetch(
        `${env.baseUrl}/api/messages?channel=general&before=${before}&limit=${limit}`,
        { headers: { Authorization: `Bearer ${dana.token}` } },
      );
      assert.equal(res.status, 200);
      return (await res.json()).messages as ChatMessage[];
    };

    const page1 = await page(5000, 2);
    assert.deepEqual(page1.map((m) => m.content), ["D", "E"]);

    // The limit=2 cut lands mid-tie on A/B (both share created_at 1000);
    // they must come back together rather than being split across pages.
    const page2 = await page(d.timestamp, 2);
    assert.deepEqual(page2.map((m) => m.content), ["A", "B", "C"]);

    // Nothing left older than the oldest message.
    const page3 = await page(a.timestamp, 2);
    assert.deepEqual(page3, []);

    // Paging back twice (page2 then page1, oldest to newest) reconstructs
    // full history exactly once each — no drop, no duplicate.
    const seen = [...page2, ...page1].map((m) => m.id);
    assert.equal(seen.length, 5);
    assert.deepEqual(new Set(seen), new Set([a.id, b.id, c.id, d.id, e.id]));

  });

  test("limit is clamped, before must be numeric, request must be authenticated", async () => {
    const dana = await env.connect("dana", "human");
    for (let i = 0; i < 105; i++) await seedMessage(env, "clamped", `m-${i}`, i);

    const get = (qs: string, token: string | null = dana.token) =>
      fetch(`${env.baseUrl}/api/messages?${qs}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

    // limit above the max clamps down to 100, not the raw 1000.
    const overLimit = await get(`channel=clamped&before=999&limit=1000`);
    assert.equal(overLimit.status, 200);
    assert.equal((await overLimit.json()).messages.length, 100);

    // Non-numeric limit falls back to the default (50) rather than erroring.
    const badLimit = await get(`channel=clamped&before=999&limit=abc`);
    assert.equal(badLimit.status, 200);
    assert.equal((await badLimit.json()).messages.length, 50);

    // A non-numeric or missing `before` is rejected outright.
    const badBefore = await get(`channel=clamped&before=nope`);
    assert.equal(badBefore.status, 400);
    const missingBefore = await get(`channel=clamped`);
    assert.equal(missingBefore.status, 400);

    // No bearer token → refused, same as every other authenticated route.
    const unauth = await get(`channel=clamped&before=999`, null);
    assert.equal(unauth.status, 401);
  });

});
