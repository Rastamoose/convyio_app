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
  let bareDir: string;
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
    bareDir = new URL(remoteUrl).pathname;
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
      requestForConnection: async (_connectionId: string, requestPath: string, init: RequestInit = {}) => {
        const { status, body } = await routeGitHubDataApi(bareDir, requestPath, init);
        if (status >= 200 && status < 300) return body;
        throw new Error((body as { message?: string })?.message ?? `GitHub returned ${status}`);
      },
      requestForConnectionOptional: async (_connectionId: string, requestPath: string, init: RequestInit = {}) => {
        const { status, body } = await routeGitHubDataApi(bareDir, requestPath, init);
        if (status === 404) return null;
        if (status >= 200 && status < 300) return body;
        throw new Error((body as { message?: string })?.message ?? `GitHub returned ${status}`);
      },
    } as unknown as GitHub;
    const channels = new Channels(db);
    await channels.seed([{ name: "general", isDemo: false }]);
    repositories = new GitRepositories(db, events, projects, localProvider, channels);
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

    const agentPush = await repositories.execute(agent, { kind: "project_git_push", projectId: linked.projectId });
    assert.equal(agentPush.ok, false);
    assert.equal(agentPush.code, "HUMAN_ONLY");
    const stillAhead = await repositories.find(linked.projectId);
    assert.equal(stillAhead?.sync?.aheadCount, 1);

    const pushedRepository = await repositories.sync(owner, linked.projectId, "push");
    assert.equal(pushedRepository.sync?.aheadCount, 0);
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

// A minimal GitHub Contents/Data API, backed by the same bare repo the test's
// "remote" points at — GitRepositories no longer shells out to `git` for
// managed-repo reads/writes/commits, so the fake provider has to answer for
// the endpoints it now calls (contents, refs, blobs, trees, commits).
async function routeGitHubDataApi(
  bareDir: string,
  requestPath: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const [pathname, query] = requestPath.split("?");
  const params = new URLSearchParams(query ?? "");
  const method = init.method ?? "GET";
  const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

  const contentsMatch = pathname!.match(/^\/repos\/acme\/demo\/contents(?:\/(.*))?$/);
  if (contentsMatch && method === "GET") {
    const filePath = contentsMatch[1] ? decodeURIComponent(contentsMatch[1]) : "";
    const entry = await githubContents(bareDir, params.get("ref") ?? "main", filePath);
    return entry === null ? { status: 404, body: { message: "Not Found" } } : { status: 200, body: entry };
  }

  const refHeadMatch = pathname!.match(/^\/repos\/acme\/demo\/git\/ref\/heads\/(.+)$/);
  if (refHeadMatch && method === "GET") {
    const sha = await refSha(bareDir, `refs/heads/${decodeURIComponent(refHeadMatch[1]!)}`);
    return sha === null ? { status: 404, body: { message: "Not Found" } } : { status: 200, body: { object: { sha } } };
  }

  if (pathname === "/repos/acme/demo/git/commits" && method === "POST") {
    const payload = body as { message: string; tree: string; parents: string[]; author: { name: string; email: string; date: string } };
    const sha = await createCommit(bareDir, payload.tree, payload.parents[0]!, payload.message, payload.author);
    return { status: 201, body: { sha } };
  }
  const commitMatch = pathname!.match(/^\/repos\/acme\/demo\/git\/commits\/([0-9a-f]+)$/);
  if (commitMatch && method === "GET") {
    const sha = commitMatch[1]!;
    return { status: 200, body: { sha, tree: { sha: await commitTreeSha(bareDir, sha) } } };
  }

  if (pathname === "/repos/acme/demo/git/blobs" && method === "POST") {
    const sha = await createBlob(bareDir, String((body as { content: string }).content));
    return { status: 201, body: { sha } };
  }

  if (pathname === "/repos/acme/demo/git/trees" && method === "POST") {
    const payload = body as { base_tree: string; tree: { path: string; mode: string; type: string; sha: string | null }[] };
    const sha = await createTree(bareDir, payload.base_tree, payload.tree);
    return { status: 201, body: { sha } };
  }

  if (pathname === "/repos/acme/demo/git/refs" && method === "POST") {
    const payload = body as { ref: string; sha: string };
    if (await refSha(bareDir, payload.ref)) return { status: 422, body: { message: "Reference already exists" } };
    await gitBare(bareDir, ["update-ref", payload.ref, payload.sha]);
    return { status: 201, body: { ref: payload.ref, object: { sha: payload.sha } } };
  }

  const refHeadsMatch = pathname!.match(/^\/repos\/acme\/demo\/git\/refs\/heads\/(.+)$/);
  if (refHeadsMatch && method === "DELETE") {
    await gitBare(bareDir, ["update-ref", "-d", `refs/heads/${decodeURIComponent(refHeadsMatch[1]!)}`]);
    return { status: 204, body: {} };
  }
  if (refHeadsMatch && method === "PATCH") {
    const branchRef = `refs/heads/${decodeURIComponent(refHeadsMatch[1]!)}`;
    const payload = body as { sha: string; force?: boolean };
    const current = await refSha(bareDir, branchRef);
    if (!current) return { status: 404, body: { message: "Not Found" } };
    if (!payload.force) {
      try {
        await gitBare(bareDir, ["merge-base", "--is-ancestor", current, payload.sha]);
      } catch {
        return { status: 422, body: { message: "Update is not a fast forward" } };
      }
    }
    await gitBare(bareDir, ["update-ref", branchRef, payload.sha]);
    return { status: 200, body: { object: { sha: payload.sha } } };
  }

  if (pathname === "/repos/acme/demo/pulls" && method === "GET") return { status: 200, body: [] };

  throw new Error(`unexpected provider request: ${method} ${requestPath}`);
}

