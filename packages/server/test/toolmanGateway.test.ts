import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { WebSocket } from "ws";
import { ThreadEventStore } from "../src/chat/ThreadEventStore";
import { ProjectStore } from "../src/projects/ProjectStore";
import { ToolmanGateway } from "../src/projects/ToolmanGateway";
import { ToolmanNodes } from "../src/projects/ToolmanNodes";
import { createTestDb } from "./pgSchema";

describe("Toolman gateway", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let drop: () => Promise<void>;
  let server: http.Server;
  let gateway: ToolmanGateway;
  let nodes: ToolmanNodes;
  let projects: ProjectStore;
  let baseUrl: string;

  before(async () => {
    const created = await createTestDb();
    db = created.db;
    drop = created.drop;
    const events = new ThreadEventStore(db);
    nodes = new ToolmanNodes(db, events);
    projects = new ProjectStore(db, events);
    gateway = new ToolmanGateway(null, nodes, projects);
    server = http.createServer();
    server.on("upgrade", (request, socket, head) => gateway.handleUpgrade(request, socket, head));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await drop();
  });

  test("rejects unauthenticated results and stops revoked nodes from executing", async () => {
    const unauthenticated = new WebSocket(baseUrl);
    await onceOpen(unauthenticated);
    const unauthenticatedClosed = onceClose(unauthenticated);
    unauthenticated.send(JSON.stringify({ type: "toolman_execution_result", requestId: "guessed", ok: true }));
    await unauthenticatedClosed;

    const owner = await db.upsertActor("human", "owner");
    const agent = await db.upsertActor("agent", "agent");
    const pairing = await nodes.createPairing(owner, "desk");
    const exchanged = await nodes.exchangePairing(pairing.pairingCode);
    assert.ok(exchanged);
    const { project, mount } = await nodes.registerMount(exchanged.node.id, {
      mountKey: "mount",
      projectName: "gateway-project",
      kind: "directory",
    });
    const assignment = await projects.assign(owner, { projectId: project.id, agentId: agent.id, mountId: mount.id });

    const node = new WebSocket(baseUrl);
    await onceOpen(node);
    const frames: Record<string, unknown>[] = [];
    node.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type === "toolman_execute") {
        node.send(JSON.stringify({
          type: "toolman_execution_result",
          requestId: frame.requestId,
          ok: true,
          output: "contents",
        }));
      }
    });
    node.send(JSON.stringify({ type: "toolman_hello", token: exchanged.installationToken }));
    await waitFor(() => frames.some((frame) => frame.type === "toolman_welcome"));
    assert.equal(gateway.isOnline(exchanged.node.id), true);

    const result = await gateway.execute(assignment, {
      kind: "project_read_file",
      projectId: project.id,
      path: "README.md",
    });
    assert.deepEqual(result, { ok: true, output: "contents", error: undefined });

    await nodes.revoke(owner, exchanged.node.id);
    const denied = await gateway.execute(assignment, {
      kind: "project_read_file",
      projectId: project.id,
      path: "README.md",
    });
    assert.equal(denied.code, "CHECKOUT_UNAVAILABLE");
    node.terminate();
  });
});

function onceOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function onceClose(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
