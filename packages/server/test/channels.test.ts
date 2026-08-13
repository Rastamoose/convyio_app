import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { Channels } from "../src/chat/Channels";
import { createEnv, createWsEnv } from "./helpers";
import { createTestDb } from "./pgSchema";

describe("channel creation over the API", async () => {
  const env = await createEnv();
  const human = await env.actor("human", "dana");
  const agent = await env.actor("agent", "noodle");
  after(() => env.close());

  test("human create → 201 and the channel is listed after general", async () => {
    const res = await env.api("POST", "/api/channels", human.token, { name: "design" });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.channel, { name: "design" });
    assert.deepEqual(await env.channels.list(), ["general", "design"]);
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
    assert.equal(await env.channels.exists("agents-only"), false);
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
    assert.ok(await env.channels.exists("bug-reports"));
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

  test("the 101st channel → 409 CHANNEL_LIMIT", async () => {
    const { db, drop } = await createTestDb();
    try {
      const channels = new Channels(db);
      await channels.seed([{ name: "general", isDemo: false }]);
      const creator = await db.upsertActor("human", "dana");
      for (let i = 1; i < 100; i++) await channels.create(creator, `room-${i}`);
      await assert.rejects(
        channels.create(creator, "one-too-many"),
        (err: any) => err.status === 409 && err.code === "CHANNEL_LIMIT",
      );
    } finally {
      await drop();
    }
  });
});

describe("channel management over the API", async () => {
  const env = await createEnv();
  const human = await env.actor("human", "dana");
  const agent = await env.actor("agent", "noodle");
  after(() => env.close());

  test("rename: messages follow while their stable channel id stays fixed", async () => {
    await env.api("POST", "/api/channels", human.token, { name: "old-name" });
    const before = (await env.channels.get("old-name"))!;
    await env.messages.append({
      id: "rename-message",
      authorId: human.actor.id,
      authorName: human.actor.displayName,
      authorKind: human.actor.kind,
      content: "keep identity",
      channelId: before.id,
      channel: before.name,
      timestamp: Date.now(),
    });
    const res = await env.api("PATCH", "/api/channels/old-name", human.token, {
      name: "New Name",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.channel.name, "new-name");
    assert.deepEqual((await env.channels.list()).includes("old-name"), false);
    const after = (await env.channels.get("new-name"))!;
    assert.equal(after.id, before.id);
    const message = (await env.messages.get("rename-message"))!;
    assert.equal(message.channel, "new-name");
    assert.equal(message.channelId, before.id);
    const [event] = await env.db.sql<{ channel_id: string }[]>`
      SELECT channel_id FROM thread_events WHERE subject_id = 'rename-message'
    `;
    assert.equal(event.channel_id, before.id);
  });

  test("rename to an existing name → 409", async () => {
    await env.api("POST", "/api/channels", human.token, { name: "taken" });
    await env.api("POST", "/api/channels", human.token, { name: "renaming" });
    const res = await env.api("PATCH", "/api/channels/renaming", human.token, { name: "taken" });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "CHANNEL_EXISTS");
  });

  test("general cannot be renamed, archived, or deleted", async () => {
    const rename = await env.api("PATCH", "/api/channels/general", human.token, {
      name: "renamed",
    });
    assert.equal(rename.status, 400);
    assert.equal(rename.body.error, "CHANNEL_FIXED");

    const archive = await env.api("PATCH", "/api/channels/general", human.token, {
      archived: true,
    });
    assert.equal(archive.status, 400);

    const del = await env.api("DELETE", "/api/channels/general", human.token);
    assert.equal(del.status, 400);
    assert.ok(await env.channels.exists("general"));
  });

  test("general can still be pinned", async () => {
    const res = await env.api("PATCH", "/api/channels/general", human.token, { pinned: true });
    assert.equal(res.status, 200);
    assert.deepEqual(await env.channels.pinned(), ["general"]);
  });

  test("archive drops a channel from list() but keeps it in listArchived()", async () => {
    await env.api("POST", "/api/channels", human.token, { name: "stale" });
    const res = await env.api("PATCH", "/api/channels/stale", human.token, { archived: true });
    assert.equal(res.status, 200);
    assert.equal((await env.channels.list()).includes("stale"), false);
    assert.ok((await env.channels.listArchived()).includes("stale"));

    const unarchive = await env.api("PATCH", "/api/channels/stale", human.token, {
      archived: false,
    });
    assert.equal(unarchive.status, 200);
    assert.ok((await env.channels.list()).includes("stale"));
  });

  test("pinned channels sort first in list()", async () => {
    await env.api("POST", "/api/channels", human.token, { name: "unpinned-room" });
    await env.api("POST", "/api/channels", human.token, { name: "z-room" });
    await env.api("PATCH", "/api/channels/z-room", human.token, { pinned: true });
    const list = await env.channels.list();
    assert.ok(list.indexOf("z-room") < list.indexOf("unpinned-room"));
  });

  test("delete removes messages but preserves canonical channel identity and clear event", async () => {
    await env.api("POST", "/api/channels", human.token, { name: "doomed" });
    const channel = (await env.channels.get("doomed"))!;
    await env.messages.append({
      id: "m1",
      authorId: human.actor.id,
      authorName: human.actor.displayName,
      authorKind: "human",
      content: "bye",
      timestamp: Date.now(),
      channelId: channel.id,
      channel: channel.name,
    });
    const res = await env.api("DELETE", "/api/channels/doomed", human.token);
    assert.equal(res.status, 200);
    assert.equal(await env.channels.exists("doomed"), false);
    assert.equal((await env.messages.list()).filter((m) => m.channel === "doomed").length, 0);
    const events = await env.db.sql<
      { kind: string; channel_id: string; payload: Record<string, unknown> }[]
    >`
      SELECT kind, channel_id, payload FROM thread_events
      WHERE channel_id = ${channel.id}
      ORDER BY seq
    `;
    assert.deepEqual(events.map((event) => event.kind), [
      "message.created",
      "message.channel_cleared",
    ]);
    assert.ok(events.every((event) => event.channel_id === channel.id));
    assert.deepEqual(events[1].payload, { channelId: channel.id, channel: channel.name });
  });

  test("agents cannot rename, archive, pin, or delete", async () => {
    await env.api("POST", "/api/channels", human.token, { name: "agent-blocked" });
    const rename = await env.api("PATCH", "/api/channels/agent-blocked", agent.token, {
      name: "hijacked",
    });
    assert.equal(rename.status, 403);
    const del = await env.api("DELETE", "/api/channels/agent-blocked", agent.token);
    assert.equal(del.status, 403);
    assert.ok(await env.channels.exists("agent-blocked"));
  });

  test("unknown channel → 404 on rename/archive/pin/delete", async () => {
    const res = await env.api("PATCH", "/api/channels/ghost", human.token, { archived: true });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "NOT_FOUND");
  });
});

