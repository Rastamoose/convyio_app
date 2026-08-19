import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { Actor, GitAccount, GitRemoteRepository } from "@workspace/shared";
import { ApiError } from "../board/BoardService";
import type { Sql } from "../db";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const GITHUB_API = "https://api.github.com";

export interface GitHubConfig {
  clientId: string;
  clientSecret: string;
  encryptionKey: Buffer;
  redirectUri: string | null;
}

interface OAuthState {
  actorId: string;
  workspaceId: string;
  redirectUri: string;
  returnOrigin: string;
  expiresAt: number;
}

interface ConnectionRow {
  id: string;
  actor_id: string;
  provider: "github";
  login: string;
  display_name: string;
  avatar_url: string | null;
  token_ciphertext: string;
  refresh_token_ciphertext: string | null;
  token_expires_at: number | null;
  scopes: string[];
  created_at: number;
}

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error_description?: string;
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

export class GitHub {
  private states = new Map<string, OAuthState>();
  private refreshes = new Map<string, Promise<ConnectionRow>>();

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
      WHERE actor_id = ${actorId} AND provider = 'github' AND revoked_at IS NULL
    `;
    return row ? toAccount(row) : null;
  }

  authorize(actor: Actor, workspaceId: string, origin: string, returnOrigin = origin): string {
    this.requireConfig();
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can connect GitHub");
    const state = randomBytes(32).toString("base64url");
    const callbackOrigin = validatedOrigin(origin);
    const browserOrigin = validatedOrigin(returnOrigin);
    const redirectUri = this.config!.redirectUri ?? new URL("/api/git/github/callback", callbackOrigin).toString();
    this.sweepStates();
    this.states.set(state, {
      actorId: actor.id,
      workspaceId,
      redirectUri,
      returnOrigin: browserOrigin,
      expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
    });
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", this.config!.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "repo read:user");
    url.searchParams.set("state", state);
    return url.toString();
  }

  oauthWorkspace(stateToken: string): string | null {
    this.sweepStates();
    return this.states.get(stateToken)?.workspaceId ?? null;
  }

  oauthReturnOrigin(stateToken: string): string | null {
    this.sweepStates();
    return this.states.get(stateToken)?.returnOrigin ?? null;
  }

  cancel(stateToken: string): void {
    this.states.delete(stateToken);
  }

  async complete(code: string, stateToken: string): Promise<{ workspaceId: string; returnOrigin: string }> {
    const config = this.requireConfig();
    const state = this.states.get(stateToken);
    this.states.delete(stateToken);
    if (!state || state.expiresAt <= Date.now()) {
      throw new ApiError(400, "OAUTH_STATE_INVALID", "GitHub connection expired; start again");
    }
    const tokenResponse = await this.fetcher("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: state.redirectUri,
      }),
    });
    const tokenBody = (await tokenResponse.json()) as OAuthTokenResponse;
    if (!tokenResponse.ok || !tokenBody.access_token) {
      throw new ApiError(502, "GITHUB_OAUTH_FAILED", tokenBody.error_description ?? "GitHub refused the connection");
    }
    const userResponse = await this.githubFetch(tokenBody.access_token, "/user");
    const user = (await userResponse.json()) as GitHubUser;
    if (!userResponse.ok || !user.id || !user.login) {
      throw new ApiError(502, "GITHUB_ACCOUNT_FAILED", "GitHub did not return an account");
    }
    const scopes = (userResponse.headers.get("x-oauth-scopes") ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
    const now = Date.now();
    try {
      await this.sql`
        INSERT INTO git_connections (
          id, actor_id, provider, provider_user_id, login, display_name, avatar_url,
          token_ciphertext, refresh_token_ciphertext, token_expires_at, scopes,
          created_at, updated_at, revoked_at
        ) VALUES (
          ${randomUUID()}, ${state.actorId}, 'github', ${String(user.id)}, ${user.login},
          ${user.name ?? user.login}, ${user.avatar_url}, ${encrypt(tokenBody.access_token, config.encryptionKey)},
          ${tokenBody.refresh_token ? encrypt(tokenBody.refresh_token, config.encryptionKey) : null},
          ${tokenBody.expires_in ? now + tokenBody.expires_in * 1000 : null}, ${scopes}, ${now}, ${now}, NULL
        )
        ON CONFLICT (actor_id, provider) DO UPDATE SET
          provider_user_id = EXCLUDED.provider_user_id,
          login = EXCLUDED.login,
          display_name = EXCLUDED.display_name,
          avatar_url = EXCLUDED.avatar_url,
          token_ciphertext = EXCLUDED.token_ciphertext,
          refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
          token_expires_at = EXCLUDED.token_expires_at,
          scopes = EXCLUDED.scopes,
          updated_at = EXCLUDED.updated_at,
          revoked_at = NULL
      `;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, "GITHUB_ALREADY_LINKED", "that GitHub account is connected to another Convyio user");
      }
      throw error;
    }
    return { workspaceId: state.workspaceId, returnOrigin: state.returnOrigin };
  }

  async disconnect(actor: Actor): Promise<void> {
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can disconnect GitHub");
    const rows = await this.sql`
      UPDATE git_connections
      SET revoked_at = ${Date.now()}, updated_at = ${Date.now()}, token_ciphertext = '',
          refresh_token_ciphertext = NULL, token_expires_at = NULL, scopes = '{}'
      WHERE actor_id = ${actor.id} AND provider = 'github' AND revoked_at IS NULL
      RETURNING id
    `;
    if (rows.length === 0) throw new ApiError(404, "NOT_FOUND", "GitHub is not connected");
  }

  async repositories(actorId: string): Promise<GitRemoteRepository[]> {
    const connection = await this.requireConnectionForActor(actorId);
    const repositories: GitRemoteRepository[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = await this.request<GitHubRepositoryResponse[]>(
        connection,
        `/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100&page=${page}`,
      );
      repositories.push(...response.map(toRemoteRepository));
      if (response.length < 100) break;
    }
    return repositories;
  }

  async repository(actorId: string, fullName: string): Promise<GitRemoteRepository> {
    const connection = await this.requireConnectionForActor(actorId);
    const response = await this.request<GitHubRepositoryResponse>(connection, `/repos/${encodeRepo(fullName)}`);
    return toRemoteRepository(response);
  }

  async requestForConnection<T>(connectionId: string, path: string, init: RequestInit = {}): Promise<T> {
    const connection = await this.requireConnection(connectionId);
    return this.request<T>(connection, path, init);
  }

  async tokenForConnection(connectionId: string): Promise<string> {
    const connection = await this.freshConnection(await this.requireConnection(connectionId));
    return decrypt(connection.token_ciphertext, this.requireConfig().encryptionKey);
  }

  private async request<T>(connection: ConnectionRow, path: string, init: RequestInit = {}): Promise<T> {
    const fresh = await this.freshConnection(connection);
    const token = decrypt(fresh.token_ciphertext, this.requireConfig().encryptionKey);
    const response = await this.githubFetch(token, path, init);
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(409, "GITHUB_AUTH_REQUIRED", "GitHub access expired or lacks permission; reconnect the account");
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      throw new ApiError(response.status === 404 ? 404 : 502, "GITHUB_REQUEST_FAILED", body.message ?? `GitHub returned ${response.status}`);
    }
    return (await response.json()) as T;
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

  private freshConnection(connection: ConnectionRow): Promise<ConnectionRow> {
    if (!connection.token_expires_at || connection.token_expires_at > Date.now() + 60_000) return Promise.resolve(connection);
    const active = this.refreshes.get(connection.id);
    if (active) return active;
    const refreshing = this.refreshConnection(connection).finally(() => this.refreshes.delete(connection.id));
    this.refreshes.set(connection.id, refreshing);
    return refreshing;
  }

  private async refreshConnection(connection: ConnectionRow): Promise<ConnectionRow> {
    if (!connection.refresh_token_ciphertext) {
      throw new ApiError(409, "GITHUB_AUTH_REQUIRED", "GitHub access expired; reconnect the account");
    }
    const config = this.requireConfig();
    const response = await this.fetcher("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: decrypt(connection.refresh_token_ciphertext, config.encryptionKey),
      }),
    });
    const body = (await response.json()) as OAuthTokenResponse;
    if (!response.ok || !body.access_token) {
      throw new ApiError(409, "GITHUB_AUTH_REQUIRED", body.error_description ?? "GitHub access expired; reconnect the account");
    }
    const now = Date.now();
    const refreshed = {
      ...connection,
      token_ciphertext: encrypt(body.access_token, config.encryptionKey),
      refresh_token_ciphertext: body.refresh_token
        ? encrypt(body.refresh_token, config.encryptionKey)
        : connection.refresh_token_ciphertext,
      token_expires_at: body.expires_in ? now + body.expires_in * 1000 : null,
    };
    const updated = await this.sql`
      UPDATE git_connections SET
        token_ciphertext = ${refreshed.token_ciphertext},
        refresh_token_ciphertext = ${refreshed.refresh_token_ciphertext},
        token_expires_at = ${refreshed.token_expires_at},
        updated_at = ${now}
      WHERE id = ${connection.id} AND revoked_at IS NULL
      RETURNING id
    `;
    if (updated.length === 0) throw new ApiError(409, "GITHUB_AUTH_REQUIRED", "GitHub was disconnected while refreshing");
    return refreshed;
  }

  private async requireConnectionForActor(actorId: string): Promise<ConnectionRow> {
    const [row] = await this.sql<ConnectionRow[]>`
      SELECT * FROM git_connections
      WHERE actor_id = ${actorId} AND provider = 'github' AND revoked_at IS NULL
    `;
    if (!row) throw new ApiError(409, "GITHUB_AUTH_REQUIRED", "connect GitHub first");
    return row;
  }

  private async requireConnection(connectionId: string): Promise<ConnectionRow> {
    const [row] = await this.sql<ConnectionRow[]>`
      SELECT * FROM git_connections WHERE id = ${connectionId} AND revoked_at IS NULL
    `;
    if (!row) throw new ApiError(409, "GITHUB_AUTH_REQUIRED", "the repository owner's GitHub account must be reconnected");
    return row;
  }

  private requireConfig(): GitHubConfig {
    if (!this.config) throw new ApiError(501, "GITHUB_UNAVAILABLE", "GitHub integration is not configured");
    return this.config;
  }

  private sweepStates(): void {
    const now = Date.now();
    for (const [token, state] of this.states) {
      if (state.expiresAt <= now) this.states.delete(token);
    }
  }
}

function encrypt(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function decrypt(value: string, key: Buffer): string {
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("unsupported Git credential ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
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
    htmlUrl: githubUrl(repository.html_url),
    cloneUrl: githubUrl(repository.clone_url),
    updatedAt: Date.parse(repository.updated_at),
  };
}

function validatedOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    if (error instanceof TypeError) throw new ApiError(400, "BAD_ORIGIN", "OAuth origin must be an absolute http(s) origin");
    throw error;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new ApiError(400, "BAD_ORIGIN", "OAuth origin must be an absolute http(s) origin");
  }
  return url.origin;
}

function githubUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    if (error instanceof TypeError) throw new ApiError(502, "GITHUB_RESPONSE_INVALID", "GitHub returned an invalid repository URL");
    throw error;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password) {
    throw new ApiError(502, "GITHUB_RESPONSE_INVALID", "GitHub returned an unsafe repository URL");
  }
  return url.toString();
}

function encodeRepo(fullName: string): string {
  const parts = fullName.split("/");
  if (parts.length !== 2 || parts.some((part) => !part)) throw new ApiError(400, "BAD_REPOSITORY", "repository must be owner/name");
  return parts.map(encodeURIComponent).join("/");
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "23505";
}
