import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Channels } from "../src/chat/Channels";
import { ThreadEventStore } from "../src/chat/ThreadEventStore";
import { ResourceAccessStore } from "../src/context/ResourceAccessStore";
import { ResourceManifestBuilder } from "../src/context/ResourceManifest";
import { createTestDb } from "./pgSchema";

const env = await createTestDb();
const events = new ThreadEventStore(env.db);
const channels = new Channels(env.db);
const invokers = new Set<string>();
const access = new ResourceAccessStore(env.db, events, async (_agentId, humanId) => invokers.has(humanId));
const manifest = new ResourceManifestBuilder(env.db, access);

before(async () => {
  await channels.seed([{ name: "general", isDemo: false }]);
});
after(() => env.drop());

describe("durable agent resource access", () => {
  test("requires an authorized invoking human and persists an approved channel grant", async () => {
    const agent = await env.db.upsertActor("agent", "reader");
    const human = await env.db.upsertActor("human", "grantor");
    const channel = await channels.create(human, "private-notes");
    const request = await access.request(agent, {
      resourceKind: "channel",
      resourceId: channel.id,
      reason: "Read the conversation I was asked to review",
      originChannelId: channel.id,
    });

    await assert.rejects(() => access.resolve(human, request.id, "approved"), /may not grant/i);
    invokers.add(human.id);
    const resolved = await access.resolve(human, request.id, "approved");

    assert.equal(resolved.status, "approved");
    assert.equal(await access.has(agent.id, "channel", channel.id), true);
    const grants = await access.grantsForAgent(agent.id);
    assert.equal(grants.length, 1);
    assert.equal(grants[0].reason, request.reason);

    const persisted = await env.db.sql<{ kind: string }[]>`
      SELECT kind FROM thread_events
      WHERE workspace_id = ${env.db.workspaceId} AND subject_id IN (${request.id}, ${grants[0].id})
      ORDER BY seq
    `;
    assert.deepEqual(persisted.map((event) => event.kind), ["resource.access.requested", "resource.access.granted"]);
  });

  test("manifest reveals resources but not contents and reports grant state", async () => {
    const agent = await env.db.upsertActor("agent", "manifest-reader");
    const human = await env.db.upsertActor("human", "manifest-owner");
    const channel = await channels.create(human, "manifest-room");
    const request = await access.request(agent, {
      resourceKind: "channel",
      resourceId: channel.id,
      reason: "Need the room",
    });

    const pending = await manifest.build(agent);
    assert.equal(pending.resources.find((resource) => resource.id === channel.id)?.access, "pending");
    assert.deepEqual(
      pending.resources.filter((resource) => resource.access === "default").map((resource) => resource.kind),
      ["board", "workspace_guidance", "agent_notebook"],
    );
    assert.equal(JSON.stringify(pending).includes("Need the room"), false);

    invokers.add(human.id);
    await access.resolve(human, request.id, "approved");
    const granted = await manifest.build(agent);
    assert.equal(granted.resources.find((resource) => resource.id === channel.id)?.access, "granted");
  });

  test("autoGrant skips the approval round-trip and grants immediately, once", async () => {
    const agent = await env.db.upsertActor("agent", "mentioned-agent");
    const human = await env.db.upsertActor("human", "mentioning-human");
    const channel = await channels.create(human, "auto-grant-room");

    const grant = await access.autoGrant(agent.id, human.id, {
      resourceKind: "channel",
      resourceId: channel.id,
      reason: `Mentioned in #${channel.name}`,
    });

    assert.ok(grant);
    assert.equal(await access.has(agent.id, "channel", channel.id), true);
    assert.equal((await access.requestsForAgent(agent.id)).length, 0, "no pending request should ever be created");

    // Calling it again once already granted is a harmless no-op.
    const again = await access.autoGrant(agent.id, human.id, {
      resourceKind: "channel",
      resourceId: channel.id,
      reason: "second mention",
    });
    assert.equal(again, null);
    assert.equal((await access.grantsForAgent(agent.id)).length, 1);
  });
});