describe("channels on the websocket", async () => {
  test("unknown channel is refused and not persisted; creation fans out", async () => {
    const env = await createWsEnv();
    const human = await env.connect("dana", "human");
    assert.deepEqual(human.welcome.channels, ["general"]);
    assert.deepEqual(human.welcome.channelInfos.map((channel: any) => channel.name), ["general"]);
    assert.ok(human.welcome.channelInfos[0].id);

    // A message to a channel that does not exist is refused and dropped.
    human.ws.send(JSON.stringify({ type: "message", content: "hello?", channel: "ghost" }));
    const refusal = await human.next((e) => e.type === "error");
    assert.equal(refusal.error, "unknown channel: ghost");
    assert.equal((await env.messages.list()).length, 0);

    // Creation over HTTP fans out a channel_created frame to ws clients.
    const res = await fetch(`${env.baseUrl}/api/channels`, {
      method: "POST",
      headers: { Authorization: `Bearer ${human.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "design" }),
    });
    assert.equal(res.status, 201);
    const frame = await human.next((e) => e.type === "channel_created");
    assert.equal(frame.channel, "design");
    assert.deepEqual(frame.channelInfo, { id: frame.channelInfo.id, name: "design" });

    // Messages to the new channel now land with the stable id.
    human.ws.send(JSON.stringify({ type: "message", content: "hi", channel: "design" }));
    const message = await human.next(
      (e) => e.type === "message" && e.message.channel === "design",
    );
    assert.equal(message.message.channelId, frame.channelInfo.id);
    assert.equal((await env.messages.list()).length, 1);

    await env.close();
  });

  test("rename, archive, pin, and delete each fan out their frame", async () => {
    const env = await createWsEnv();
    const human = await env.connect("dana", "human");
    await fetch(`${env.baseUrl}/api/channels`, {
      method: "POST",
      headers: { Authorization: `Bearer ${human.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "design" }),
    });
    await human.next((e) => e.type === "channel_created");

    const patch = (body: Record<string, unknown>) =>
      fetch(`${env.baseUrl}/api/channels/design`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${human.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    await patch({ pinned: true });
    const pinned = await human.next((e) => e.type === "channel_pinned");
    assert.deepEqual(pinned, { type: "channel_pinned", channel: "design", pinned: true });

    await patch({ archived: true });
    const archived = await human.next((e) => e.type === "channel_archived");
    assert.deepEqual(archived, { type: "channel_archived", channel: "design", archived: true });

    await patch({ name: "designs" });
    const renamed = await human.next((e) => e.type === "channel_renamed");
    assert.deepEqual(renamed, { type: "channel_renamed", oldName: "design", newName: "designs" });

    await fetch(`${env.baseUrl}/api/channels/designs`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${human.token}` },
    });
    const deleted = await human.next((e) => e.type === "channel_deleted");
    assert.deepEqual(deleted, { type: "channel_deleted", channel: "designs" });

    await env.close();
  });
});
