import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ThreadEventStore } from "../src/chat/ThreadEventStore";
import { createEnv } from "./helpers";
import { createTestDb } from "./pgSchema";

const THREAD_MIGRATION = "20260813090000_thread_events.sql";

describe("thread event migration", () => {
  test("backfills stable message channels and both compatibility histories", async () => {
    const { db, drop } = await createTestDb({
      beforeMigration: THREAD_MIGRATION,
      seed: async (sql) => {
        await sql`
          INSERT INTO workspaces (id, name, created_at) VALUES ('workspace-1', 'test_space', 1)
        `;
        await sql`
          INSERT INTO actors (id, kind, display_name) VALUES ('actor-1', 'human', 'dana')
        `;
        await sql`
          INSERT INTO messages (
            id, author_id, author_name, author_kind, content, channel, created_at
          ) VALUES ('message-1', 'actor-1', 'dana', 'human', 'hello', 'legacy-room', 1000)
        `;
        await sql`
          INSERT INTO board_items (
            id, workspace_id, ref, title, status, origin, created_by, created_at
          ) VALUES (
            'item-1', 'workspace-1', 'task-1', 'Legacy item', 'approved',
            'human', 'actor-1', 2000
          )
        `;
        await sql`
          INSERT INTO board_events (
            workspace_id, item_id, type, actor_id, payload, created_at
          ) VALUES (
            'workspace-1', 'item-1', 'item.created', 'actor-1',
            ${JSON.stringify({ reason: "legacy" })}, 2000
          )
        `;
      },
    });
    try {
      const [message] = await db.sql<{ channel_id: string }[]>`
        SELECT channel_id FROM messages WHERE id = 'message-1'
      `;
      const [channel] = await db.sql<{ id: string; name: string }[]>`
        SELECT id, name FROM channels WHERE name = 'legacy-room'
      `;
      assert.equal(message.channel_id, channel.id);

      const events = await db.sql<
        { id: string; kind: string; channel_id: string | null; payload: Record<string, unknown> }[]
      >`
        SELECT id, kind, channel_id, payload FROM thread_events ORDER BY seq
      `;
      assert.deepEqual(events.map((event) => event.id), [
        "message.created:message-1",
        "board.event:1",
      ]);
      assert.equal(events[0].channel_id, channel.id);
      assert.equal(events[0].payload.channelId, channel.id);
      assert.equal(events[1].channel_id, null);
      assert.deepEqual(events[1].payload, {
        itemId: "item-1",
        itemRef: "task-1",
        reason: "legacy",
      });
      const [rls] = await db.sql<{ relrowsecurity: boolean }[]>`
        SELECT relrowsecurity FROM pg_class WHERE oid = 'thread_events'::regclass
      `;
      assert.equal(rls.relrowsecurity, true);
    } finally {
      await drop();
    }
  });
});

describe("ThreadEventStore", () => {
  test("a repeated actor/clientEventId returns the original event", async () => {
    const { db, drop } = await createTestDb();
    try {
      const actor = await db.upsertActor("human", "dana");
      const events = new ThreadEventStore(db);
      const first = await db.transaction((sql) =>
        events.append(sql, {
          workspaceId: db.workspaceId,
          actorId: actor.id,
          kind: "message.created",
          clientEventId: "client-1",
          payload: { messageId: "message-1" },
        }),
      );
      const repeated = await db.transaction((sql) =>
        events.append(sql, {
          workspaceId: db.workspaceId,
          actorId: actor.id,
          kind: "message.created",
          clientEventId: "client-1",
          payload: { messageId: "different" },
        }),
      );
      assert.deepEqual(repeated, first);
      const [{ count }] = await db.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM thread_events
      `;
      assert.equal(count, 1);
    } finally {
      await drop();
    }
  });
});

describe("GET /api/thread/events", () => {
  test("authenticates, validates, bounds, and pages by exclusive sequence", async () => {
    const env = await createEnv();
    try {
      const human = await env.actor("human", "dana");
      const channel = (await env.channels.get("general"))!;
      await env.db.transaction(async (sql) => {
        for (let i = 1; i <= 105; i++) {
          await env.threadEvents.append(sql, {
            workspaceId: env.db.workspaceId,
            channelId: channel.id,
            actorId: human.actor.id,
            kind: "message.created",
            subjectId: `message-${i}`,
            payload: { index: i },
          });
        }
      });

      const page = async (query: string) =>
        env.api("GET", `/api/thread/events?channel_id=${channel.id}&${query}`, human.token);
      const first = await page("limit=2");
      assert.equal(first.status, 200);
      assert.deepEqual(first.body.events.map((event: any) => event.payload.index), [104, 105]);
      const second = await page(`limit=2&before_seq=${first.body.events[0].seq}`);
      assert.equal(second.status, 200);
      assert.deepEqual(second.body.events.map((event: any) => event.payload.index), [102, 103]);
      assert.equal(
        new Set([...first.body.events, ...second.body.events].map((event: any) => event.seq)).size,
        4,
      );

      const bounded = await page("limit=1000");
      assert.equal(bounded.status, 200);
      assert.equal(bounded.body.events.length, 100);
      assert.equal((await page("limit=0")).status, 400);
      assert.equal((await page("before_seq=nope")).status, 400);
      assert.equal(
        (await env.api("GET", "/api/thread/events?limit=2", human.token)).status,
        400,
      );
      const unauthenticated = await fetch(
        `${env.baseUrl}/api/thread/events?channel_id=${channel.id}`,
      );
      assert.equal(unauthenticated.status, 401);
    } finally {
      await env.close();
    }
  });
});
