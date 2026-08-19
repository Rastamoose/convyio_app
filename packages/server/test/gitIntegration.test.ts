import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";
import type { Actor } from "@workspace/shared";
import { Channels } from "../src/chat/Channels";
import { ThreadEventStore } from "../src/chat/ThreadEventStore";
import { GitHub } from "../src/projects/GitHub";
import { GitRepositories } from "../src/projects/GitRepositories";
import { ProjectStore } from "../src/projects/ProjectStore";
import { createTestDb } from "./pgSchema";

const execFileAsync = promisify(execFile);

describe("GitHub repository integration", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let drop: () => Promise<void>;
  let root: string;
  let remoteUrl: string;
  let owner: Actor;
  let agent: Actor;
  let github: GitHub;
  let repositories: GitRepositories;
  let projects: ProjectStore;

  before(async () => {
    ({ db, drop } = await createTestDb());
    root = await fs.mkdtemp(path.join(os.tmpdir(), "convyio-git-integration-"));
    remoteUrl = await createRemote(root);
    owner = await db.upsertActor("human", "git-owner");
    agent = await db.upsertActor("agent", "git-agent");
    github = new GitHub(
      db.sql,
      {
        clientId: "client-id",
        clientSecret: "client-secret",
        encryptionKey: Buffer.alloc(32, 7),
        redirectUri: "http://localhost:3001/api/git/github/callback",
      },
      fakeGitHub(remoteUrl),
    );
    const authorization = new URL(github.authorize(owner, db.workspaceId, "http://localhost:3001"));
    await github.complete("oauth-code", authorization.searchParams.get("state")!);
    const events = new ThreadEventStore(db);
    projects = new ProjectStore(db, events);
    const localProvider = {
      account: (actorId: string) => github.account(actorId),
      repository: async () => ({
        providerId: "42",
        owner: "acme",
        name: "demo",
        fullName: "acme/demo",
        description: "Demo repository",
        private: true,
        defaultBranch: "main",
        htmlUrl: "https://github.com/acme/demo",
        cloneUrl: remoteUrl,
        updatedAt: Date.parse("2026-08-18T00:00:00Z"),
      }),
      tokenForConnection: async () => "provider-secret",
      requestForConnection: async (_connectionId: string, requestPath: string) => {
        if (requestPath.includes("/pulls?")) return [];
        throw new Error(`unexpected provider request: ${requestPath}`);
      },
    } as unknown as GitHub;
    const channels = new Channels(db);
    await channels.seed([{ name: "general", isDemo: false }]);
    repositories = new GitRepositories(db, events, projects, localProvider, channels, path.join(root, "checkouts"));
    await repositories.init();
  });

  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await drop();
  });

  test("stores the GitHub token encrypted and exposes only account metadata", async () => {
    const account = await github.account(owner.id);
    assert.equal(account?.login, "octocat");
    assert.deepEqual(account?.scopes, ["repo", "read:user"]);
    const [stored] = await db.sql<{ token_ciphertext: string }[]>`
      SELECT token_ciphertext FROM git_connections WHERE actor_id = ${owner.id}
    `;
    assert.ok(stored.token_ciphertext.startsWith("v1."));
    assert.equal(stored.token_ciphertext.includes("provider-secret"), false);

    await db.sql`UPDATE git_connections SET token_expires_at = ${Date.now() - 1} WHERE id = ${account!.id}`;
    assert.equal(await github.tokenForConnection(account!.id), "provider-refreshed");
    const [refreshed] = await db.sql<{ token_ciphertext: string; refresh_token_ciphertext: string }[]>`
      SELECT token_ciphertext, refresh_token_ciphertext FROM git_connections WHERE id = ${account!.id}
    `;
    assert.equal(refreshed.token_ciphertext.includes("provider-refreshed"), false);
    assert.equal(refreshed.refresh_token_ciphertext.includes("refresh-rotated"), false);
  });

  test("rejects repository clone URLs outside GitHub HTTPS", async () => {
    await assert.rejects(
      () => github.repository(owner.id, "acme/demo"),
      (error: unknown) => error instanceof Error && error.message.includes("unsafe repository URL"),
    );
  });

  test("links, clones, assigns, edits, commits, and pushes one managed repository", async () => {
    const linked = await repositories.link(owner, "acme/demo");
    assert.equal(linked.state, "ready");
    assert.equal(linked.sync?.branch, "main");
    const project = await projects.find(linked.projectId);
    assert.equal(project?.accessMode, "ask");
    assert.equal(project?.remoteUrl, remoteUrl);

    const assignment = await projects.assign(owner, { projectId: linked.projectId, agentId: agent.id });
    assert.equal(assignment.mountId, null);
    assert.equal(assignment.status, "ready");

    const branched = await repositories.createBranch(owner, linked.projectId, "feature/delete-me", "main");
    assert.equal(branched.sync?.branch, "feature/delete-me");
    const [branchRoom] = await db.sql<{ name: string; archived_at: number | null }[]>`
      SELECT c.name, b.archived_at FROM git_branch_channels b
      JOIN channels c ON c.id = b.channel_id
      WHERE b.project_id = ${linked.projectId} AND b.branch = 'feature/delete-me'
    `;
    assert.match(branchRoom.name, /^demo-feature-delete-me-/);
    assert.equal(branchRoom.archived_at, null);
    const afterDelete = await repositories.deleteBranch(owner, linked.projectId, "feature/delete-me");
    assert.equal(afterDelete.sync?.branch, "main");
    const [archivedRoom] = await db.sql<{ archived_at: number | null }[]>`
      SELECT archived_at FROM git_branch_channels
      WHERE project_id = ${linked.projectId} AND branch = 'feature/delete-me'
    `;
    assert.ok(archivedRoom.archived_at);

    const read = await repositories.execute(agent, {
      kind: "project_read_file",
      projectId: linked.projectId,
      path: "README.md",
    });
    assert.equal(read.ok, true);
    assert.equal(read.output, "hello\n");

    assert.equal((await repositories.execute(agent, {
      kind: "project_write_file",
      projectId: linked.projectId,
      path: "feature.txt",
      content: "agent work\n",
    })).ok, true);
    const committed = await repositories.execute(agent, {
      kind: "project_git_commit",
      projectId: linked.projectId,
      message: "Agent change",
    });
    assert.equal(committed.ok, true, committed.error);
    const status = JSON.parse((await repositories.execute(agent, {
      kind: "project_git_status",
      projectId: linked.projectId,
    })).output ?? "{}") as { aheadCount: number };
    assert.equal(status.aheadCount, 1);

    const pushed = await repositories.execute(agent, { kind: "project_git_push", projectId: linked.projectId });
    assert.equal(pushed.ok, true, pushed.error);
    const afterPush = await repositories.find(linked.projectId);
    assert.equal(afterPush?.sync?.aheadCount, 0);
    const subjects = await db.sql<{ kind: string }[]>`
      SELECT kind FROM thread_events WHERE subject_id = ${linked.projectId} ORDER BY seq
    `;
    assert.ok(subjects.some((event) => event.kind === "git.repository.linked"));
    assert.ok(subjects.some((event) => event.kind === "git.push.completed"));

    await repositories.unlink(owner, linked.projectId);
    assert.equal(await repositories.find(linked.projectId), null);
    assert.equal((await repositories.list()).length, 0);
    assert.equal(await projects.assignment(linked.projectId, agent.id), null);
    const relinked = await repositories.link(owner, "acme/demo");
    assert.equal(relinked.projectId, linked.projectId);
    assert.equal(relinked.state, "ready");
    const history = await db.sql<{ kind: string }[]>`
      SELECT kind FROM thread_events WHERE subject_id = ${linked.projectId} ORDER BY seq
    `;
    assert.ok(history.some((event) => event.kind === "git.repository.unlinked"));
  });

  test("disconnect revokes the account and erases the stored credential", async () => {
    await github.disconnect(owner);
    assert.equal(await github.account(owner.id), null);
    const [stored] = await db.sql<{ token_ciphertext: string }[]>`
      SELECT token_ciphertext FROM git_connections WHERE actor_id = ${owner.id}
    `;
    assert.equal(stored.token_ciphertext, "");
  });
});

