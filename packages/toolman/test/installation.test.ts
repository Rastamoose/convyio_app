import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  installationHealth,
  installationStatus,
  loadInstallation,
  prepareInstallationForRun,
  saveInstallation,
  savePairedInstallation,
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
  const ready = healthFetch("ready");
  await assert.rejects(loadInstallation(undefined, env, ready), /More than one paired Toolman node/);
  assert.equal((await loadInstallation("node-a", env, ready)).workspace.name, "workspace-a");
  assert.equal((await loadInstallation("laptop", env, ready)).node.id, "node-b");
  assert.equal((await loadInstallation("workspace-a", env, ready)).node.id, "node-a");
  await assert.rejects(loadInstallation("missing", env, ready), /No paired Toolman node matches/);
});

test("re-pairing the same node preserves its local folder paths", async () => {
  const previous = {
    ...installation("node-repair", "repair", "workspace-repair"),
    mounts: [{
      mountKey: "mount-1",
      projectId: "project-1",
      projectName: "notes",
      kind: "directory" as const,
      absolutePath: "/home/example/notes",
    }],
  };
  await saveInstallation(previous, env);
  const repaired = {
    ...installation("node-repair", "repair", "workspace-repair"),
    installationToken: "replacement-token",
  };
  await savePairedInstallation(repaired, env);
  const loaded = await loadInstallation("node-repair", env, healthFetch("ready"));
  assert.equal(loaded.installationToken, "replacement-token");
  assert.deepEqual(loaded.mounts, previous.mounts);
});

test("re-pairing the same device name drops leftover local credentials", async () => {
  const isolated = { ...process.env, XDG_CONFIG_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "convyio-toolman-repair-name-")) };
  const leftover = installation("node-old", "desk", "test_space");
  leftover.workspace.id = "workspace-shared";
  leftover.node.workspaceId = "workspace-shared";
  leftover.wsUrl = "wss://app.convyio.com/toolman/workspace-shared";
  const replacement = installation("node-new", "desk", "test_space");
  replacement.workspace.id = "workspace-shared";
  replacement.node.workspaceId = "workspace-shared";
  replacement.wsUrl = "wss://app.convyio.com/toolman/workspace-shared";
  await saveInstallation(leftover, isolated);
  await savePairedInstallation(replacement, isolated);
  const loaded = await loadInstallation(undefined, isolated, healthFetch("ready"));
  assert.equal(loaded.node.id, "node-new");
  await assert.rejects(loadInstallation("node-old", isolated, healthFetch("ready")), /No paired Toolman node matches/);
});

test("project add and run ignore revoked leftover pairings instead of asking to choose one", async () => {
  const isolated = { ...process.env, XDG_CONFIG_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "convyio-toolman-revoked-")) };
  await saveInstallation(installation("revoked-a", "desk", "test_space"), isolated);
  await assert.rejects(
    loadInstallation(undefined, isolated, healthFetch("revoked")),
    /revoked or deleted/i,
  );
  await saveInstallation(installation("revoked-b", "desk", "test_space"), isolated);
  await assert.rejects(
    loadInstallation(undefined, isolated, healthFetch("revoked")),
    /revoked or deleted/i,
  );
  await assert.rejects(
    loadInstallation("desk", isolated, healthFetch("revoked")),
    /revoked or deleted/i,
  );
  const live = installation("live-desk", "laptop", "test_space");
  await saveInstallation(live, isolated);
  const mixed = (async (_input, init) => {
    const token = (init?.headers as { Authorization?: string } | undefined)?.Authorization ?? "";
    return token.includes("live-desk")
      ? new Response(JSON.stringify({ node: { health: "offline" }, mounts: [] }), { status: 200 })
      : new Response(null, { status: 401 });
  }) as typeof fetch;
  assert.equal((await loadInstallation(undefined, isolated, mixed)).node.id, "live-desk");
});

test("run preparation fails fast for revoked credentials and drops server-removed folders", async () => {
  const item = {
    ...installation("node-run", "run", "workspace-run"),
    mounts: [
      { mountKey: "keep", projectId: "project-keep", projectName: "keep", kind: "directory" as const, absolutePath: "/keep" },
      { mountKey: "remove", projectId: "project-remove", projectName: "remove", kind: "directory" as const, absolutePath: "/remove" },
    ],
  };
  await assert.rejects(
    () => prepareInstallationForRun(
      item,
      (async () => new Response(null, { status: 401 })) as typeof fetch,
      env,
    ),
    /revoked.*pair/i,
  );
  const prepared = await prepareInstallationForRun(
    item,
    (async () => new Response(JSON.stringify({
      node: { health: "offline" },
      mounts: [{ mountKey: "keep", projectId: "project-keep" }],
    }), { status: 200 })) as typeof fetch,
    env,
  );
  assert.deepEqual(prepared.mounts.map((mount) => mount.mountKey), ["keep"]);
});

test("installation health distinguishes a running node from stored credentials", async () => {
  const item = installation("node-health", "desk", "workspace");
  const fetcher = (async (_input, init) => {
    assert.equal((init?.headers as { Authorization: string }).Authorization, "Bearer node-health-token");
    return new Response(JSON.stringify({
      node: { health: "ready" },
      mounts: [{ mountKey: "active-mount", projectId: "project-1" }],
    }), { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await installationStatus(item, fetcher), {
    health: "ready",
    mounts: [{ mountKey: "active-mount", projectId: "project-1" }],
  });
  assert.equal(await installationHealth(item, fetcher), "ready");
  assert.equal(await installationHealth(item, (async () => new Response(null, { status: 401 })) as typeof fetch), "revoked");
  assert.equal(await installationHealth(item, (async () => { throw new Error("offline"); }) as typeof fetch), "unreachable");
});

function healthFetch(health: "ready" | "offline" | "revoked"): typeof fetch {
  return (async () => health === "revoked"
    ? new Response(null, { status: 401 })
    : new Response(JSON.stringify({ node: { health }, mounts: [] }), { status: 200 })) as typeof fetch;
}

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
