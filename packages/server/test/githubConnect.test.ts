import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Actor } from "@workspace/shared";
import { GitHub, type GitHubConfig } from "../src/projects/GitHub";
import { createTestDb } from "./pgSchema";

// The connect flow has to survive GitHub's own redirect behaviour. Sending a
// user to /installations/new only fires the callback when the visit produces a
// *new* installation — if the App is already installed on that account GitHub
// shows "configure permissions" and, by design, never redirects back. So the
// flow starts at the OAuth authorize endpoint (which always redirects back)
// and resolves the installation from the user's own token.
describe("GitHub App connect flow", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let drop: () => Promise<void>;
  let owner: Actor;
  let config: GitHubConfig;
  /** Installations GET /user/installations reports for the fake user token. */
  let userInstallations: { id: number; app_id: number }[];
  /** GitHub account each stubbed installation belongs to. */
  const accounts = new Map<number, { id: number; login: string }>([
    [77, { id: 1, login: "octocat" }],
    [99, { id: 1, login: "octocat" }],
    [123, { id: 1, login: "octocat" }],
    [456, { id: 2, login: "someone-else" }],
  ]);

  before(async () => {
    ({ db, drop } = await createTestDb());
    owner = await db.upsertActor("human", "git-owner");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    config = {
      appId: "12345",
      slug: "convyio",
      clientId: "client-id",
      clientSecret: "client-secret",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      callbackUri: "http://localhost:3001/api/git/github/callback",
    };
  });

  after(async () => {
    await drop();
  });

  const github = () => new GitHub(db.sql, config, fakeGitHub(() => userInstallations, accounts));

  /** A repository still linked to the actor's connection — the state that used
   *  to make every reinstall fail. */
  const linkRepository = async () => {
    const connection = await github().account(owner.id);
    const projectId = randomUUID();
    await db.sql`
      INSERT INTO projects (id, workspace_id, name, kind, created_by, created_at)
      VALUES (${projectId}, ${db.workspaceId}, ${`repo-${projectId.slice(0, 8)}`}, 'git', ${owner.id}, ${Date.now()})
    `;
    await db.sql`
      INSERT INTO git_repositories (
        project_id, workspace_id, connection_id, provider, provider_repository_id,
        owner_name, repository_name, full_name, private, default_branch, working_branch,
        html_url, clone_url, state, linked_by, linked_at
      ) VALUES (
        ${projectId}, ${db.workspaceId}, ${connection!.id}, 'github', ${projectId.slice(0, 8)},
        'octocat', 'dotfiles', 'octocat/dotfiles', true, 'main', 'main',
        'https://github.com/octocat/dotfiles', 'https://github.com/octocat/dotfiles.git',
        'ready', ${owner.id}, ${Date.now()}
      )
    `;
  };

  const start = async () =>
    new URL(await github().authorize(owner, db.workspaceId, "http://localhost:3001", "http://localhost:5173"));

  test("starts at the OAuth authorize endpoint, which always redirects back", async () => {
    userInstallations = [{ id: 99, app_id: 12345 }];
    const url = await start();
    assert.equal(url.origin, "https://github.com");
    assert.equal(url.pathname, "/login/oauth/authorize");
    assert.equal(url.searchParams.get("client_id"), "client-id");
    assert.equal(url.searchParams.get("redirect_uri"), config.callbackUri);
    assert.ok(url.searchParams.get("state"));
  });

  test("connects when the App is already installed and GitHub sends no installation_id", async () => {
    userInstallations = [{ id: 99, app_id: 12345 }];
    const state = (await start()).searchParams.get("state")!;
    const completed = await github().complete("user-code", null, state);
    assert.deepEqual(completed, {
      kind: "connected",
      workspaceId: db.workspaceId,
      returnOrigin: "http://localhost:5173",
    });
    assert.equal((await github().account(owner.id))?.login, "octocat");
  });

  test("sends a user with no installation to the install page with a fresh usable state", async () => {
    await github().disconnect(owner);
    userInstallations = [];
    const state = (await start()).searchParams.get("state")!;
    const redirect = await github().complete("user-code", null, state);
    assert.equal(redirect.kind, "install");
    const installUrl = new URL(redirect.kind === "install" ? redirect.url : "");
    assert.equal(installUrl.pathname, "/apps/convyio/installations/new");
    const installState = installUrl.searchParams.get("state")!;
    assert.notEqual(installState, state);
    assert.deepEqual(await github().pending(installState), {
      workspaceId: db.workspaceId,
      returnOrigin: "http://localhost:5173",
    });

    // Coming back after the install now completes against the same actor.
    userInstallations = [{ id: 99, app_id: 12345 }];
    const completed = await github().complete("user-code", "99", installState);
    assert.equal(completed.kind, "connected");
    assert.equal((await github().account(owner.id))?.login, "octocat");
  });

  test("recovers a setup-URL callback that carries an installation but no code", async () => {
    userInstallations = [{ id: 99, app_id: 12345 }];
    const state = (await start()).searchParams.get("state")!;
    const retry = new URL(await github().reauthorize(state));
    assert.equal(retry.pathname, "/login/oauth/authorize");
    const retryState = retry.searchParams.get("state")!;
    assert.notEqual(retryState, state);
    assert.equal(await github().pending(state), null); // the old one is spent
    assert.equal((await github().complete("user-code", null, retryState)).kind, "connected");
  });

  test("reconnecting keeps the installation this actor was already on", async () => {
    // Connected to 99 above; an org installation now sorts ahead of it.
    userInstallations = [{ id: 77, app_id: 12345 }, { id: 99, app_id: 12345 }];
    const state = (await start()).searchParams.get("state")!;
    // Only /app/installations/99 is stubbed, so picking 77 would throw.
    assert.equal((await github().complete("user-code", null, state)).kind, "connected");
    const [row] = await db.sql<{ installation_id: string }[]>`
      SELECT installation_id FROM git_connections WHERE actor_id = ${owner.id}
    `;
    assert.equal(row.installation_id, "99");
  });

  // The reported bug: removing the App on GitHub and re-adding it mints a new
  // installation id, and the old guard keyed on installation_id, so a still-
  // linked repository made every reinstall fail with a 409 that the callback
  // rendered as a generic "not completed" toast.
  test("reinstalling the same GitHub account works with repositories still linked", async () => {
    userInstallations = [{ id: 99, app_id: 12345 }];
    assert.equal((await github().complete("user-code", "99", (await start()).searchParams.get("state")!)).kind, "connected");
    await linkRepository();
    await github().disconnect(owner);

    // GitHub hands out a fresh installation id for the reinstall.
    userInstallations = [{ id: 123, app_id: 12345 }];
    const state = (await start()).searchParams.get("state")!;
    assert.equal((await github().complete("user-code", "123", state)).kind, "connected");
    const account = await github().account(owner.id);
    assert.equal(account?.login, "octocat");
    const [row] = await db.sql<{ installation_id: string }[]>`
      SELECT installation_id FROM git_connections WHERE actor_id = ${owner.id}
    `;
    assert.equal(row.installation_id, "123");
    // Same connection row, so the linked repository survives the reinstall.
    assert.equal(account?.id, (await db.sql<{ connection_id: string }[]>`
      SELECT connection_id FROM git_repositories WHERE workspace_id = ${db.workspaceId} LIMIT 1
    `)[0]!.connection_id);
  });

  test("still refuses a different GitHub account while repositories are linked", async () => {
    userInstallations = [{ id: 456, app_id: 12345 }];
    const state = (await start()).searchParams.get("state")!;
    await assert.rejects(
      () => github().complete("user-code", "456", state),
      (error: unknown) => error instanceof Error && error.message.includes("unlink"),
    );
  });

  test("still refuses an installation the authorizing user cannot access", async () => {
    userInstallations = [{ id: 99, app_id: 12345 }];
    const state = (await start()).searchParams.get("state")!;
    await assert.rejects(
      () => github().complete("user-code", "100", state),
      (error: unknown) => error instanceof Error && error.message.includes("does not belong"),
    );
  });

  test("ignores installations that belong to a different GitHub App", async () => {
    await github().disconnect(owner);
    userInstallations = [{ id: 500, app_id: 999 }];
    const state = (await start()).searchParams.get("state")!;
    const redirect = await github().complete("user-code", null, state);
    assert.equal(redirect.kind, "install");
  });
});

function fakeGitHub(
  installations: () => { id: number; app_id: number }[],
  accounts: Map<number, { id: number; login: string }>,
): typeof fetch {
  return (async (input, init) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("Authorization") ?? "";
    if (url === "https://github.com/login/oauth/access_token") {
      return jsonResponse({ access_token: "user-install-token" });
    }
    if (url.startsWith("https://api.github.com/user/installations")) {
      assert.equal(authorization, "Bearer user-install-token");
      return jsonResponse({ installations: installations() });
    }
    const appInstallation = url.match(/^https:\/\/api\.github\.com\/app\/installations\/(\d+)$/);
    if (appInstallation) {
      assert.equal(authorization.split(".").length, 3);
      const id = Number(appInstallation[1]);
      const account = accounts.get(id);
      if (!account) throw new Error(`unstubbed installation: ${id}`);
      return jsonResponse({
        id,
        app_id: 12345,
        account: { ...account, avatar_url: null, type: "User" },
        repository_selection: "selected",
        permissions: { contents: "write", metadata: "read" },
      });
    }
    throw new Error(`unexpected GitHub request: ${url}`);
  }) as typeof fetch;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