function gitBare(bareDir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    childExecFile("git", ["--git-dir", bareDir, ...args], { maxBuffer: 10_000_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}

function gitBareWithStdin(bareDir: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = childExecFile("git", ["--git-dir", bareDir, ...args], { maxBuffer: 10_000_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
    child.stdin!.write(input);
    child.stdin!.end();
  });
}

async function refSha(bareDir: string, ref: string): Promise<string | null> {
  try {
    return (await gitBare(bareDir, ["rev-parse", "--verify", ref])).trim();
  } catch {
    return null;
  }
}

async function commitTreeSha(bareDir: string, commitSha: string): Promise<string> {
  return (await gitBare(bareDir, ["rev-parse", `${commitSha}^{tree}`])).trim();
}

async function createBlob(bareDir: string, content: string): Promise<string> {
  return (await gitBareWithStdin(bareDir, ["hash-object", "-w", "--stdin"], content)).trim();
}

// Flat (single-directory-level) trees only — matches how this test's fixtures are shaped.
async function createTree(
  bareDir: string,
  baseTreeSha: string,
  entries: { path: string; mode: string; type: string; sha: string | null }[],
): Promise<string> {
  const baseListing = await gitBare(bareDir, ["ls-tree", baseTreeSha]);
  const lines = new Map<string, string>();
  for (const line of baseListing.split("\n").filter(Boolean)) {
    lines.set(line.slice(line.indexOf("\t") + 1), line);
  }
  for (const entry of entries) {
    if (entry.path.includes("/")) throw new Error("test fake only supports flat trees");
    if (entry.sha === null) lines.delete(entry.path);
    else lines.set(entry.path, `${entry.mode} ${entry.type} ${entry.sha}\t${entry.path}`);
  }
  return (await gitBareWithStdin(bareDir, ["mktree"], `${[...lines.values()].join("\n")}\n`)).trim();
}

function createCommit(
  bareDir: string,
  treeSha: string,
  parentSha: string,
  message: string,
  author: { name: string; email: string; date: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: author.date,
      GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email, GIT_COMMITTER_DATE: author.date,
    };
    childExecFile(
      "git",
      ["--git-dir", bareDir, "commit-tree", treeSha, "-p", parentSha, "-m", message],
      { env },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolve(stdout.trim());
      },
    );
  });
}

async function githubContents(bareDir: string, ref: string, filePath: string): Promise<unknown> {
  const treeish = filePath ? `${ref}:${filePath}` : `${ref}:`;
  let kind: string;
  try {
    kind = (await gitBare(bareDir, ["cat-file", "-t", treeish])).trim();
  } catch {
    return null;
  }
  if (kind === "tree") {
    const listing = await gitBare(bareDir, ["ls-tree", treeish]);
    return listing
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        const [mode, entryKind, sha] = line.slice(0, tab).trim().split(/\s+/);
        const name = line.slice(tab + 1);
        return {
          type: entryKind === "tree" ? "dir" : "file",
          name,
          path: filePath ? `${filePath}/${name}` : name,
          sha,
          size: 0,
        };
      });
  }
  const content = await gitBare(bareDir, ["cat-file", "-p", treeish]);
  const sha = (await gitBare(bareDir, ["rev-parse", treeish])).trim();
  return {
    type: "file",
    name: filePath.split("/").pop() ?? filePath,
    path: filePath,
    sha,
    size: Buffer.byteLength(content, "utf8"),
    content: Buffer.from(content, "utf8").toString("base64"),
    encoding: "base64",
  };
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
