import { createHash, randomBytes, randomUUID, sign } from "node:crypto";
import type { Actor, GitAccount, GitRemoteRepository } from "@workspace/shared";
import { ApiError } from "../board/BoardService";
import type { Sql } from "../db";

const CONNECTION_STATE_TTL_MS = 15 * 60 * 1000;
const GITHUB_API = "https://api.github.com";

export interface GitHubConfig {
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  callbackUri: string | null;
}

interface ConnectionStateRow {
  actor_id: string;
  workspace_id: string;
  callback_uri: string;
  return_origin: string;
  expires_at: number;
}

interface ConnectionRow {
  id: string;
  actor_id: string;
  provider: "github";
  provider_user_id: string;
  installation_id: string | null;
  login: string;
  display_name: string;
  avatar_url: string | null;
  scopes: string[];
  created_at: number;
}

interface GitHubInstallation {
  id: number;
  app_id: number;
  account: {
    id: number;
    login: string;
    avatar_url: string | null;
    type: string;
  };
  repository_selection: "all" | "selected";
  permissions: Record<string, string>;
}

interface GitHubUserTokenResponse {
  access_token?: string;
  error_description?: string;
}

interface GitHubInstallationTokenResponse {
  token?: string;
  expires_at?: string;
  permissions?: Record<string, string>;
}

interface GitHubRepositoryResponse {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  default_branch: string;
  html_url: string;
  clone_url: string;
  updated_at: string;
  owner: { login: string };
}

interface InstallationToken {
  token: string;
  expiresAt: number;
}

export class GitHub {
  private installationTokens = new Map<string, Promise<InstallationToken>>();

  constructor(
    private sql: Sql,
    private config: GitHubConfig | null,
    private fetcher: typeof fetch = fetch,
  ) {}

  get available(): boolean {
    return this.config !== null;
  }

  async account(actorId: string): Promise<GitAccount | null> {
    const [row] = await this.sql<ConnectionRow[]>`
      SELECT * FROM git_connections
      WHERE actor_id = ${actorId}
        AND provider = 'github'
        AND installation_id IS NOT NULL
        AND revoked_at IS NULL
    `;
    return row ? toAccount(row) : null;
  }

  async authorize(actor: Actor, workspaceId: string, origin: string, returnOrigin = origin): Promise<string> {
    const config = this.requireConfig();
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can connect GitHub");
    const callbackUri = config.callbackUri ?? new URL("/api/git/github/callback", validatedOrigin(origin)).toString();
    const browserOrigin = validatedOrigin(returnOrigin);
    const state = randomBytes(32).toString("base64url");
    const now = Date.now();
    await this.sql`
      DELETE FROM git_connection_states
      WHERE expires_at <= ${now} OR (consumed_at IS NOT NULL AND consumed_at <= ${now - 86_400_000})
    `;
    await this.sql`
      INSERT INTO git_connection_states (
        token_hash, actor_id, workspace_id, callback_uri, return_origin,
        created_at, expires_at, consumed_at
      ) VALUES (
        ${hashState(state)}, ${actor.id}, ${workspaceId}, ${callbackUri},
        ${browserOrigin}, ${now}, ${now + CONNECTION_STATE_TTL_MS}, NULL
      )
    `;
    const url = new URL(`https://github.com/apps/${config.slug}/installations/new`);
    url.searchParams.set("state", state);
    return url.toString();
  }

  async pending(stateToken: string): Promise<{ workspaceId: string; returnOrigin: string } | null> {
    const [row] = await this.sql<ConnectionStateRow[]>`
      SELECT actor_id, workspace_id, callback_uri, return_origin, expires_at
      FROM git_connection_states
      WHERE token_hash = ${hashState(stateToken)}
        AND consumed_at IS NULL
        AND expires_at > ${Date.now()}
    `;
    return row ? { workspaceId: row.workspace_id, returnOrigin: row.return_origin } : null;
  }

  async cancel(stateToken: string): Promise<void> {
    await this.sql`
      UPDATE git_connection_states SET consumed_at = ${Date.now()}
      WHERE token_hash = ${hashState(stateToken)} AND consumed_at IS NULL
    `;
  }

