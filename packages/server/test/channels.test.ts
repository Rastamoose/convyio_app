import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { WorkspaceDb } from "../src/db";
import { Channels } from "../src/chat/Channels";
import { createEnv, createWsEnv } from "./helpers";

describe("channel creation over the API", async () => {
  const env = await createEnv();
  const human = env.actor("human", "dana");
  const agent = env.actor("agent", "noodle");
  after(() => env.close());

  test("human create → 201 and the channel is listed after general", async () => {
    const res = await env.api("POST", "/api/channels", human.token, { name: "design" });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.channel, { name: "design" });
    assert.deepEqual(env.channels.list(), ["general", "design"]);
  });

  test("duplicate name → 409, case-insensitively", async () => {
    const dup = await env.api("POST", "/api/channels", human.token, { name: "DESIGN" });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, "CHANNEL_EXISTS");
  });

  test("agent create → 403", async () => {
    const res = await env.api("POST", "/api/channels", agent.token, { name: "agents-only" });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "FORBIDDEN");
    assert.equal(env.channels.exists("agents-only"), false);
  });

  test("empty and whitespace-only names → 400", async () => {
    const empty = await env.api("POST", "/api/channels", human.token, { name: "" });
    assert.equal(empty.status, 400);
    const blank = await env.api("POST", "/api/channels", human.token, { name: "   " });
    assert.equal(blank.status, 400);
    assert.equal(blank.body.error, "BAD_CHANNEL_NAME");
  });

  test("uppercase and internal whitespace are normalized", async () => {
    const res = await env.api("POST", "/api/channels", human.token, { name: "  Bug Reports " });
    assert.equal(res.status, 201);
    assert.equal(res.body.channel.name, "bug-reports");
    assert.ok(env.channels.exists("bug-reports"));
  });

  test("illegal characters → 400", async () => {
    const res = await env.api("POST", "/api/channels", human.token, { name: "no!good" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "BAD_CHANNEL_NAME");
  });

  test("names longer than 32 characters → 400", async () => {
    const res = await env.api("POST", "/api/channels", human.token, { name: "a".repeat(33) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "BAD_CHANNEL_NAME");
  });

  test("the 101st channel → 409 CHANNEL_LIMIT", () => {
    const db = new WorkspaceDb(":memory:");
    const channels = new Channels(db);
    channels.seed([{ name: "general", isDemo: false }]);
    const creator = db.upsertActor("human", "dana");
    for (let i = 1; i < 100; i++) channels.create(creator, `room-${i}`);
    assert.throws(
      () => channels.create(creator, "one-too-many"),
      (err: any) => err.status === 409 && err.code === "CHANNEL_LIMIT",
    );
    db.close();
  });
});

describe("channels on the websocket", async () => {
  test("unknown channel is refused and not persisted; creation fans out", async () => {
    const env = await createWsEnv();
    const human = await env.connect("dana", "human");
    assert.deepEqual(human.welcome.channels, ["general"]);

    // A message to a channel that does not exist is refused and dropped.
    human.ws.send(JSON.stringify({ type: "message", content: "hello?", channel: "ghost" }));
    const refusal = await human.next((e) => e.type === "error");
    assert.equal(refusal.error, "unknown channel: ghost");
    assert.equal(env.messages.list().length, 0);

    // Creation over HTTP fans out a channel_created frame to ws clients.
    const res = await fetch(`${env.baseUrl}/api/channels`, {
      method: "POST",
      headers: { Authorization: `Bearer ${human.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "design" }),
    });
    assert.equal(res.status, 201);
    const frame = await human.next((e) => e.type === "channel_created");
    assert.equal(frame.channel, "design");

    // Messages to the new channel now land.
    human.ws.send(JSON.stringify({ type: "message", content: "hi", channel: "design" }));
    await human.next((e) => e.type === "message" && e.message.channel === "design");
    assert.equal(env.messages.list().length, 1);

    env.close();
  });
});
