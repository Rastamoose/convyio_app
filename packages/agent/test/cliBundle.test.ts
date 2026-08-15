import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { saveInstallation, type StoredInstallation } from "../src/installation";
import { tempDir } from "./helpers";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = path.join(packageRoot, "dist", "cli.js");

describe("bundled convyio-agent CLI", () => {
  test("run loads the ESM bundle without hitting esbuild's dynamic-require stub", async () => {
    await execFileAsync("npm", ["run", "build"], { cwd: packageRoot });
    const xdg = await tempDir();
    const workspace = await tempDir();
    await saveInstallation(installation(workspace), { XDG_CONFIG_HOME: xdg });

    const result = await runBundled(["run", "bundle-test-agent"], { XDG_CONFIG_HOME: xdg });

    assert.equal(
      result.stderr.includes('Dynamic require of "child_process"'),
      false,
      result.stderr,
    );
    assert.equal(result.alive, true, result.stderr || "bundled CLI exited before loading runtime");
  });
});

function installation(workspacePath: string): StoredInstallation {
  return {
    installation: { id: "installation-1", agentId: "bundle-test-agent", createdAt: 1, lastUsedAt: null },
    installationToken: "installation-secret",
    agent: {
      id: "bundle-test-agent",
      workspaceId: "workspace-1",
      actorId: "actor-1",
      name: "reader",
      provider: "claude",
      instructions: "Read carefully",
      requestedModel: null,
      access: { mode: "workspace", selectedActorIds: [] },
      configRevision: 1,
      createdBy: "human-1",
      createdAt: 1,
      updatedAt: 1,
      revokedAt: null,
    },
    workspace: { id: "workspace-1", name: "Test Space" },
    apiUrl: "http://127.0.0.1:1",
    wsUrl: "ws://127.0.0.1:1",
    serverOrigin: "http://127.0.0.1:1",
    workspacePath,
    pairedAt: 1,
  };
}

function runBundled(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stderr: string; alive: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: packageRoot,
      env: { ...process.env, ...env },
    });
    let stderr = "";
    let settled = false;
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const finish = (alive: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve({ stderr, alive });
    };
    const timer = setTimeout(() => finish(true), 800);
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on("close", () => finish(false));
  });
}
