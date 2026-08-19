import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import type { ProjectAction } from "@workspace/shared";
import type { StoredToolman } from "../src/installation";
import { runNode } from "../src/runtime";

interface TestServer {
  wss: WebSocketServer;
  frames: Record<string, unknown>[];
}

describe("Toolman node runtime", () => {
  let root: string;
  let outside: string;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "toolman-runtime-"));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "toolman-runtime-outside-"));
    await fs.writeFile(path.join(root, "README.md"), "hello needle\n");
    await fs.mkdir(path.join(root, "nested"));
    await fs.writeFile(path.join(root, "nested", "file.txt"), "another needle\n");
    await fs.writeFile(path.join(root, ".env"), "needle SECRET=1\n");
    await fs.writeFile(path.join(root, "secret.pem"), "needle private\n");
    await fs.writeFile(path.join(outside, "outside.txt"), "needle outside\n");
    await fs.symlink(outside, path.join(root, "escape"));
  });

  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  test("reconnects and executes project file operations safely", async () => {
    let server = await startServer();
    const port = (server.wss.address() as AddressInfo).port;
    const controller = new AbortController();
    const running = runNode(installation(root, `ws://127.0.0.1:${port}/toolman`), controller.signal);

    try {
      await waitForFrame(server.frames, (frame) => frame.type === "toolman_hello");
      const firstSocket = openSocket(server.wss);
      firstSocket.send("{malformed");
      firstSocket.send("null");
      const malformed = await execute(server, {
        kind: "project_list_files",
        projectId: "project-1",
        path: ".",
      });
      assert.equal(malformed.ok, true);
      assert.match(String(malformed.output), /README\.md/);

      const read = await execute(server, {
        kind: "project_read_file",
        projectId: "project-1",
        path: "README.md",
      });
      assert.equal(read.output, "hello needle\n");

      assert.equal(
        (
          await execute(server, {
            kind: "project_write_file",
            projectId: "project-1",
            path: "notes/draft.txt",
            content: "first draft\n",
          })
        ).ok,
        true,
      );
      assert.equal(
        (
          await execute(server, {
            kind: "project_edit_file",
            projectId: "project-1",
            path: "notes/draft.txt",
            oldString: "first",
            newString: "second",
          })
        ).ok,
        true,
      );
      assert.equal(
        (
          await execute(server, {
            kind: "project_move_file",
            projectId: "project-1",
            from: "notes/draft.txt",
            to: "archive/final.txt",
          })
        ).ok,
        true,
      );
      assert.equal(await fs.readFile(path.join(root, "archive", "final.txt"), "utf8"), "second draft\n");
      assert.equal(
        (
          await execute(server, {
            kind: "project_delete_file",
            projectId: "project-1",
            path: "archive/final.txt",
          })
        ).ok,
        true,
      );
      await assert.rejects(fs.stat(path.join(root, "archive", "final.txt")), /ENOENT/);

      const search = await execute(server, {
        kind: "project_search_files",
        projectId: "project-1",
        query: "needle",
      });
      assert.equal(search.ok, true);
      assert.match(String(search.output), /README\.md:1:hello needle/);
      assert.match(String(search.output), /nested\/file\.txt:1:another needle/);
      assert.doesNotMatch(String(search.output), /\.env|secret\.pem|escape|outside/);

      for (const deniedPath of ["nested/../README.md", "/etc/passwd", "escape", ".env"]) {
        const denied = await execute(server, {
          kind: "project_search_files",
          projectId: "project-1",
          query: "needle",
          path: deniedPath,
        });
        assert.equal(denied.ok, false, deniedPath);
      }

      const marker = path.join(outside, "injected");
      const injection = await execute(server, {
        kind: "project_search_files",
        projectId: "project-1",
        query: `needle'; touch '${marker}' #`,
      });
      assert.equal(injection.ok, true);
      await assert.rejects(fs.stat(marker), /ENOENT/);

      await stopServer(server);
      server = await startServer(port);
      await waitForFrame(server.frames, (frame) => frame.type === "toolman_hello");
      const afterRestart = await execute(server, {
        kind: "project_read_file",
        projectId: "project-1",
        path: "README.md",
      });
      assert.equal(afterRestart.output, "hello needle\n");
    } finally {
      controller.abort();
      await running;
      await stopServer(server);
    }
  });
});

async function startServer(port = 0): Promise<TestServer> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  const frames: Record<string, unknown>[] = [];
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type === "toolman_hello") socket.send(JSON.stringify({ type: "toolman_welcome" }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  return { wss, frames };
}

async function stopServer(server: TestServer): Promise<void> {
  for (const socket of server.wss.clients) socket.terminate();
  await new Promise<void>((resolve, reject) => {
    server.wss.close((error) => (error ? reject(error) : resolve()));
  });
}

async function execute(server: TestServer, action: ProjectAction): Promise<Record<string, unknown>> {
  const requestId = `request-${server.frames.length}`;
  openSocket(server.wss).send(
    JSON.stringify({
      type: "toolman_execute",
      requestId,
      action,
      checkoutKey: "checkout-1",
      agentId: "agent-1",
      projectId: "project-1",
    }),
  );
  return waitForFrame(
    server.frames,
    (frame) => frame.type === "toolman_execution_result" && frame.requestId === requestId,
  );
}

function openSocket(wss: WebSocketServer): WebSocket {
  const socket = [...wss.clients].find((candidate) => candidate.readyState === WebSocket.OPEN);
  if (!socket) throw new Error("Toolman socket is not open");
  return socket;
}

async function waitForFrame(
  frames: Record<string, unknown>[],
  predicate: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const frame = frames.find(predicate);
    if (frame) return frame;
    if (Date.now() > deadline) throw new Error("timed out waiting for Toolman frame");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function installation(absolutePath: string, wsUrl: string): StoredToolman {
  return {
    node: { id: "node-1", workspaceId: "ws-1", name: "desk", createdBy: "human-1", createdAt: 1, revokedAt: null },
    installation: { id: "installation-1", nodeId: "node-1", createdAt: 1 },
    installationToken: "token",
    workspace: { id: "ws-1", name: "space" },
    apiUrl: "http://127.0.0.1",
    wsUrl,
    serverOrigin: "http://127.0.0.1",
    pairedAt: 1,
    mounts: [
      {
        mountKey: "mount-1",
        projectId: "project-1",
        projectName: "project",
        kind: "directory",
        absolutePath,
      },
    ],
  };
}
