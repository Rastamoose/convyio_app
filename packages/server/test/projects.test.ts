import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Actor } from "@workspace/shared";
import { ProjectStore } from "../src/projects/ProjectStore";
import { ToolmanNodes } from "../src/projects/ToolmanNodes";
import { ThreadEventStore } from "../src/chat/ThreadEventStore";
import { createTestDb } from "./pgSchema";

describe("projects and Toolman nodes", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let drop: () => Promise<void>;
  let projects: ProjectStore;
  let nodes: ToolmanNodes;

  async function actor(kind: Actor["kind"], name: string): Promise<Actor> {
    return db.upsertActor(kind, name);
  }

  before(async () => {
    ({ db, drop } = await createTestDb());
    const events = new ThreadEventStore(db);
    projects = new ProjectStore(db, events);
    nodes = new ToolmanNodes(db, events);
  });
  after(() => drop());

  test("a human pairs a node, mounts a project, and assigns an agent", async () => {
    const human = { actor: await actor("human", "dana") };
    const agent = { actor: await actor("agent", "noodle") };
    const pairing = await nodes.createPairing(human.actor, "desk");
    const exchanged = await nodes.exchangePairing(pairing.pairingCode);
    assert.ok(exchanged);
    assert.equal(exchanged.node.name, "desk");
    assert.equal(await nodes.exchangePairing(pairing.pairingCode), null);

    const { project, mount } = await nodes.registerMount(exchanged.node.id, {
      mountKey: "convyio-core",
      projectName: "convyio-core",
      kind: "git",
      remoteUrl: "https://user:secret@github.com/acme/convyio.git",
      defaultBranch: "main",
      headRevision: "abc123",
      branch: "main",
      cleanliness: "clean",
    });
    assert.equal(project.name, "convyio-core");
    assert.equal(project.remoteUrl, "https://github.com/acme/convyio.git");
    assert.equal(mount.mountKey, "convyio-core");

    const assignment = await projects.assign(human.actor, {
      projectId: project.id,
      agentId: agent.actor.id,
      mountId: mount.id,
    });
    assert.equal(assignment.status, "pending");
    assert.ok(await projects.assignment(project.id, agent.actor.id));
  });

  test("agents cannot create projects and humans cannot request access", async () => {
    const human = { actor: await actor("human", "erin") };
    const agent = { actor: await actor("agent", "helper") };
    await assert.rejects(
      () => projects.create(agent.actor, { name: "secret", kind: "git" }),
      (err: unknown) => err instanceof Error && err.message.includes("only humans can manage projects"),
    );
    const created = await projects.create(human.actor, { name: "notes", kind: "directory" });
    await assert.rejects(
      () => projects.requestAccess(human.actor, created.id, "please"),
      (err: unknown) => err instanceof Error && err.message.includes("only agents can request project access"),
    );
  });

  test("an agent access request becomes an assignment only after a human approves it", async () => {
    const human = { actor: await actor("human", "fin") };
    const agent = { actor: await actor("agent", "scribe") };
    const pairing = await nodes.createPairing(human.actor, "laptop");
    const exchanged = await nodes.exchangePairing(pairing.pairingCode);
    const { project, mount } = await nodes.registerMount(exchanged!.node.id, {
      mountKey: "notes-dir",
      projectName: "notes-dir",
      kind: "directory",
    });
    const request = await projects.requestAccess(agent.actor, project.id, "I need the notes");
    assert.equal(request.status, "pending");
    assert.equal(await projects.assignment(project.id, agent.actor.id), null);
    await projects.resolveAccess(human.actor, request.id, "approved", mount.id);
    assert.ok(await projects.assignment(project.id, agent.actor.id));
  });
});
