import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import type { ChatMessage } from "@workspace/shared";
import { Channels } from "../src/chat/Channels";
import { MessageStore } from "../src/chat/MessageStore";
import { ThreadEventStore } from "../src/chat/ThreadEventStore";
import { createTestDb } from "./pgSchema";
import { Sessions } from "../src/board/sessions";
import { authorizeMutation } from "../src/board/Toolman";
import { scopeAllows, validateScopePaths } from "../src/board/scope";
import { loadDemoScripts } from "../src/demo/script";
import { createEnv } from "./helpers";

describe("scope authorization", async () => {
  const env = await createEnv();
  const human = await env.actor("human", "dana");
  const agent = await env.actor("agent", "noodle");
  after(() => env.close());

  const approvedProposal = async (scopePaths: string[]) => {
    const { body } = await env.api("POST", "/api/board/items", agent.token, {
      title: "scoped work",
      why: "w",
      effect: "e",
      scopePaths,
    });
    await env.api("POST", `/api/board/items/${body.item.id}/approve`, human.token);
    return body.item;
  };

  test("write inside declared scope is allowed; outside is SCOPE_VIOLATION", async () => {
    const item = await approvedProposal(["billing/", "notes.md"]);
    const inside = await authorizeMutation(
      agent.actor,
      item.ref,
      { name: "write_file", path: "billing/round.ts" },
      env.service,
    );
    assert.equal(inside.allow, true);

    const exactFile = await authorizeMutation(
      agent.actor,
      item.ref,
      { name: "write_file", path: "notes.md" },
      env.service,
    );
    assert.equal(exactFile.allow, true);

    const outside = await authorizeMutation(
      agent.actor,
      item.ref,
      { name: "write_file", path: "secrets/keys.txt" },
      env.service,
    );
    assert.equal(outside.allow, false);
    assert.equal(!outside.allow && outside.code, "SCOPE_VIOLATION");
  });

  test("scope cannot be escaped through path tricks", async () => {
    const item = await approvedProposal(["billing/"]);
    for (const sneaky of ["billing/../secrets.txt", "billing/../../etc/passwd", "/billing/x"]) {
      const authz = await authorizeMutation(
        agent.actor,
        item.ref,
        { name: "write_file", path: sneaky },
        env.service,
      );
      assert.equal(authz.allow, false, `path ${sneaky} must be refused`);
    }
    // Normalization inside the scope is fine.
    const normal = await authorizeMutation(
      agent.actor,
      item.ref,
      { name: "write_file", path: "billing/sub/../round.ts" },
      env.service,
    );
    assert.equal(normal.allow, true);
  });

  test("read-only actions are not scope-gated", async () => {
    const item = await approvedProposal(["billing/"]);
    const read = await authorizeMutation(
      agent.actor,
      item.ref,
      { name: "read_file", path: "anywhere/else.txt" },
      env.service,
    );
    assert.equal(read.allow, true);
  });

  test("agent proposal without scopePaths → 400 SCOPE_REQUIRED", async () => {
    const res = await env.api("POST", "/api/board/items", agent.token, {
      title: "unscoped",
      why: "w",
      effect: "e",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "SCOPE_REQUIRED");
  });

  test("invalid scope entries → 400 BAD_SCOPE", async () => {
    for (const bad of [["../escape/"], ["/absolute/path"], [".."]]) {
      const res = await env.api("POST", "/api/board/items", agent.token, {
        title: "bad scope",
        why: "w",
        effect: "e",
        scopePaths: bad,
      });
      assert.equal(res.status, 400, `scope ${JSON.stringify(bad)} must be refused`);
      assert.equal(res.body.error, "BAD_SCOPE");
    }
  });

  test("human item without scope stays unrestricted; human can narrow via PATCH", async () => {
    const { body: created } = await env.api("POST", "/api/board/items", human.token, {
      title: "human item",
    });
    const anywhere = await authorizeMutation(
      agent.actor,
      created.item.ref,
      { name: "write_file", path: "any/where.txt" },
      env.service,
    );
    assert.equal(anywhere.allow, true);

    const patched = await env.api("PATCH", `/api/board/items/${created.item.id}`, human.token, {
      scopePaths: ["docs/"],
    });
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.body.item.scopePaths, ["docs/"]);
    const outside = await authorizeMutation(
      agent.actor,
      created.item.ref,
      { name: "write_file", path: "any/where.txt" },
      env.service,
    );
    assert.equal(outside.allow, false);
    assert.equal(!outside.allow && outside.code, "SCOPE_VIOLATION");
  });

  test("agents cannot edit scopePaths", async () => {
    const item = await approvedProposal(["billing/"]);
    const res = await env.api("PATCH", `/api/board/items/${item.id}`, agent.token, {
      scopePaths: ["everything/"],
    });
    assert.equal(res.status, 403);
  });

  test("scopeAllows and validateScopePaths edge cases", () => {
    assert.equal(scopeAllows(["billing/"], "billing"), true);
    assert.equal(scopeAllows(["billing/"], "billing-other/file.ts"), false);
    assert.equal(scopeAllows(["a.md"], "a.md"), true);
    assert.equal(scopeAllows(["a.md"], "a.md/nested"), false);
    assert.ok("error" in validateScopePaths([""]));
    assert.ok("error" in validateScopePaths(["./"]));
    assert.deepEqual(validateScopePaths(["./billing/", "a/./b.md"]), {
      paths: ["billing/", "a/b.md"],
    });
  });
});

