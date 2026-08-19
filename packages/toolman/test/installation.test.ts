import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  installationHealth,
  loadInstallation,
  saveInstallation,
  type StoredToolman,
} from "../src/installation";

let root: string;
let env: NodeJS.ProcessEnv;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "convyio-toolman-installation-"));
  env = { ...process.env, XDG_CONFIG_HOME: root };
  await saveInstallation(installation("node-a", "desk", "workspace-a"), env);
  await saveInstallation(installation("node-b", "laptop", "workspace-b"), env);
});

after(async () => fs.rm(root, { recursive: true, force: true }));

test("multiple workspace nodes require and honor an explicit name, workspace, or id", async () => {
  await assert.rejects(loadInstallation(undefined, env), /More than one paired Toolman node/);
  assert.equal((await loadInstallation("node-a", env)).workspace.name, "workspace-a");
  assert.equal((await loadInstallation("laptop", env)).node.id, "node-b");
  assert.equal((await loadInstallation("workspace-a", env)).node.id, "node-a");
  await assert.rejects(loadInstallation("missing", env), /No paired Toolman node matches/);
});

test("installation health distinguishes a running node from stored credentials", async () => {
  const item = installation("node-health", "desk", "workspace");
  const fetcher = (async (_input, init) => {
    assert.equal((init?.headers as { Authorization: string }).Authorization, "Bearer node-health-token");
    return new Response(JSON.stringify({ node: { health: "ready" } }), { status: 200 });
  }) as typeof fetch;
  assert.equal(await installationHealth(item, fetcher), "ready");
  assert.equal(await installationHealth(item, (async () => new Response(null, { status: 401 })) as typeof fetch), "revoked");
  assert.equal(await installationHealth(item, (async () => { throw new Error("offline"); }) as typeof fetch), "unreachable");
});

function installation(nodeId: string, nodeName: string, workspaceName: string): StoredToolman {
  return {
    node: {
      id: nodeId,
      workspaceId: `${nodeId}-workspace`,
      name: nodeName,
      createdBy: "human-1",
      createdAt: 1,
      revokedAt: null,
    },
    installation: { id: nodeId, nodeId, createdAt: 1 },
    installationToken: `${nodeId}-token`,
    workspace: { id: `${nodeId}-workspace`, name: workspaceName },
    apiUrl: "https://app.convyio.com",
    wsUrl: `wss://app.convyio.com/toolman/${nodeId}-workspace`,
    serverOrigin: "https://app.convyio.com",
    pairedAt: 1,
    mounts: [],
  };
}
