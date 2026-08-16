import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { AgentInvites } from "../src/auth/AgentInvites";
import { Roster } from "../src/roster";
import { createWsEnv } from "./helpers";
import { createTestDb } from "./pgSchema";

describe("human presence persistence", async () => {
  const env = await createWsEnv();
  after(() => env.close());

  test("a human's last disconnect leaves them in the roster as offline; rejoining flips them back online", async () => {
    const dana = await env.connect("dana", "human");
    const erik = await env.connect("erik", "human");

    dana.ws.close();
    const sync = await erik.next(
      (e) =>
        e.type === "presence_sync" &&
        e.participants.some((p: any) => p.name === "dana" && p.online === false),
    );
    const offline = sync.participants.find((p: any) => p.name === "dana");
    assert.equal(offline.id, dana.welcome.self.id);
    assert.equal(offline.kind, "human");
    // The API tokens still die with the last connection.
    assert.equal(env.sessions.resolve(dana.token), null);

    const rejoined = await env.connect("dana", "human");
    assert.equal(rejoined.welcome.self.id, dana.welcome.self.id);
    const back = rejoined.welcome.participants.filter((p: any) => p.name === "dana");
    assert.equal(back.length, 1);
    assert.equal(back[0].online, true);
  });
});

describe("Roster.create preload", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let drop: () => Promise<void>;
  let roster: Roster;

  before(async () => {
    ({ db, drop } = await createTestDb());
    await db.createHuman(randomUUID(), "Harris", "h@example.com");
    await db.upsertActor("human", "Persona");
    roster = await Roster.create(db, new AgentInvites(db));
  });
  after(() => drop());

  test("a registered human is pre-loaded as an offline participant", () => {
    const harris = roster.list().find((p) => p.name === "Harris");
    assert.ok(harris, "expected the registered human in the roster");
    assert.equal(harris!.kind, "human");
    assert.equal(harris!.online, false);
    assert.equal(harris!.status, "");
    assert.equal(harris!.runState, "idle");
  });

  test("a persona human created via upsertActor is not pre-loaded (non-member)", () => {
    assert.equal(
      roster.list().find((p) => p.name === "Persona"),
      undefined,
    );
  });

  test("adding a member is immediate and does not overwrite live presence", async () => {
    const newcomer = await db.createHuman(randomUUID(), "Newcomer", "newcomer@example.com");
    await roster.addOffline(newcomer.id);
    assert.equal(roster.list().find((participant) => participant.id === newcomer.id)?.online, false);
    await roster.join("human", newcomer.displayName, newcomer.id);
    await roster.addOffline(newcomer.id);
    assert.equal(roster.list().find((participant) => participant.id === newcomer.id)?.online, true);
  });
});
