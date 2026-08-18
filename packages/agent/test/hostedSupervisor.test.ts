import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { HostedUsageLimiter } from "../src/hostedLimiter";
import { HostedSupervisor, httpUrlFromWs, type HostedWorkspace } from "../src/hostedSupervisor";

const workspaces: HostedWorkspace[] = [
  { id: "workspace-a", name: "A", actorId: "noodle-a", wsUrl: "wss://app.convyio.com/ws/workspace-a" },
  { id: "workspace-b", name: "B", actorId: "noodle-b", wsUrl: "wss://app.convyio.com/ws/workspace-b" },
];

function options(
  fetchWorkspaces: () => Promise<HostedWorkspace[]>,
  runAgent: NonNullable<ConstructorParameters<typeof HostedSupervisor>[0]["runAgent"]>,
) {
  return {
    apiUrl: "https://app.convyio.com",
    token: "hosted-token",
    name: "noodle",
    provider: "gemini" as const,
    model: "gemini-test",
    geminiApiKey: "gemini-key",
    workspace: "/workspace",
    dataDir: "/data",
    charter: "help",
    limiter: new HostedUsageLimiter(),
    fetchWorkspaces,
    runAgent,
  };
}

describe("hosted supervisor", () => {
  test("converts websocket origins to HTTP", () => {
    assert.equal(httpUrlFromWs("ws://localhost:3001"), "http://localhost:3001");
    assert.equal(httpUrlFromWs("wss://app.convyio.com"), "https://app.convyio.com");
  });

  test("keeps the manifest poll alive without active connections", () => {
    const supervisor = new HostedSupervisor(options(async () => [], async () => ({ close() {} })));
    supervisor.start();
    const timer = (supervisor as unknown as { timer: NodeJS.Timeout }).timer;
    assert.equal(timer.hasRef(), true);
    supervisor.close();
  });

  test("a failed first poll leaves the timer referenced so the process stays up", async () => {
    const supervisor = new HostedSupervisor(options(async () => {
      throw new Error("hosted workspace list returned HTTP 401");
    }, async () => ({ close() {} })));
    supervisor.start();
    await supervisor.sync();
    const timer = (supervisor as unknown as { timer: NodeJS.Timeout }).timer;
    assert.equal(timer.hasRef(), true);
    supervisor.close();
  });

  test("opens isolated connections and closes removed workspaces", async () => {
    let manifest = workspaces;
    const opened: Array<{ wsUrl: string; dataDir: string }> = [];
    const closed: string[] = [];
    const supervisor = new HostedSupervisor(options(
      async () => manifest,
      async (configuration) => {
        assert.equal(configuration.mode, "legacy");
        opened.push({ wsUrl: configuration.wsUrl, dataDir: configuration.dataDir });
        return { close: () => closed.push(configuration.wsUrl) };
      },
    ));

    await supervisor.sync();
    assert.deepEqual(opened, [
      { wsUrl: workspaces[0].wsUrl, dataDir: path.join("/data", workspaces[0].id) },
      { wsUrl: workspaces[1].wsUrl, dataDir: path.join("/data", workspaces[1].id) },
    ]);

    manifest = [workspaces[1]];
    await supervisor.sync();
    assert.deepEqual(closed, [workspaces[0].wsUrl]);
    assert.equal(opened.length, 2);

    supervisor.close();
    assert.deepEqual(closed, [workspaces[0].wsUrl, workspaces[1].wsUrl]);
  });

  test("retries a failed workspace without blocking the others", async () => {
    let attempts = 0;
    const opened: string[] = [];
    const supervisor = new HostedSupervisor(options(
      async () => workspaces,
      async (configuration) => {
        attempts += 1;
        if (configuration.mode === "legacy" && configuration.wsUrl === workspaces[0].wsUrl && attempts === 1) {
          throw new Error("temporary failure");
        }
        opened.push(configuration.mode === "legacy" ? configuration.wsUrl : "installation");
        return { close() {} };
      },
    ));

    await supervisor.sync();
    assert.deepEqual(opened, [workspaces[1].wsUrl]);
    await supervisor.sync();
    assert.deepEqual(opened, [workspaces[1].wsUrl, workspaces[0].wsUrl]);
    supervisor.close();
  });
});
