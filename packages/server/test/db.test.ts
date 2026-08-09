import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { WorkspaceDb } from "../src/db";
import { createTestDb } from "./pgSchema";

describe("WorkspaceDb", () => {
  let db: WorkspaceDb;
  let drop: () => Promise<void>;

  before(async () => {
    ({ db, drop } = await createTestDb());
  });
  after(() => drop());

  test("upsertActor creates once, reuses on repeat calls with the same name", async () => {
    const first = await db.upsertActor("human", "Dana");
    const second = await db.upsertActor("human", "dana");
    assert.equal(second.id, first.id);
    assert.equal(first.serverId, db.serverId);
  });

  test("findActorByName is case-insensitive and null when absent", async () => {
    await db.upsertActor("agent", "Noodle");
    const found = await db.findActorByName("agent", "NOODLE");
    assert.ok(found);
    assert.equal(found!.displayName, "Noodle");
    assert.equal(await db.findActorByName("agent", "nope"), null);
  });

  test("createHuman uses the given id and stores email", async () => {
    const actor = await db.createHuman("11111111-1111-1111-1111-111111111111", "Harris", "h@example.com");
    assert.equal(actor.id, "11111111-1111-1111-1111-111111111111");
    const fetched = await db.getActor(actor.id);
    assert.equal(fetched?.displayName, "Harris");
  });

  test("nextRef allocates sequential per-server refs inside a transaction", async () => {
    const refs = await db.transaction(async (sql) => {
      const a = await db.nextRef(sql, db.serverId);
      const b = await db.nextRef(sql, db.serverId);
      return [a, b];
    });
    assert.notEqual(refs[0], refs[1]);
    assert.match(refs[0], /^task-\d+$/);
  });

  test("transaction rolls back on throw", async () => {
    const before = await db.listActors("human");
    await assert.rejects(
      db.transaction(async (sql) => {
        await sql`INSERT INTO actors (id, kind, display_name, server_id) VALUES (gen_random_uuid(), 'human', 'Rollback Me', ${db.serverId})`;
        throw new Error("boom");
      }),
      /boom/,
    );
    const after = await db.listActors("human");
    assert.equal(after.length, before.length);
  });
});
