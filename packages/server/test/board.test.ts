import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { WebSocket } from "ws";
import type { Actor, BoardItem } from "@workspace/shared";
import { AgentWorkStore } from "../src/chat/AgentWorkStore";
import { Attachments } from "../src/chat/Attachments";
import { Channels } from "../src/chat/Channels";
import { MessageStore } from "../src/chat/MessageStore";
import { ThreadEventStore } from "../src/chat/ThreadEventStore";
import { InteractionStore } from "../src/chat/InteractionStore";
import { Roster } from "../src/roster";
import { BoardService } from "../src/board/BoardService";
import { PlanService } from "../src/board/PlanService";
import { Sessions } from "../src/board/sessions";
import { createApiHandler } from "../src/board/api";
import { AgentInvites } from "../src/auth/AgentInvites";
import { Toolman, authorizeMutation, isMutating } from "../src/board/Toolman";
import { Hub } from "../src/hub";
import { RunnerRuntime } from "../src/RunnerRuntime";
import { acceptedPlan, createEnv, createWsEnv, PROPOSAL, proposeTicket, supabaseAdmin } from "./helpers";
import { createTestDb } from "./pgSchema";

describe("board invariants", async () => {
  const env = await createEnv();
  const human = await env.actor("human", "dana");
  const agent = await env.actor("agent", "noodle");
  let planId = "";
  after(() => env.close());

  const ticketBody = (extras: Record<string, unknown> = {}) => ({
    ...PROPOSAL,
    planId,
    owner: agent.actor.id,
    ...extras,
  });

  test("T1: agent calls approve → 403 AGENT_CANNOT_APPROVE", async () => {
    planId = await acceptedPlan(env, human.token, "T1");
    const { body: created } = await env.api("POST", "/api/board/items", agent.token, ticketBody());
    const res = await env.api("POST", `/api/board/items/${created.item.id}/approve`, agent.token);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "AGENT_CANNOT_APPROVE");
    const deny = await env.api("POST", `/api/board/items/${created.item.id}/deny`, agent.token);
    assert.equal(deny.status, 403);
    assert.equal(deny.body.error, "AGENT_CANNOT_APPROVE");
  });

  test("T2: agent-supplied status is ignored; item lands proposed", async () => {
    planId = await acceptedPlan(env, human.token, "T2");
    const res = await env.api("POST", "/api/board/items", agent.token, {
      ...ticketBody(),
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

  test("T3: every ticket starts proposed; approval needs owner and makes it workable", async () => {
    planId = await acceptedPlan(env, human.token, "T3");
    const res = await env.api("POST", "/api/board/items", human.token, ticketBody({ title: "Human item" }));
    assert.equal(res.status, 201);
    const item: BoardItem = res.body.item;
    assert.equal(item.status, "proposed");
    assert.equal(item.approvedBy, null);
    const approved = await env.api("POST", `/api/board/items/${item.id}/approve`, human.token, {
      owner: agent.actor.id,
    });
    assert.equal(approved.status, 200);
    const authz = await authorizeMutation(
      agent.actor,
      item.ref,
      { name: "write_file", path: "out.md" },
      env.service,
    );
    assert.equal(authz.allow, true);
  });

  test("T4: mutating action with no board ref → NO_BOARD_REF", async () => {
    const authz = await authorizeMutation(agent.actor, null, { name: "write_file" }, env.service);
    assert.equal(authz.allow, false);
    assert.equal(!authz.allow && authz.code, "NO_BOARD_REF");
  });

  test("T5: mutating action against proposed/denied/done → ITEM_NOT_WORKABLE", async () => {
    const firstPlan = await acceptedPlan(env, human.token, "T5a");
    const proposed = await proposeTicket(env, agent.actor, firstPlan, { owner: agent.actor.id });
    for (const setup of [
      async () => proposed,
      async () => await env.service.deny(human.actor, proposed.id),
      async () => {
        const item = await proposeTicket(env, agent.actor, await acceptedPlan(env, human.token, "T5b"), {
          owner: agent.actor.id,
        });
        await env.service.approve(human.actor, item.id, agent.actor.id);
        await env.service.start(agent.actor, item.id);
        return await env.service.complete(agent.actor, item.id, "tests pass");
      },
    ]) {
      const item = await setup();
      const authz = await authorizeMutation(
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
    const item = await proposeTicket(env, human.actor, await acceptedPlan(env, human.token, "T6"), {
      title: "doomed",
      owner: agent.actor.id,
    });
    await env.service.approve(human.actor, item.id, agent.actor.id);
    await env.service.start(agent.actor, item.id);
    env.envelopes.length = 0;
    await env.service.softDelete(human.actor, item.id);
    assert.equal(env.envelopes.length, 1);
    assert.equal(env.envelopes[0].type, "item.deleted");
    const authz = await authorizeMutation(
      agent.actor,
      item.ref,
      { name: "write_file", path: "out.md" },
      env.service,
    );
    assert.equal(authz.allow, false);
    assert.equal(!authz.allow && authz.code, "ITEM_DELETED");
  });

  test("T7: read-only tool with no board ref → allowed", async () => {
    const authz = await authorizeMutation(agent.actor, null, { name: "read_file" }, env.service);
    assert.equal(authz.allow, true);
  });

  test("T8: unregistered tool is treated as mutating (fail closed)", async () => {
    assert.equal(isMutating("brand_new_tool"), true);
    const authz = await authorizeMutation(agent.actor, null, { name: "brand_new_tool" }, env.service);
    assert.equal(authz.allow, false);
    assert.equal(!authz.allow && authz.code, "NO_BOARD_REF");
  });

  test("T9: each transition writes exactly one event row; rollback writes none", async () => {
    const countEvents = async (table: "board_events" | "thread_events", itemId: string) => {
      const rows = table === "board_events"
        ? await env.db.sql<{ c: number }[]>`
            SELECT count(*) AS c FROM board_events WHERE item_id = ${itemId}
          `
        : await env.db.sql<{ c: number }[]>`
            SELECT count(*) AS c FROM thread_events WHERE subject_id = ${itemId}
          `;
      return rows[0].c;
    };
    const assertCounts = async (itemId: string, expected: number) => {
      assert.equal(await countEvents("board_events", itemId), expected);
      assert.equal(await countEvents("thread_events", itemId), expected);
    };

    const item = await proposeTicket(env, agent.actor, await acceptedPlan(env, human.token, "T9"), {
      owner: agent.actor.id,
    });
    await assertCounts(item.id, 1);
    await env.service.approve(human.actor, item.id, agent.actor.id);
    await assertCounts(item.id, 2);
    await env.service.start(agent.actor, item.id);
    await assertCounts(item.id, 3);
    await env.service.block(agent.actor, item.id, "awaiting input");
    await assertCounts(item.id, 4);
    await env.service.unblock(agent.actor, item.id);
    await assertCounts(item.id, 5);
    await env.service.complete(agent.actor, item.id, "tests pass");
    await assertCounts(item.id, 6);
    const canonical = await env.db.sql<
      { kind: string; payload: { itemId: string; itemRef: string } }[]
    >`
      SELECT kind, payload FROM thread_events WHERE subject_id = ${item.id} ORDER BY seq
    `;
    assert.deepEqual(canonical.map((event) => event.kind), [
      "item.proposed",
      "item.approved",
      "item.started",
      "item.blocked",
      "item.unblocked",
      "item.completed",
    ]);
    assert.ok(canonical.every((event) =>
      event.payload.itemId === item.id && event.payload.itemRef === item.ref
    ));

    // The compatibility writes succeed, then the canonical workspace FK
    // fails; the shared transaction must roll all three writes back.
    const itemsBeforeRows = await env.db.sql<{ c: number }[]>`SELECT count(*) AS c FROM board_items`;
    const eventsBeforeRows = await env.db.sql<{ c: number }[]>`SELECT count(*) AS c FROM board_events`;
    const threadBeforeRows = await env.db.sql<{ c: number }[]>`SELECT count(*) AS c FROM thread_events`;
    const itemsBefore = itemsBeforeRows[0].c;
    const eventsBefore = eventsBeforeRows[0].c;
    const threadBefore = threadBeforeRows[0].c;
    const invalidWorkspace: Actor = { ...human.actor, workspaceId: randomUUID() };
    await assert.rejects(env.service.create(invalidWorkspace, { ...PROPOSAL, planId: item.planId! }));
    const itemsAfterRows = await env.db.sql<{ c: number }[]>`SELECT count(*) AS c FROM board_items`;
    const eventsAfterRows = await env.db.sql<{ c: number }[]>`SELECT count(*) AS c FROM board_events`;
    const threadAfterRows = await env.db.sql<{ c: number }[]>`SELECT count(*) AS c FROM thread_events`;
    assert.equal(itemsAfterRows[0].c, itemsBefore);
    assert.equal(eventsAfterRows[0].c, eventsBefore);
    assert.equal(threadAfterRows[0].c, threadBefore);
  });

  test("T11: concurrent creation produces unique sequential refs", async () => {
    const before = (await env.service.list(env.db.workspaceId, { includeDeleted: true })).length;
    const planIds = [];
    for (let i = 0; i < 10; i++) planIds.push(await acceptedPlan(env, human.token, `T11-${i}`));
    const results = await Promise.all(
      planIds.map((id, i) =>
        env.api("POST", "/api/board/items", human.token, ticketBody({ title: `parallel ${i}`, planId: id })),
      ),
    );
    const refs = results.map((r) => r.body.item.ref as string);
    assert.equal(new Set(refs).size, 10);
    const numbers = refs.map((r) => Number(r.replace("task-", ""))).sort((a, b) => a - b);
    for (let i = 1; i < numbers.length; i++) {
      assert.equal(numbers[i], numbers[i - 1] + 1);
    }
    assert.equal(
      (await env.service.list(env.db.workspaceId, { includeDeleted: true })).length,
      before + 10,
    );
  });

  test("T12: invalid transitions → 409", async () => {
    const created = await env.api(
      "POST",
      "/api/board/items",
      human.token,
      ticketBody({ title: "lifecycle", planId: await acceptedPlan(env, human.token, "T12a") }),
    );
    await env.api("POST", `/api/board/items/${created.body.item.id}/approve`, human.token, {
      owner: agent.actor.id,
    });
    await env.api("POST", `/api/board/items/${created.body.item.id}/start`, agent.token);
    await env.api("POST", `/api/board/items/${created.body.item.id}/complete`, agent.token, {
      evidence: "tests pass",
    });

    const approveDone = await env.api("POST", `/api/board/items/${created.body.item.id}/approve`, human.token);
    assert.equal(approveDone.status, 409);

    const { body: proposed } = await env.api(
      "POST",
      "/api/board/items",
      agent.token,
      ticketBody({ planId: await acceptedPlan(env, human.token, "T12b") }),
    );
    const startProposed = await env.api("POST", `/api/board/items/${proposed.item.id}/start`, agent.token);
    assert.equal(startProposed.status, 409);
  });

  test("edits and reopen are human-only", async () => {
    const { body: created } = await env.api(
      "POST",
      "/api/board/items",
      human.token,
      ticketBody({ title: "editable", planId: await acceptedPlan(env, human.token, "edit") }),
    );
    const patch = await env.api("PATCH", `/api/board/items/${created.item.id}`, agent.token, { title: "sneaky" });
    assert.equal(patch.status, 403);
    const del = await env.api("DELETE", `/api/board/items/${created.item.id}`, agent.token);
    assert.equal(del.status, 403);
    const ok = await env.api("PATCH", `/api/board/items/${created.item.id}`, human.token, { title: "edited" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.item.title, "edited");
  });

  test("list defaults exclude denied and deleted", async () => {
    const item = await proposeTicket(env, agent.actor, await acceptedPlan(env, human.token, "list"), {
      owner: agent.actor.id,
    });
    await env.service.deny(human.actor, item.id);
    const listed = await env.service.list(env.db.workspaceId);
    assert.ok(!listed.some((i) => i.id === item.id));
    const all = await env.service.list(env.db.workspaceId, { includeDeleted: true });
    assert.ok(all.some((i) => i.id === item.id));
  });

  test("unauthenticated request → 401", async () => {
    const res = await fetch(`${env.baseUrl}/api/board/items`);
    assert.equal(res.status, 401);
  });

  test("GET /api/health → 200 {ok:true} without auth", async () => {
    const res = await fetch(`${env.baseUrl}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

describe("T10: full-stack approval fan-out", async () => {
  test("approval reaches all clients within 1s and unblocks agent work", async () => {
    const { db, drop } = await createTestDb();
    const threadEvents = new ThreadEventStore(db);
    const plans = new PlanService(db, threadEvents);
    const service = new BoardService(db, threadEvents, plans);
    const sessions = new Sessions();
    const toolman = new Toolman(service, `/tmp/board-test-${randomUUID()}`);
    await toolman.init();
    const channels = new Channels(db);
    await channels.seed([{ name: "general", isDemo: false }]);
    const attachments = new Attachments(db, supabaseAdmin());
    const messages = new MessageStore(db, threadEvents);
    const agentWork = new AgentWorkStore(db, threadEvents, messages);
    const agentInvites = new AgentInvites(db);
    const handler = createApiHandler({
      db,
      service,
      sessions,
      messages,
      threadEvents,
      channels,
      attachments,
      corsOrigin: "*",
      agentInvites,
      plans,
    });
    const server = http.createServer((req, res) => void handler(req, res));
    const hub = new Hub(server, await Roster.create(db, agentInvites), messages, agentWork, channels, attachments, sessions, toolman, new InteractionStore(db, threadEvents), new RunnerRuntime(), {
      workspace: { id: db.workspaceId, name: db.workspaceName },
      demoChannels: [],
    });
    service.onEvent = (e) => hub.broadcastBoardEvent(e);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://localhost:${port}`;

    const connect = (name: string, kind: string) =>
      new Promise<{ ws: WebSocket; token: string; selfId: string; next: (pred: (e: any) => boolean, ms?: number) => Promise<any> }>((resolve) => {
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
              selfId: ev.self.id,
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

    try {
      const agent = await connect("noodle", "agent");
      const humanA = await connect("dana", "human");
      const humanB = await connect("harris", "human");

      const planRes = await fetch(`${baseUrl}/api/board/plans`, {
        method: "POST",
        headers: { Authorization: `Bearer ${humanA.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "T10",
          objective: "Fan-out",
          outline: ["Propose", "Approve"],
          clarifications: ["fixture"],
          impactMap: PROPOSAL.impactMap,
        }),
      });
      const plan = (await planRes.json()).plan;
      await fetch(`${baseUrl}/api/board/plans/${plan.id}/accept`, {
        method: "POST",
        headers: { Authorization: `Bearer ${humanA.token}` },
      });
      const proposeRes = await fetch(`${baseUrl}/api/board/items`, {
        method: "POST",
        headers: { Authorization: `Bearer ${agent.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...PROPOSAL, planId: plan.id, owner: agent.selfId }),
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
          headers: { Authorization: `Bearer ${humanA.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ owner: agent.selfId }),
        }),
      ]);
      assert.ok(Date.now() - approvedAt < 1000);
      assert.equal(agentSaw.item.status, "approved");
      assert.equal(aSaw.item.status, "approved");
      assert.equal(bSaw.item.status, "approved");

      // The board now authorizes the mutation, so the run reaches the second
      // layer: manual mode pauses on a human before writing anything.
      agent.ws.send(JSON.stringify({
        type: "action_request",
        requestId: "r2",
        boardItemRef: proposed.ref,
        action: { kind: "write_file", path: "out.md", content: "x" },
      }));
      const prompt = await humanA.next((e) => e.type === "interaction_request");
      assert.equal(prompt.request.summary, "write_file out.md");
      assert.equal(prompt.request.capability, "file_write");

      // Any human surface can answer, and every surface sees the same id resolve.
      humanB.ws.send(JSON.stringify({
        type: "interaction_resolve",
        requestId: prompt.request.id,
        decision: "approve",
      }));
      const resolved = await humanA.next((e) => e.type === "interaction_resolved");
      assert.equal(resolved.request.id, prompt.request.id);
      assert.equal(resolved.request.status, "approved");

      const allowed = await agent.next((e) => e.type === "action_result" && e.requestId === "r2");
      assert.equal(allowed.ok, true);

      agent.ws.close();
      humanA.ws.close();
      humanB.ws.close();
    } finally {
      await hub.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await drop();
    }
  });
});

describe("welcome.apiUrl derivation", async () => {
  test("behind a TLS proxy the forwarded proto and Host name the public origin", async () => {
    const env = await createWsEnv();
    const welcome = await new Promise<any>((resolve) => {
      const ws = new WebSocket(env.baseUrl.replace(/^http/, "ws"), {
        headers: { host: "chat.example.com", "x-forwarded-proto": "https, http" },
      });
      ws.on("message", (raw) => {
        const ev = JSON.parse(raw.toString());
        if (ev.type === "welcome") {
          ws.terminate();
          resolve(ev);
        }
      });
      ws.on("open", () => ws.send(JSON.stringify({ type: "join", name: "dana", kind: "human" })));
    });
    assert.equal(welcome.apiUrl, "https://chat.example.com");
    await env.close();
  });
});