describe("sessions", () => {
  test("expired tokens stop resolving", async () => {
    const sessions = new Sessions(20);
    const token = sessions.issue("actor-1");
    assert.equal(sessions.resolve(token), "actor-1");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sessions.resolve(token), null);
  });

  test("revokeFor kills every token of one actor and nobody else's", () => {
    const sessions = new Sessions();
    const a1 = sessions.issue("actor-1");
    const a2 = sessions.issue("actor-1");
    const b = sessions.issue("actor-2");
    sessions.revokeFor("actor-1");
    assert.equal(sessions.resolve(a1), null);
    assert.equal(sessions.resolve(a2), null);
    assert.equal(sessions.resolve(b), "actor-2");
  });
});

describe("message store", () => {
  const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
    id: randomUUID(),
    authorId: "a1",
    authorName: "dana",
    authorKind: "human",
    content: "hello",
    timestamp: Date.now(),
    channel: "general",
    ...over,
  });

  test("append/list round-trips messages in order, traces included", async () => {
    const { db, drop } = await createTestDb();
    try {
      const store = new MessageStore(db, new ThreadEventStore(db));
      const channels = new Channels(db);
      await channels.seed([{ name: "general", isDemo: false }]);
      const channel = (await channels.get("general"))!;
      const actor = await db.upsertActor("human", "dana");
      const first = message({ authorId: actor.id, channelId: channel.id, timestamp: 1000 });
      const second = message({
        authorId: actor.id,
        channelId: channel.id,
        timestamp: 2000,
        trace: [{ kind: "thought", content: "hmm" }],
        runId: "run-1",
      });
      await store.append(first);
      await store.append(second);
      const listed = await store.list();
      assert.deepEqual(listed, [first, second]);
    } finally {
      await drop();
    }
  });

  test("clear removes one channel or everything", async () => {
    const { db, drop } = await createTestDb();
    try {
      const store = new MessageStore(db, new ThreadEventStore(db));
      const channels = new Channels(db);
      await channels.seed([
        { name: "general", isDemo: false },
        { name: "demo", isDemo: true },
      ]);
      const general = (await channels.get("general"))!;
      const demo = (await channels.get("demo"))!;
      const actor = await db.upsertActor("human", "dana");
      await store.append(message({ authorId: actor.id, channelId: general.id, channel: general.name }));
      await store.append(message({ authorId: actor.id, channelId: demo.id, channel: demo.name }));
      await store.clear(actor.id, demo);
      assert.equal((await store.list()).length, 1);
      assert.equal((await store.list())[0].channel, "general");
      await store.clear(actor.id);
      assert.equal((await store.list()).length, 0);
    } finally {
      await drop();
    }
  });
});

describe("demo scripts", () => {
  test("shipped scripts load and every step author is a persona", async () => {
    const scriptsDir = path.resolve(import.meta.dirname, "../assets/demo/scripts");
    const scripts = await loadDemoScripts(scriptsDir);
    assert.ok(scripts.has("demo"));
    assert.ok(scripts.has("demo-bug"));
    assert.equal(scripts.get("demo-bug")!.seedDir, "billing");
  });

  test("a script with an unknown step author is rejected", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-scripts-"));
    fs.writeFileSync(
      path.join(dir, "bad.json"),
      JSON.stringify({
        channel: "x",
        personas: ["a"],
        steps: [{ author: "ghost", say: "hi" }],
      }),
    );
    await assert.rejects(() => loadDemoScripts(dir));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
