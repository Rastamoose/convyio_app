import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { execFile as childExecFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";
import type { Actor } from "@workspace/shared";
import { Channels } from "../src/chat/Channels";
import { ThreadEventStore } from "../src/chat/ThreadEventStore";
import { GitHub, type GitHubConfig } from "../src/projects/GitHub";
import { GitRepositories, installationGitConfig } from "../src/projects/GitRepositories";
import { ProjectStore } from "../src/projects/ProjectStore";
import { createTestDb } from "./pgSchema";

const execFileAsync = promisify(childExecFile);

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
  let completedState: string;
  let config: GitHubConfig;

  before(async () => {
    ({ db, drop } = await createTestDb());
    root = await fs.mkdtemp(path.join(os.tmpdir(), "convyio-git-integration-"));
    remoteUrl = await createRemote(root);
    owner = await db.upsertActor("human", "git-owner");
    agent = await db.upsertActor("agent", "git-agent");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    config = {
      appId: "12345",
      slug: "convyio",
      clientId: "client-id",
      clientSecret: "client-secret",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      callbackUri: "http://localhost:3001/api/git/github/callback",
    };
    const fetcher = fakeGitHub(remoteUrl);
    const firstProcess = new GitHub(db.sql, config, fetcher);
    const installationUrl = new URL(await firstProcess.authorize(
      owner,
      db.workspaceId,
      "http://localhost:3001",
      "http://localhost:5173",
    ));
    assert.equal(installationUrl.pathname, "/apps/convyio/installations/new");
    completedState = installationUrl.searchParams.get("state")!;
    github = new GitHub(db.sql, config, fetcher);
    const completed = await github.complete("user-code", "99", completedState);
    assert.deepEqual(completed, { workspaceId: db.workspaceId, returnOrigin: "http://localhost:5173" });
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
      tokenForConnection: async () => "installation-secret",
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

  test("installation state survives restart and is hashed, expiring, and single-use", async () => {
    const [stored] = await db.sql<{ token_hash: string; consumed_at: number | null }[]>`
      SELECT token_hash, consumed_at FROM git_connection_states
      WHERE actor_id = ${owner.id} ORDER BY created_at ASC LIMIT 1
    `;
    assert.equal(stored.token_hash.length, 64);
    assert.equal(stored.token_hash.includes(completedState), false);
    assert.ok(stored.consumed_at);
    await assert.rejects(
      () => github.complete("user-code", "99", completedState),
      (error: unknown) => error instanceof Error && error.message.includes("already used"),
    );

    const expiring = new GitHub(db.sql, config, fakeGitHub(remoteUrl));
    const expiringUrl = new URL(await expiring.authorize(owner, db.workspaceId, "http://localhost:3001"));
    const expiringState = expiringUrl.searchParams.get("state")!;
    await db.sql`
      UPDATE git_connection_states SET expires_at = ${Date.now() - 1}
      WHERE consumed_at IS NULL AND actor_id = ${owner.id}
    `;
    assert.equal(await new GitHub(db.sql, config, fakeGitHub(remoteUrl)).pending(expiringState), null);
    await assert.rejects(
      () => expiring.complete("user-code", "99", expiringState),
      (error: unknown) => error instanceof Error && error.message.includes("expired"),
    );
  });

  test("verifies installation ownership and stores no durable GitHub token", async () => {
    const account = await github.account(owner.id);
    assert.equal(account?.login, "octocat");
    assert.ok(account?.scopes.includes("repositories:selected"));
    assert.ok(account?.scopes.includes("contents:write"));
    const [stored] = await db.sql<{
      installation_id: string;
      token_ciphertext: string;
      refresh_token_ciphertext: string | null;
    }[]>`
      SELECT installation_id, token_ciphertext, refresh_token_ciphertext
      FROM git_connections WHERE actor_id = ${owner.id}
    `;
    assert.equal(stored.installation_id, "99");
    assert.equal(stored.token_ciphertext, "");
    assert.equal(stored.refresh_token_ciphertext, null);
    assert.equal(await github.tokenForConnection(account!.id), "installation-secret");
    const selected = await github.repositories(owner.id);
    assert.deepEqual(selected.map((repository) => repository.fullName), ["acme/selected"]);

    const deniedUrl = new URL(await github.authorize(owner, db.workspaceId, "http://localhost:3001"));
    await assert.rejects(
      () => github.complete("user-code", "100", deniedUrl.searchParams.get("state")!),
      (error: unknown) => error instanceof Error && error.message.includes("does not belong"),
    );
  });

  test("rejects repository clone URLs outside GitHub HTTPS", async () => {
    await assert.rejects(
      () => github.repository(owner.id, "acme/demo"),
      (error: unknown) => error instanceof Error && error.message.includes("unsafe repository URL"),
    );
  });

  test("normalizes GitHub clone URLs and always authenticates HTTPS", async () => {
    const account = await github.account(owner.id);
    assert.ok(account);
    const listed = await github.repositories(owner.id);
    assert.equal(listed[0]?.cloneUrl, "https://github.com/acme/selected.git");
    assert.equal(listed[0]?.htmlUrl, "https://github.com/acme/selected");
    const config = installationGitConfig("installation-secret");
    assert.match(config, /\[http "https:\/\/github.com\/"\]/);
    assert.match(config, /extraHeader = Authorization: Basic /);
    const encoded = config.match(/Authorization: Basic ([A-Za-z0-9+/=]+)/)?.[1];
    assert.equal(Buffer.from(encoded ?? "", "base64").toString(), "x-access-token:installation-secret");
    const header = await readGitHttpHeader(config, "https://github.com/acme/selected.git/");
    assert.equal(header, `Authorization: Basic ${encoded}`);
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

  test("disconnect revokes the installation mapping", async () => {
    await github.disconnect(owner);
    assert.equal(await github.account(owner.id), null);
    const [stored] = await db.sql<{ token_ciphertext: string; revoked_at: number | null }[]>`
      SELECT token_ciphertext, revoked_at FROM git_connections WHERE actor_id = ${owner.id}
    `;
    assert.equal(stored.token_ciphertext, "");
    assert.ok(stored.revoked_at);
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
    const authorization = new Headers(init?.headers).get("Authorization") ?? "";
    if (url === "https://github.com/login/oauth/access_token") {
      return jsonResponse({ access_token: "user-install-token" });
    }
    if (url.startsWith("https://api.github.com/user/installations")) {
      assert.equal(authorization, "Bearer user-install-token");
      return jsonResponse({ installations: [{ id: 99 }] });
    }
    if (url === "https://api.github.com/app/installations/99") {
      assert.equal(authorization.split(".").length, 3);
      return jsonResponse({
        id: 99,
        app_id: 12345,
        account: { id: 1, login: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/1", type: "User" },
        repository_selection: "selected",
        permissions: { contents: "write", pull_requests: "write", issues: "write", checks: "read", metadata: "read" },
      });
    }
    if (url === "https://api.github.com/app/installations/99/access_tokens") {
      assert.equal(authorization.split(".").length, 3);
      return jsonResponse({ token: "installation-secret", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (url.startsWith("https://api.github.com/installation/repositories")) {
      assert.equal(authorization, "Bearer installation-secret");
      return jsonResponse({ repositories: [{
        id: 7,
        name: "selected",
        full_name: "acme/selected",
        description: "Selected repository",
        private: true,
        default_branch: "main",
        html_url: "https://github.com/acme/selected/",
        clone_url: "https://github.com/acme/selected.git/",
        updated_at: "2026-08-18T00:00:00Z",
        owner: { login: "acme" },
      }] });
    }
    if (url === "https://api.github.com/repos/acme/demo") {
      assert.equal(authorization, "Bearer installation-secret");
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

async function readGitHttpHeader(config: string, remoteUrl: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "convyio-git-auth-"));
  const configPath = path.join(root, "gitconfig");
  await fs.writeFile(configPath, config);
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get-urlmatch", "http.extraHeader", remoteUrl], {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: configPath,
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return stdout.trim();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
