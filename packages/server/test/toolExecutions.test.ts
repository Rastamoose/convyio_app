import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ThreadEventStore } from "../src/chat/ThreadEventStore";
import { ProjectStore } from "../src/projects/ProjectStore";
import { ToolExecutionStore } from "../src/projects/ToolExecutionStore";
import { ToolmanNodes } from "../src/projects/ToolmanNodes";
import { createTestDb } from "./pgSchema";

describe("tool executions", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let drop: () => Promise<void>;
  let executions: ToolExecutionStore;

  before(async () => {
    ({ db, drop } = await createTestDb());
    const events = new ThreadEventStore(db);
    executions = new ToolExecutionStore(db, events);
    const projects = new ProjectStore(db, events);
    const nodes = new ToolmanNodes(db, events);
    const human = await db.upsertActor("human", "dana");
    const agent = await db.upsertActor("agent", "noodle");
    const pairing = await nodes.createPairing(human, "desk");
    const exchanged = await nodes.exchangePairing(pairing.pairingCode);
    const { project, mount } = await nodes.registerMount(exchanged!.node.id, {
      mountKey: "notes",
      projectName: "notes",
      kind: "directory",
    });
    await projects.assign(human, { projectId: project.id, agentId: agent.id, mountId: mount.id });
    const started = await executions.start({
      agentId: agent.id,
      projectId: project.id,
      mountId: mount.id,
      nodeId: exchanged!.node.id,
      boardItemRef: "task-1",
      action: { kind: "project_run_command", projectId: project.id, command: "npm test" },
    });
    assert.equal(started.execution.status, "running");
    const finished = await executions.finish(started.execution.id, { ok: true, output: "81 passing" });
    assert.equal(finished.execution.status, "completed");
    assert.equal(finished.execution.outputPreview, "81 passing");
    const recent = await executions.listRecent();
    assert.equal(recent.some((row) => row.id === started.execution.id), true);
    assert.equal(await executions.sweepExpired(), 0);
  });
  after(() => drop());

  test("an execution lands running and finishes completed", () => {
    assert.ok(true);
  });
});
