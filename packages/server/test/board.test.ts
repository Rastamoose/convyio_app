import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { WebSocket } from "ws";
import type { Actor, BoardItem } from "@workspace/shared";
import { WorkspaceDb } from "../src/db";
import { Channels } from "../src/chat/Channels";
import { MessageStore } from "../src/chat/MessageStore";
import { Roster } from "../src/roster";
import { BoardService } from "../src/board/BoardService";
import { Sessions } from "../src/board/sessions";
import { createApiHandler } from "../src/board/api";
import { Toolman, authorizeMutation, isMutating } from "../src/board/Toolman";
import { Hub } from "../src/hub";
import { createEnv, PROPOSAL } from "./helpers";

describe("board invariants", async () => {
  const env = await createEnv();
  const human = env.actor("human", "dana");
  const agent = env.actor("agent", "noodle");
  after(() => env.close());

  test("T1: agent calls approve → 403 AGENT_CANNOT_APPROVE", async () => {
    const { body: created } = await env.api("POST", "/api/board/items", agent.token, PROPOSAL);
    const res = await env.api("POST", `/api/board/items/${created.item.id}/approve`, agent.token);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "AGENT_CANNOT_APPROVE");
    const deny = await env.api("POST", `/api/board/items/${created.item.id}/deny`, agent.token);
    assert.equal(deny.status, 403);
    assert.equal(deny.body.error, "AGENT_CANNOT_APPROVE");
  });

  test("T2: agent-supplied status is ignored; item lands proposed", async () => {
    const res = await env.api("POST", "/api/board/items", agent.token, {
      ...PROPOSAL,
      status: "approved",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.item.status, "proposed");
    assert.equal(res.body.item.origin, "agent");
    assert.equal(res.body.item.approvedBy, null);
  });

  test("T2b: agent proposal without why/effect → 400", async () => {
    const res = await env.api("POST", "/api/board/items", agent.token, { title: "no fields" });
    assert.equal(res.status, 400);
  });

  test("T3: human create → approved, approved_by set, immediately workable", async () => {
    const res = await env.api("POST", "/api/board/items", human.token, { title: "Human item" });
    assert.equal(res.status, 201);
    const item: BoardItem = res.body.item;
    assert.equal(item.status, "approved");
    assert.equal(item.approvedBy, human.actor.id);
    assert.ok(item.approvedAt);
    const authz = authorizeMutation(
      agent.actor,
      item.ref,
      { name: "write_file", path: "notes.md" },
      env.service,
    );
    assert.equal(authz.allow, true);
  });

  test("T4: mutating action with no board ref → NO_BOARD_REF", () => {
    const authz = authorizeMutation(agent.actor, null, { name: "write_file" }, env.service);
    assert.equal(authz.allow, false);
    assert.equal(!authz.allow && authz.code, "NO_BOARD_REF");
  });

  test("T5: mutating action against proposed/denied/done → ITEM_NOT_WORKABLE", async () => {
    const proposed = env.service.create(agent.actor, PROPOSAL);
    for (const setup of [
      () => proposed,
      () => env.service.deny(human.actor, proposed.id),
      () => {
        const item = env.service.create(agent.actor, PROPOSAL);
        env.service.approve(human.actor, item.id);
        env.service.start(agent.actor, item.id);
        return env.service.complete(agent.actor, item.id);
      },
    ]) {
      const item = setup();
      const authz = authorizeMutation(
        agent.actor,
        item.ref,
        { name: "write_file", path: "out.md" },
        env.service,
      );
      assert.equal(authz.allow, false);
      assert.equal(!authz.allow && authz.code, "ITEM_NOT_WORKABLE");
    }
  });

  test("T6: mutating action against deleted item → ITEM_DELETED; item.deleted emitted", async () => {
    const item = env.service.create(human.actor, { title: "doomed" });
    env.service.start(agent.actor, item.id);
    env.envelopes.length = 0;
    env.service.softDelete(human.actor, item.id);
    assert.equal(env.envelopes.length, 1);
    assert.equal(env.envelopes[0].type, "item.deleted");
    const authz = authorizeMutation(
      agent.actor,
      item.ref,
      { name: "write_file", path: "out.md" },
      env.service,
    );
    assert.equal(authz.allow, false);
    assert.equal(!authz.allow && authz.code, "ITEM_DELETED");
  });

  test("T7: read-only tool with no board ref → allowed", () => {
    const authz = authorizeMutation(agent.actor, null, { name: "read_file" }, env.service);
    assert.equal(authz.allow, true);
  });

  test("T8: unregistered tool is treated as mutating (fail closed)", () => {
    assert.equal(isMutating("brand_new_tool"), true);
    const authz = authorizeMutation(agent.actor, null, { name: "brand_new_tool" }, env.service);
    assert.equal(authz.allow, false);
    assert.equal(!authz.allow && authz.code, "NO_BOARD_REF");
  });

  test("T9: each transition writes exactly one event row; rollback writes none", async () => {
    const countEvents = (itemId: string) =>
      (env.db.db
        .prepare(`SELECT count(*) AS c FROM board_events WHERE item_id = ?`)
        .get(itemId) as { c: number }).c;

    const item = env.service.create(agent.actor, PROPOSAL);
    assert.equal(countEvents(item.id), 1);
    env.service.approve(human.actor, item.id);
    assert.equal(countEvents(item.id), 2);
    env.service.start(agent.actor, item.id);
    assert.equal(countEvents(item.id), 3);
    env.service.block(agent.actor, item.id, "awaiting input");
    assert.equal(countEvents(item.id), 4);
    env.service.unblock(agent.actor, item.id);
    assert.equal(countEvents(item.id), 5);
    env.service.complete(agent.actor, item.id);
    assert.equal(countEvents(item.id), 6);

    // Rolled-back transaction: creating with an actor that violates the
    // actors FK aborts mid-transaction; neither item nor event may remain.
    const itemsBefore = (env.db.db.prepare(`SELECT count(*) AS c FROM board_items`).get() as { c: number }).c;
    const eventsBefore = (env.db.db.prepare(`SELECT count(*) AS c FROM board_events`).get() as { c: number }).c;
    const ghost: Actor = { id: randomUUID(), kind: "human", displayName: "ghost", serverId: env.db.serverId };
    assert.throws(() => env.service.create(ghost, { title: "never lands" }));
    assert.equal((env.db.db.prepare(`SELECT count(*) AS c FROM board_items`).get() as { c: number }).c, itemsBefore);
    assert.equal((env.db.db.prepare(`SELECT count(*) AS c FROM board_events`).get() as { c: number }).c, eventsBefore);
  });

  test("T11: concurrent creation produces unique sequential refs", async () => {
    const before = env.service.list(env.db.serverId, { includeDeleted: true }).length;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        env.api("POST", "/api/board/items", human.token, { title: `parallel ${i}` }),
      ),
    );
    const refs = results.map((r) => r.body.item.ref as string);
    assert.equal(new Set(refs).size, 10);
    const numbers = refs.map((r) => Number(r.replace("task-", ""))).sort((a, b) => a - b);
    for (let i = 1; i < numbers.length; i++) {
      assert.equal(numbers[i], numbers[i - 1] + 1);
    }
    assert.equal(
      env.service.list(env.db.serverId, { includeDeleted: true }).length,
      before + 10,
    );
  });

  test("T12: invalid transitions → 409", async () => {
    const { body: done } = await env.api("POST", "/api/board/items", human.token, { title: "lifecycle" });
    await env.api("POST", `/api/board/items/${done.item.id}/start`, agent.token);
    await env.api("POST", `/api/board/items/${done.item.id}/complete`, agent.token);

    const approveDone = await env.api("POST", `/api/board/items/${done.item.id}/approve`, human.token);
    assert.equal(approveDone.status, 409);

    const { body: proposed } = await env.api("POST", "/api/board/items", agent.token, PROPOSAL);
    const startProposed = await env.api("POST", `/api/board/items/${proposed.item.id}/start`, agent.token);
    assert.equal(startProposed.status, 409);
  });

  test("edits and reopen are human-only", async () => {
    const { body: created } = await env.api("POST", "/api/board/items", human.token, { title: "editable" });
    const patch = await env.api("PATCH", `/api/board/items/${created.item.id}`, agent.token, { title: "sneaky" });
    assert.equal(patch.status, 403);
    const del = await env.api("DELETE", `/api/board/items/${created.item.id}`, agent.token);
    assert.equal(del.status, 403);
    const ok = await env.api("PATCH", `/api/board/items/${created.item.id}`, human.token, { title: "edited" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.item.title, "edited");
  });

  test("list defaults exclude denied and deleted", async () => {
    const item = env.service.create(agent.actor, PROPOSAL);
    env.service.deny(human.actor, item.id);
    const listed = env.service.list(env.db.serverId);
    assert.ok(!listed.some((i) => i.id === item.id));
    const all = env.service.list(env.db.serverId, { includeDeleted: true });
    assert.ok(all.some((i) => i.id === item.id));
  });

  test("unauthenticated request → 401", async () => {
    const res = await fetch(`${env.baseUrl}/api/board/items`);
    assert.equal(res.status, 401);
  });
});

