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

  // The bundle is published standalone, so anything it reaches for at *runtime*
  // rather than build time has to be a declared dependency. The ACP harness is
  // spawned by path (`node <resolved>/dist/index.js`), so bundling cannot cover
  // it — publishing without it leaves an agent that pairs fine and then dies the
  // moment someone activates it.
  test("the packed tarball can resolve the ACP harness it spawns", async () => {
    await execFileAsync("npm", ["run", "build"], { cwd: packageRoot });
    const consumer = await tempDir();
    // `npm pack --json` inside a workspace returns an object keyed by package
    // name, so take the sole entry rather than assuming an array or a name.
    const { stdout } = await execFileAsync("npm", ["pack", "--json", "--pack-destination", consumer], {
      cwd: packageRoot,
    });
    const packed = Object.values(
      JSON.parse(stdout) as Record<string, { name: string; filename: string }>,
    )[0] ?? (JSON.parse(stdout) as Array<{ name: string; filename: string }>)[0];
    const tarball = path.join(consumer, packed.filename);

    await execFileAsync("npm", ["init", "-y"], { cwd: consumer });
    await execFileAsync("npm", ["install", tarball], { cwd: consumer });

    const installed = path.join(consumer, "node_modules", ...packed.name.split("/"), "dist", "cli.js");
    const { stdout: resolved } = await execFileAsync(process.execPath, [
      "-e",
      `const { createRequire } = require("module");
       process.stdout.write(createRequire(${JSON.stringify(installed)})
         .resolve("@agentclientprotocol/claude-agent-acp/dist/index.js"));`,
    ], { cwd: consumer });

    assert.match(resolved, /claude-agent-acp/);
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
