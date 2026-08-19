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
    const other = { actor: await actor("human", "dana-other") };
    const agent = { actor: await actor("agent", "noodle") };
    const pairing = await nodes.createPairing(human.actor, "desk");
    const exchanged = await nodes.exchangePairing(pairing.pairingCode);
    assert.ok(exchanged);
    assert.equal(exchanged.node.name, "desk");
    assert.equal(await nodes.exchangePairing(pairing.pairingCode), null);
    await assert.rejects(
      () => nodes.createPairing(other.actor, "desk"),
      (err: unknown) => err instanceof Error && err.message.includes("another member already paired"),
    );
    await assert.rejects(
      () => nodes.revoke(other.actor, exchanged.node.id),
      (err: unknown) => err instanceof Error && err.message.includes("no such Toolman node"),
    );

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
    assert.equal(assignment.status, "ready");
    assert.ok(await projects.assignment(project.id, agent.actor.id));
    assert.equal((await nodes.findActiveMountById(mount.id))?.id, mount.id);
    await nodes.revoke(human.actor, exchanged.node.id);
    assert.equal(await nodes.findActiveMountById(mount.id), null);

    const repair = await nodes.createPairing(human.actor, "desk");
    const repaired = await nodes.exchangePairing(repair.pairingCode);
    assert.equal(repaired?.node.id, exchanged.node.id);
    assert.equal(repaired?.node.revokedAt, null);
    assert.equal((await nodes.findActiveMountById(mount.id))?.id, mount.id);
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

  test("an agent access request becomes an assignment only after its owner approves it", async () => {
    const human = { actor: await actor("human", "fin") };
    const other = { actor: await actor("human", "fin-other") };
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
    assert.equal((await projects.pendingAccess(human.actor))[0]?.projectName, "notes-dir");
    assert.equal((await projects.pendingAccess(other.actor)).length, 0);
    const access = (await projects.agentAccess(agent.actor)).find((entry) => entry.project.id === project.id);
    assert.equal(access?.assignment, null);
    assert.equal(access?.request?.id, request.id);
    await assert.rejects(
      () => projects.resolveAccess(other.actor, request.id, "approved", mount.id),
      (err: unknown) => err instanceof Error && err.message.includes("only the folder owner"),
    );
    await projects.resolveAccess(human.actor, request.id, "approved", mount.id);
    assert.ok(await projects.assignment(project.id, agent.actor.id));
  });

  test("only the folder owner can change its access mode", async () => {
    const owner = { actor: await actor("human", "gale") };
    const other = { actor: await actor("human", "harper") };
    const created = await projects.create(owner.actor, { name: "desk-notes", kind: "directory" });
    assert.equal(created.accessMode, "ask");
    const updated = await projects.setAccessMode(owner.actor, created.id, "always");
    assert.equal(updated.accessMode, "always");
    await assert.rejects(
      () => projects.setAccessMode(other.actor, created.id, "deny"),
      (err: unknown) => err instanceof Error && err.message.includes("only the folder owner"),
    );
  });

  test("only the owner can permanently remove a device without deleting local files", async () => {
    const owner = { actor: await actor("human", "device-owner") };
    const other = { actor: await actor("human", "device-other") };
    const agent = { actor: await actor("agent", "device-agent") };
    const pairing = await nodes.createPairing(owner.actor, "delete-device");
    const exchanged = await nodes.exchangePairing(pairing.pairingCode);
    const { project, mount } = await nodes.registerMount(exchanged!.node.id, {
      mountKey: "delete-device-mount",
      projectName: "delete-device-folder",
      kind: "directory",
    });
    await projects.assign(owner.actor, { projectId: project.id, agentId: agent.actor.id, mountId: mount.id });

    await assert.rejects(
      () => nodes.removeNode(other.actor, exchanged!.node.id),
      (err: unknown) => err instanceof Error && err.message.includes("no such Toolman node"),
    );
    await assert.rejects(
      () => nodes.removeNode(owner.actor, exchanged!.node.id),
      (err: unknown) => err instanceof Error && err.message.includes("revoke the device before deleting it"),
    );
    await nodes.revoke(owner.actor, exchanged!.node.id);
    const removed = await nodes.removeNode(owner.actor, exchanged!.node.id);
    assert.equal(removed.id, exchanged!.node.id);
    assert.equal((await nodes.list()).some((node) => node.id === exchanged!.node.id), false);
    assert.equal(await nodes.findMountById(mount.id), null);
    assert.equal(await projects.assignment(project.id, agent.actor.id), null);
    assert.ok((await projects.find(project.id))?.archivedAt);

    const replacementPairing = await nodes.createPairing(other.actor, "delete-device");
    const replacement = await nodes.exchangePairing(replacementPairing.pairingCode);
    assert.notEqual(replacement?.node.id, exchanged!.node.id);
  });

  test("folder names cannot merge mounts owned by different humans", async () => {
    const owner = { actor: await actor("human", "mount-owner") };
    const other = { actor: await actor("human", "mount-other") };
    await nodes.createPairing(owner.actor, "pending-owner-node");
    await assert.rejects(
      () => nodes.createPairing(other.actor, "pending-owner-node"),
      (err: unknown) => err instanceof Error && err.message.includes("another member already paired"),
    );
    const ownerPairing = await nodes.createPairing(owner.actor, "owner-node");
    const ownerNode = await nodes.exchangePairing(ownerPairing.pairingCode);
    const first = await nodes.registerMount(ownerNode!.node.id, {
      mountKey: "mount-one",
      projectName: "shared-name",
      kind: "directory",
    });
    const repeated = await nodes.registerMount(ownerNode!.node.id, {
      mountKey: "mount-two",
      projectName: "shared-name",
      kind: "directory",
    });
    assert.equal(repeated.mount.id, first.mount.id);
    const otherPairing = await nodes.createPairing(other.actor, "other-node");
    const otherNode = await nodes.exchangePairing(otherPairing.pairingCode);
    await assert.rejects(
      () => nodes.registerMount(otherNode!.node.id, {
        mountKey: "other-mount",
        projectName: "shared-name",
        kind: "directory",
      }),
      (err: unknown) => err instanceof Error && err.message.includes("another project already uses"),
    );
  });

  test("removing one folder mount preserves the project until its final mount is removed", async () => {
    const owner = { actor: await actor("human", "folder-remover") };
    const other = { actor: await actor("human", "folder-remover-other") };
    const firstAgent = { actor: await actor("agent", "folder-agent-one") };
    const secondAgent = { actor: await actor("agent", "folder-agent-two") };
    const firstPairing = await nodes.createPairing(owner.actor, "folder-node-one");
    const firstNode = await nodes.exchangePairing(firstPairing.pairingCode);
    const first = await nodes.registerMount(firstNode!.node.id, {
      mountKey: "folder-mount-one",
      projectName: "removable-folder",
      kind: "directory",
    });
    const secondPairing = await nodes.createPairing(owner.actor, "folder-node-two");
    const secondNode = await nodes.exchangePairing(secondPairing.pairingCode);
    const second = await nodes.registerMount(secondNode!.node.id, {
      mountKey: "folder-mount-two",
      projectName: "removable-folder",
      kind: "directory",
    });
    await projects.assign(owner.actor, { projectId: first.project.id, agentId: firstAgent.actor.id, mountId: first.mount.id });
    await projects.assign(owner.actor, { projectId: first.project.id, agentId: secondAgent.actor.id, mountId: second.mount.id });

    await assert.rejects(
      () => nodes.removeMount(other.actor, first.project.id, first.mount.id),
      (err: unknown) => err instanceof Error && err.message.includes("only the folder owner"),
    );
    const removedFirst = await nodes.removeMount(owner.actor, first.project.id, first.mount.id);
    assert.equal(removedFirst.projectArchived, false);
    assert.equal((await nodes.mountsForProject(first.project.id)).length, 1);
    assert.equal(await projects.assignment(first.project.id, firstAgent.actor.id), null);
    assert.ok(await projects.assignment(first.project.id, secondAgent.actor.id));

    const removedLast = await nodes.removeMountFromNode(secondNode!.node.id, second.mount.mountKey);
    assert.equal(removedLast.projectArchived, true);
    assert.ok((await projects.find(first.project.id))?.archivedAt);
    assert.equal((await projects.list()).some((project) => project.id === first.project.id), false);

    const restored = await nodes.registerMount(secondNode!.node.id, {
      mountKey: "folder-mount-restored",
      projectName: "removable-folder",
      kind: "directory",
    });
    assert.equal(restored.project.id, first.project.id);
    assert.equal(restored.project.archivedAt, null);
  });

  test("only the folder owner can grant and revoke assignments", async () => {
    const owner = { actor: await actor("human", "ivy") };
    const other = { actor: await actor("human", "jules") };
    const agent = { actor: await actor("agent", "writer") };
    const pairing = await nodes.createPairing(owner.actor, "ivy-desk");
    const exchanged = await nodes.exchangePairing(pairing.pairingCode);
    const { project, mount } = await nodes.registerMount(exchanged!.node.id, {
      mountKey: "ivy-files",
      projectName: "ivy-files",
      kind: "directory",
    });
    await assert.rejects(
      () => projects.assign(other.actor, { projectId: project.id, agentId: agent.actor.id, mountId: mount.id }),
      (err: unknown) => err instanceof Error && err.message.includes("only the project owner"),
    );
    await projects.assign(owner.actor, { projectId: project.id, agentId: agent.actor.id, mountId: mount.id });
    await assert.rejects(
      () => projects.revoke(other.actor, project.id, agent.actor.id),
      (err: unknown) => err instanceof Error && err.message.includes("only the project owner"),
    );
    await projects.revoke(owner.actor, project.id, agent.actor.id);
    assert.equal(await projects.assignment(project.id, agent.actor.id), null);
  });
});