describe("T10: full-stack approval fan-out", async () => {
  test("approval reaches all clients within 1s and unblocks agent work", async () => {
    const db = new WorkspaceDb(":memory:");
    const service = new BoardService(db);
    const sessions = new Sessions();
    const toolman = new Toolman(service, `/tmp/board-test-${randomUUID()}`);
    await toolman.init();
    const channels = new Channels(db);
    channels.seed([{ name: "general", isDemo: false }]);
    const handler = createApiHandler(db, service, sessions, channels, "*");
    const server = http.createServer((req, res) => void handler(req, res));
    const hub = new Hub(server, new Roster(db), new MessageStore(db), channels, sessions, toolman, {
      apiUrl: "",
      serverId: db.serverId,
      demoChannels: [],
    });
    service.onEvent = (e) => hub.broadcastBoardEvent(e);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://localhost:${port}`;

    const connect = (name: string, kind: string) =>
      new Promise<{ ws: WebSocket; token: string; next: (pred: (e: any) => boolean, ms?: number) => Promise<any> }>((resolve) => {
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

    const agent = await connect("noodle", "agent");
    const humanA = await connect("dana", "human");
    const humanB = await connect("harris", "human");

    const proposeRes = await fetch(`${baseUrl}/api/board/items`, {
      method: "POST",
      headers: { Authorization: `Bearer ${agent.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(PROPOSAL),
    });
    const proposed = (await proposeRes.json()).item as BoardItem;

    // The proposal itself fans out.
    await humanA.next((e) => e.type === "item.proposed" && e.item.id === proposed.id);

    // Mutating work is refused while proposed.
    agent.ws.send(JSON.stringify({
      type: "action_request",
      requestId: "r1",
      boardItemRef: proposed.ref,
      action: { kind: "write_file", path: "out.md", content: "x" },
    }));
    const denied = await agent.next((e) => e.type === "action_result" && e.requestId === "r1");
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "ITEM_NOT_WORKABLE");

    // Human approves over HTTP; every ws client sees item.approved within 1s.
    const approvedAt = Date.now();
    const [agentSaw, aSaw, bSaw] = await Promise.all([
      agent.next((e) => e.type === "item.approved" && e.item.id === proposed.id),
      humanA.next((e) => e.type === "item.approved" && e.item.id === proposed.id),
      humanB.next((e) => e.type === "item.approved" && e.item.id === proposed.id),
      fetch(`${baseUrl}/api/board/items/${proposed.id}/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${humanA.token}` },
      }),
    ]);
    assert.ok(Date.now() - approvedAt < 1000);
    assert.equal(agentSaw.item.status, "approved");
    assert.equal(aSaw.item.status, "approved");
    assert.equal(bSaw.item.status, "approved");

    // Agent resumes with no further human action: the same mutation now runs.
    agent.ws.send(JSON.stringify({
      type: "action_request",
      requestId: "r2",
      boardItemRef: proposed.ref,
      action: { kind: "write_file", path: "out.md", content: "x" },
    }));
    const allowed = await agent.next((e) => e.type === "action_result" && e.requestId === "r2");
    assert.equal(allowed.ok, true);

    agent.ws.close();
    humanA.ws.close();
    humanB.ws.close();
    server.close();
    db.close();
  });
});