  async complete(
    code: string,
    installationId: string,
    stateToken: string,
  ): Promise<{ workspaceId: string; returnOrigin: string }> {
    const config = this.requireConfig();
    const state = await this.consumeState(stateToken);
    const normalizedInstallationId = installationIdValue(installationId);
    const userTokenResponse = await this.fetcher("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: state.callback_uri,
      }),
    });
    const userTokenBody = (await userTokenResponse.json()) as GitHubUserTokenResponse;
    if (!userTokenResponse.ok || !userTokenBody.access_token) {
      throw new ApiError(502, "GITHUB_AUTH_FAILED", userTokenBody.error_description ?? "GitHub refused user authorization");
    }
    if (!(await this.userCanAccessInstallation(userTokenBody.access_token, normalizedInstallationId))) {
      throw new ApiError(403, "GITHUB_INSTALLATION_FORBIDDEN", "that GitHub App installation does not belong to the authorizing user");
    }
    const installation = await this.appRequest<GitHubInstallation>(`/app/installations/${normalizedInstallationId}`);
    if (String(installation.app_id) !== config.appId) {
      throw new ApiError(403, "GITHUB_INSTALLATION_FORBIDDEN", "that installation belongs to another GitHub App");
    }
    const now = Date.now();
    const scopes = [
      `repositories:${installation.repository_selection}`,
      ...Object.entries(installation.permissions).map(([name, value]) => `${name}:${value}`),
    ].sort();
    try {
      const connected = await this.sql<{ id: string }[]>`
        INSERT INTO git_connections (
          id, actor_id, provider, provider_user_id, installation_id, login,
          display_name, avatar_url, token_ciphertext, refresh_token_ciphertext,
          token_expires_at, scopes, created_at, updated_at, revoked_at
        ) VALUES (
          ${randomUUID()}, ${state.actor_id}, 'github', ${String(installation.account.id)},
          ${normalizedInstallationId}, ${installation.account.login},
          ${installation.account.login}, ${installation.account.avatar_url}, '', NULL,
          NULL, ${scopes}, ${now}, ${now}, NULL
        )
        ON CONFLICT (actor_id, provider) DO UPDATE SET
          provider_user_id = EXCLUDED.provider_user_id,
          installation_id = EXCLUDED.installation_id,
          login = EXCLUDED.login,
          display_name = EXCLUDED.display_name,
          avatar_url = EXCLUDED.avatar_url,
          token_ciphertext = '',
          refresh_token_ciphertext = NULL,
          token_expires_at = NULL,
          scopes = EXCLUDED.scopes,
          updated_at = EXCLUDED.updated_at,
          revoked_at = NULL
        WHERE git_connections.installation_id = EXCLUDED.installation_id
           OR (
             git_connections.revoked_at IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM git_repositories
               WHERE connection_id = git_connections.id AND unlinked_at IS NULL
             )
           )
        RETURNING id
      `;
      if (connected.length === 0) {
        throw new ApiError(409, "GITHUB_INSTALLATION_CONFLICT", "disconnect the current installation and unlink its repositories before connecting a different account");
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, "GITHUB_ALREADY_LINKED", "that GitHub installation is already connected");
      }
      throw error;
    }
    return { workspaceId: state.workspace_id, returnOrigin: state.return_origin };
  }

  async disconnect(actor: Actor): Promise<void> {
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can disconnect GitHub");
    const rows = await this.sql<{ id: string }[]>`
      UPDATE git_connections
      SET revoked_at = ${Date.now()}, updated_at = ${Date.now()}, token_ciphertext = '',
          refresh_token_ciphertext = NULL, token_expires_at = NULL, scopes = '{}'
      WHERE actor_id = ${actor.id} AND provider = 'github' AND revoked_at IS NULL
      RETURNING id
    `;
    if (rows.length === 0) throw new ApiError(404, "NOT_FOUND", "GitHub is not connected");
    for (const row of rows) this.installationTokens.delete(row.id);
  }

  async repositories(actorId: string): Promise<GitRemoteRepository[]> {
    const connection = await this.requireConnectionForActor(actorId);
    const repositories: GitRemoteRepository[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = await this.request<{ repositories: GitHubRepositoryResponse[] }>(
        connection,
        `/installation/repositories?per_page=100&page=${page}`,
      );
      repositories.push(...response.repositories.map(toRemoteRepository));
      if (response.repositories.length < 100) break;
    }
    return repositories;
  }

  async repository(actorId: string, fullName: string): Promise<GitRemoteRepository> {
    const connection = await this.requireConnectionForActor(actorId);
    const response = await this.request<GitHubRepositoryResponse>(connection, `/repos/${encodeRepo(fullName)}`);
    return toRemoteRepository(response);
  }

  async requestForConnection<T>(connectionId: string, path: string, init: RequestInit = {}): Promise<T> {
    return this.request<T>(await this.requireConnection(connectionId), path, init);
  }

  /** Like requestForConnection, but a 404 means "does not exist" (returns null) rather than an auth failure. */
  async requestForConnectionOptional<T>(connectionId: string, path: string, init: RequestInit = {}): Promise<T | null> {
    const connection = await this.requireConnection(connectionId);
    const token = (await this.installationToken(connection)).token;
    const response = await this.githubFetch(token, path, init);
    if (response.status === 404) return null;
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(409, "GITHUB_AUTH_REQUIRED", "GitHub App access changed; reconnect or update the installation");
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      throw new ApiError(502, "GITHUB_REQUEST_FAILED", body.message ?? `GitHub returned ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async tokenForConnection(connectionId: string): Promise<string> {
    return (await this.installationToken(await this.requireConnection(connectionId))).token;
  }

  private async consumeState(stateToken: string): Promise<ConnectionStateRow> {
    const now = Date.now();
    const [row] = await this.sql<ConnectionStateRow[]>`
      UPDATE git_connection_states SET consumed_at = ${now}
      WHERE token_hash = ${hashState(stateToken)}
        AND consumed_at IS NULL
        AND expires_at > ${now}
      RETURNING actor_id, workspace_id, callback_uri, return_origin, expires_at
    `;
    if (!row) throw new ApiError(400, "OAUTH_STATE_INVALID", "GitHub connection expired or was already used; start again");
    return row;
  }

  private async userCanAccessInstallation(userToken: string, installationId: string): Promise<boolean> {
    for (let page = 1; page <= 10; page += 1) {
      const response = await this.githubFetch(
        userToken,
        `/user/installations?per_page=100&page=${page}`,
      );
      if (!response.ok) throw new ApiError(502, "GITHUB_AUTH_FAILED", "GitHub could not verify the installation owner");
      const body = (await response.json()) as { installations?: { id: number }[] };
      const installations = body.installations ?? [];
      if (installations.some((installation) => String(installation.id) === installationId)) return true;
      if (installations.length < 100) return false;
    }
    return false;
  }

  private async request<T>(connection: ConnectionRow, path: string, init: RequestInit = {}): Promise<T> {
    const token = (await this.installationToken(connection)).token;
    const response = await this.githubFetch(token, path, init);
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new ApiError(409, "GITHUB_AUTH_REQUIRED", "GitHub App access changed; reconnect or update the installation");
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      throw new ApiError(502, "GITHUB_REQUEST_FAILED", body.message ?? `GitHub returned ${response.status}`);
    }
    return (await response.json()) as T;
  }

  private installationToken(connection: ConnectionRow): Promise<InstallationToken> {
    if (!connection.installation_id) throw new ApiError(409, "GITHUB_AUTH_REQUIRED", "install the GitHub App first");
    const cached = this.installationTokens.get(connection.id);
    if (cached) return cached;
    const creating = this.createInstallationToken(connection.installation_id).finally(() => {
      void creating.then((token) => {
        const delay = Math.max(0, token.expiresAt - Date.now() - 60_000);
        const timer = setTimeout(() => this.installationTokens.delete(connection.id), delay);
        timer.unref?.();
      }, () => this.installationTokens.delete(connection.id));
    });
    this.installationTokens.set(connection.id, creating);
    return creating;
  }

  private async createInstallationToken(installationId: string): Promise<InstallationToken> {
    const response = await this.appFetch(`/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const body = (await response.json()) as GitHubInstallationTokenResponse;
    if (!response.ok || !body.token || !body.expires_at) {
      throw new ApiError(409, "GITHUB_AUTH_REQUIRED", "GitHub App installation is unavailable; reconnect it");
    }
    const expiresAt = Date.parse(body.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new ApiError(502, "GITHUB_RESPONSE_INVALID", "GitHub returned an invalid installation token expiry");
    }
    return { token: body.token, expiresAt };
  }

  private async appRequest<T>(path: string): Promise<T> {
    const response = await this.appFetch(path);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      throw new ApiError(502, "GITHUB_APP_REQUEST_FAILED", body.message ?? `GitHub returned ${response.status}`);
    }
    return (await response.json()) as T;
  }

  private appFetch(path: string, init: RequestInit = {}): Promise<Response> {
    return this.githubFetch(this.appJwt(), path, init);
  }

  private githubFetch(token: string, path: string, init: RequestInit = {}): Promise<Response> {
    if (!path.startsWith("/")) throw new ApiError(500, "GITHUB_PATH_INVALID", "GitHub API path must be relative");
    return this.fetcher(`${GITHUB_API}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "convyio",
        ...init.headers,
      },
    });
  }

  private appJwt(): string {
    const config = this.requireConfig();
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: config.appId })).toString("base64url");
    const unsigned = `${header}.${payload}`;
    const signature = sign("RSA-SHA256", Buffer.from(unsigned), config.privateKey).toString("base64url");
    return `${unsigned}.${signature}`;
  }

  private async requireConnectionForActor(actorId: string): Promise<ConnectionRow> {
    const [row] = await this.sql<ConnectionRow[]>`
      SELECT * FROM git_connections
      WHERE actor_id = ${actorId}
        AND provider = 'github'
        AND installation_id IS NOT NULL
        AND revoked_at IS NULL
    `;
    if (!row) throw new ApiError(409, "GITHUB_AUTH_REQUIRED", "install the GitHub App first");
    return row;
  }

  private async requireConnection(connectionId: string): Promise<ConnectionRow> {
    const [row] = await this.sql<ConnectionRow[]>`
      SELECT * FROM git_connections
      WHERE id = ${connectionId}
        AND installation_id IS NOT NULL
        AND revoked_at IS NULL
    `;
    if (!row) throw new ApiError(409, "GITHUB_AUTH_REQUIRED", "the repository owner's GitHub App installation must be reconnected");
    return row;
  }

  private requireConfig(): GitHubConfig {
    if (!this.config) throw new ApiError(501, "GITHUB_UNAVAILABLE", "GitHub App integration is not configured");
    return this.config;
  }
}

function hashState(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function installationIdValue(value: string): string {
  if (!/^\d{1,20}$/.test(value)) throw new ApiError(400, "BAD_INSTALLATION", "GitHub installation id is invalid");
  return value;
}

function toAccount(row: ConnectionRow): GitAccount {
  return {
    id: row.id,
    provider: row.provider,
    login: row.login,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    scopes: row.scopes,
    connectedAt: row.created_at,
  };
}

function toRemoteRepository(repository: GitHubRepositoryResponse): GitRemoteRepository {
  return {
    providerId: String(repository.id),
    owner: repository.owner.login,
    name: repository.name,
    fullName: repository.full_name,
    description: repository.description,
    private: repository.private,
    defaultBranch: repository.default_branch,
    htmlUrl: githubHtmlUrl(repository.html_url),
    cloneUrl: githubCloneUrl(repository.clone_url),
    updatedAt: Date.parse(repository.updated_at),
  };
}

function validatedOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    if (error instanceof TypeError) throw new ApiError(400, "BAD_ORIGIN", "GitHub origin must be an absolute http(s) origin");
    throw error;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new ApiError(400, "BAD_ORIGIN", "GitHub origin must be an absolute http(s) origin");
  }
  return url.origin;
}

function githubHtmlUrl(value: string): string {
  const { owner, name } = githubRepoPath(value);
  return `https://github.com/${owner}/${name}`;
}

function githubCloneUrl(value: string): string {
  const { owner, name } = githubRepoPath(value);
  return `https://github.com/${owner}/${name}.git`;
}

function githubRepoPath(value: string): { owner: string; name: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    if (error instanceof TypeError) throw new ApiError(502, "GITHUB_RESPONSE_INVALID", "GitHub returned an invalid repository URL");
    throw error;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.search || url.hash) {
    throw new ApiError(502, "GITHUB_RESPONSE_INVALID", "GitHub returned an unsafe repository URL");
  }
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length !== 2) throw new ApiError(502, "GITHUB_RESPONSE_INVALID", "GitHub returned an invalid repository URL");
  const owner = parts[0];
  const name = parts[1].replace(/\.git$/i, "");
  if (!owner || !name) throw new ApiError(502, "GITHUB_RESPONSE_INVALID", "GitHub returned an invalid repository URL");
  return { owner, name };
}

function encodeRepo(fullName: string): string {
  const parts = fullName.split("/");
  if (parts.length !== 2 || parts.some((part) => !part)) throw new ApiError(400, "BAD_REPOSITORY", "repository must be owner/name");
  return parts.map(encodeURIComponent).join("/");
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "23505";
}