async function createRemote(root: string): Promise<string> {
  const remote = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  await fs.mkdir(seed);
  await execFileAsync("git", ["init", "--bare", remote]);
  await execFileAsync("git", ["init"], { cwd: seed });
  await fs.writeFile(path.join(seed, "README.md"), "hello\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: seed });
  await execFileAsync("git", ["-c", "user.name=Seeder", "-c", "user.email=seed@example.com", "commit", "-m", "Initial"], { cwd: seed });
  await execFileAsync("git", ["branch", "-M", "main"], { cwd: seed });
  await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: seed });
  await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: seed });
  await execFileAsync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: remote });
  return new URL(`file://${remote}`).toString();
}

function fakeGitHub(remoteUrl: string): typeof fetch {
  return (async (input, init) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      const body = JSON.parse(String(init?.body)) as { grant_type?: string };
      return body.grant_type === "refresh_token"
        ? jsonResponse({ access_token: "provider-refreshed", refresh_token: "refresh-rotated", expires_in: 3600 })
        : jsonResponse({ access_token: "provider-secret", refresh_token: "refresh-secret", expires_in: 3600 });
    }
    if (url === "https://api.github.com/user") {
      return jsonResponse(
        { id: 1, login: "octocat", name: "Octo Cat", avatar_url: "https://avatars.githubusercontent.com/u/1" },
        { "x-oauth-scopes": "repo, read:user" },
      );
    }
    if (url === "https://api.github.com/repos/acme/demo") {
      return jsonResponse({
        id: 42,
        name: "demo",
        full_name: "acme/demo",
        description: "Demo repository",
        private: true,
        default_branch: "main",
        html_url: "https://github.com/acme/demo",
        clone_url: remoteUrl,
        updated_at: "2026-08-18T00:00:00Z",
        owner: { login: "acme" },
      });
    }
    throw new Error(`unexpected GitHub request: ${url}`);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
