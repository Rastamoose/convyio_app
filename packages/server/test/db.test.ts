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

  test("a fresh schema bootstraps a workspace named test_space", () => {
    assert.equal(db.workspaceName, "test_space");
    assert.ok(db.workspaceId);
  });

  test("upsertActor creates once, reuses on repeat calls with the same name", async () => {
    const first = await db.upsertActor("human", "Dana");
    const second = await db.upsertActor("human", "dana");
    assert.equal(second.id, first.id);
    assert.equal(first.workspaceId, db.workspaceId);
  });

  test("upsertActor('human') creates identity only, never membership", async () => {
    const persona = await db.upsertActor("human", "Persona");
    assert.equal(await db.isMember(persona.id), false);
    assert.ok(!(await db.listMembers()).some((m) => m.id === persona.id));
  });

  test("upsertActor('agent') registers the agent as a workspace member", async () => {
    const agent = await db.upsertActor("agent", "Registered Bot");
    assert.equal(await db.isMember(agent.id), true);
    assert.ok((await db.listMembers("agent")).some((m) => m.id === agent.id));
  });

  test("findActorByName is case-insensitive and null when absent", async () => {
    await db.upsertActor("agent", "Noodle");
    const found = await db.findActorByName("agent", "NOODLE");
    assert.ok(found);
    assert.equal(found!.displayName, "Noodle");
    assert.equal(await db.findActorByName("agent", "nope"), null);
  });

  test("removeMember drops membership but keeps the actor row; a second call reports no-op", async () => {
    const actor = await db.upsertActor("agent", "Removable Bot");
    assert.equal(await db.isMember(actor.id), true);
    assert.equal(await db.removeMember(actor.id), true);
    assert.equal(await db.isMember(actor.id), false);
    assert.ok(await db.getActor(actor.id), "actor row survives removal");
    assert.equal(await db.removeMember(actor.id), false);
  });

  test("createHuman uses the given id, stores email, and registers membership", async () => {
    const actor = await db.createHuman("11111111-1111-1111-1111-111111111111", "Harris", "h@example.com");
    assert.equal(actor.id, "11111111-1111-1111-1111-111111111111");
    const fetched = await db.getActor(actor.id);
    assert.equal(fetched?.displayName, "Harris");
    assert.equal(await db.isMember(actor.id), true);
    assert.ok((await db.listMembers("human")).some((m) => m.id === actor.id));
  });

  test("nextRef allocates sequential per-workspace refs inside a transaction", async () => {
    const refs = await db.transaction(async (sql) => {
      const a = await db.nextRef(sql, db.workspaceId);
      const b = await db.nextRef(sql, db.workspaceId);
      return [a, b];
    });
    assert.notEqual(refs[0], refs[1]);
    assert.match(refs[0], /^task-\d+$/);
  });

  test("transaction rolls back on throw", async () => {
    const countActors = async () =>
      (await db.sql<{ c: number }[]>`SELECT count(*) AS c FROM actors`)[0].c;
    const before = await countActors();
    await assert.rejects(
      db.transaction(async (sql) => {
        await sql`INSERT INTO actors (id, kind, display_name) VALUES (gen_random_uuid(), 'human', 'Rollback Me')`;
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(await countActors(), before);
  });
});
