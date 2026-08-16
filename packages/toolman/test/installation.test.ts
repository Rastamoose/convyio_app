import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
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
