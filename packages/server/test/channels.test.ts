import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { WebSocket } from "ws";
import { WorkspaceDb } from "../src/db";
import { Attachments } from "../src/chat/Attachments";
import { Channels } from "../src/chat/Channels";
import { MessageStore } from "../src/chat/MessageStore";
import { Roster } from "../src/roster";
import { BoardService } from "../src/board/BoardService";
import { Sessions } from "../src/board/sessions";
import { createApiHandler } from "../src/board/api";
import { Toolman } from "../src/board/Toolman";
import { Hub } from "../src/hub";
import { createEnv } from "./helpers";

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
    const db = new WorkspaceDb(":memory:");
    const service = new BoardService(db);
    const sessions = new Sessions();
    const toolman = new Toolman(service, `/tmp/channels-test-${randomUUID()}`);
    await toolman.init();
    const channels = new Channels(db);
    channels.seed([{ name: "general", isDemo: false }]);
    const messages = new MessageStore(db);
    const attachments = new Attachments(db, fs.mkdtempSync(path.join(os.tmpdir(), "uploads-test-")));
    const handler = createApiHandler(db, service, sessions, channels, attachments, "*");
    const server = http.createServer((req, res) => void handler(req, res));
    const hub = new Hub(server, new Roster(db), messages, channels, attachments, sessions, toolman, {
      apiUrl: "",
      serverId: db.serverId,
      demoChannels: [],
    });
    channels.onCreated = (name) => hub.broadcastChannelCreated(name);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://localhost:${port}`;

    const connect = (name: string, kind: string) =>
      new Promise<{ ws: WebSocket; token: string; welcome: any; next: (pred: (e: any) => boolean, ms?: number) => Promise<any> }>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}`);
        const seen: any[] = [];
        const waiters: { pred: (e: any) => boolean; resolve: (e: any) => void }[] = [];
        ws.on("message", (raw) => {
          const ev = JSON.parse(raw.toString());
          seen.push(ev);
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].pred(ev)) waiters.splice(i, 1)[0].resolve(ev);
          }
          if (ev.type === "welcome") {
            resolve({
              ws,
              token: ev.token,
              welcome: ev,
              next: (pred, ms = 1000) =>
                new Promise((res, rej) => {
                  const already = seen.find(pred);
                  if (already) return res(already);
                  const t = setTimeout(() => rej(new Error("timeout")), ms);
                  waiters.push({ pred, resolve: (e) => { clearTimeout(t); res(e); } });
                }),
            });
          }
        });
        ws.on("open", () => ws.send(JSON.stringify({ type: "join", name, kind })));
      });

    const human = await connect("dana", "human");
    assert.deepEqual(human.welcome.channels, ["general"]);

    // A message to a channel that does not exist is refused and dropped.
    human.ws.send(JSON.stringify({ type: "message", content: "hello?", channel: "ghost" }));
    const refusal = await human.next((e) => e.type === "error");
    assert.equal(refusal.error, "unknown channel: ghost");
    assert.equal(messages.list().length, 0);

    // Creation over HTTP fans out a channel_created frame to ws clients.
    const res = await fetch(`${baseUrl}/api/channels`, {
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
    assert.equal(messages.list().length, 1);

    human.ws.close();
    server.close();
    db.close();
  });
});
