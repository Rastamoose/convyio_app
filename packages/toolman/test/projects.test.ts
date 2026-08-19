import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";
import type { StoredToolman } from "../src/installation";
import { addProject, removeProject } from "../src/projects";

const execFileAsync = promisify(execFile);

describe("local folder attach", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "toolman-folder-"));
    env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config") };
  });
  after(() => fs.rm(root, { recursive: true, force: true }));

  test("attaches a dirty git folder as a live directory", async () => {
    const folder = path.join(root, "notes");
    await fs.mkdir(folder);
    await execFileAsync("git", ["init"], { cwd: folder });
    await fs.writeFile(path.join(folder, "README.md"), "hello\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: folder });
    await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"], {
      cwd: folder,
    });
    await fs.writeFile(path.join(folder, "README.md"), "dirty\n");

    const { mount } = await addProject(installation(), folder, undefined, fakeMountFetch("notes"), env);

    assert.equal(mount.kind, "directory");
    assert.equal(mount.absolutePath, folder);
    assert.equal(mount.projectName, "notes");
    assert.equal(mount.mountKey, "server-mount-key");
  });

  test("attaches a plain folder", async () => {
    const folder = path.join(root, "plain");
    await fs.mkdir(folder);
    const { mount } = await addProject(installation(), folder, "desk-notes", fakeMountFetch("desk-notes"), env);
    assert.equal(mount.kind, "directory");
    assert.equal(mount.projectName, "desk-notes");
    assert.equal(mount.absolutePath, folder);
  });

  test("removes one local folder without unpairing the device", async () => {
    const folder = path.join(root, "remove-me");
    await fs.mkdir(folder);
    const added = await addProject(installation(), folder, "remove-me", fakeMountFetch("remove-me"), env);
    const removed = await removeProject(
      added.installation,
      "remove-me",
      (async (input, init) => {
        assert.equal(String(input), "http://127.0.0.1:3001/api/toolman/mounts/server-mount-key");
        assert.equal(init?.method, "DELETE");
        assert.equal((init?.headers as { Authorization: string }).Authorization, "Bearer token");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch,
      env,
    );
    assert.equal(removed.mount.projectName, "remove-me");
    assert.deepEqual(removed.installation.mounts, []);
  });

  test("refuses a file", async () => {
    const file = path.join(root, "not-a-folder");
    await fs.writeFile(file, "nope");
    await assert.rejects(() => addProject(installation(), file, undefined, fakeMountFetch("x"), env), /directory/);
  });
});

function installation(): StoredToolman {
  return {
    node: { id: "node-1", workspaceId: "ws-1", name: "desk", createdBy: "human-1", createdAt: 1, revokedAt: null },
    installation: { id: "node-1", nodeId: "node-1", createdAt: 1 },
    installationToken: "token",
    workspace: { id: "ws-1", name: "space" },
    apiUrl: "http://127.0.0.1:3001/",
    wsUrl: "ws://127.0.0.1:3001/toolman",
    serverOrigin: "http://127.0.0.1:3001",
    pairedAt: 1,
    mounts: [],
  };
}

function fakeMountFetch(projectName: string): typeof fetch {
  return (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { kind: string; projectName: string };
    assert.equal(body.kind, "directory");
    assert.equal(body.projectName, projectName);
    return new Response(
      JSON.stringify({ project: { id: "proj-1", name: projectName }, mount: { mountKey: "server-mount-key" } }),
      { status: 200 },
    );
  }) as typeof fetch;
}
