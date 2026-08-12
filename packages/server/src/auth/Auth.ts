import type { SupabaseClient } from "@supabase/supabase-js";
import type { Actor } from "@workspace/shared";
import { ApiError } from "../board/BoardService";
import type { WorkspaceDb } from "../db";

// 1-32 chars of letters/digits/spaces/-/_; applied after trim, so a name
// can never be only whitespace.
export const USERNAME_PATTERN = /^[A-Za-z0-9 _-]{1,32}$/;

export type SessionResult = { status: "ok"; username: string } | { status: "needs_username" };

/**
 * Auth owns the bridge from a verified Supabase session to a workspace
 * actor. It never issues or stores credentials itself — Supabase Auth does
 * that entirely (Google OAuth and email/password both happen client-side
 * via @supabase/supabase-js) — it only maps a verified Supabase user id
 * onto an `actors` row, creating one the first time a user picks a
 * username. Every method re-verifies the JWT itself with the Supabase
 * admin client, so a caller can never spoof a user id.
 */
export class Auth {
  constructor(
    private store: WorkspaceDb,
    private supabase: SupabaseClient,
  ) {}

  /** Verify a Supabase access token and resolve it to a bound actor, or
   *  null if the token is invalid/expired or has no actor yet. Used by the
   *  WS join gate (joinPolicy.ts). */
  async resolveSession(jwt: string): Promise<Actor | null> {
    const user = await this.verify(jwt);
    if (!user) return null;
    return this.store.getActor(user.id);
  }

  /** Same verification, framed as ok/needs_username for the HTTP front
   *  door (GET /api/auth/session) so the client knows whether to show the
   *  username step after a fresh Supabase sign-in. When the signup flow
   *  stashed a `desired_username` in Supabase user_metadata, the first
   *  session call tries to claim it silently; any failure (invalid, taken,
   *  or lost the unique-constraint race against another tab) falls back to
   *  needs_username rather than throwing — the client's manual username
   *  step is the recovery path. */
  async session(jwt: string): Promise<SessionResult> {
    const user = await this.verify(jwt);
    if (!user) throw new ApiError(401, "BAD_CREDENTIAL", "sign-in could not be verified");
    const actor = await this.store.getActor(user.id);
    if (actor) return { status: "ok", username: actor.displayName };
    if (user.desiredUsername) {
      const name = user.desiredUsername.trim();
      if (
        USERNAME_PATTERN.test(name) &&
        !(await this.store.findActorByName("human", name)) &&
        !(await this.store.findActorByName("agent", name))
      ) {
        try {
          const created = await this.store.createHuman(user.id, name, user.email);
          return { status: "ok", username: created.displayName };
        } catch {
          // Two tabs confirming at once: the other one won the insert.
        }
      }
    }
    return { status: "needs_username" };
  }

  /** Bind a username to the Supabase-verified caller, creating the actor.
   *  Idempotent: a second call with an already-bound token just returns
   *  the existing username (covers two tabs finishing signup at once). */
  async claimUsername(jwt: string, username: string): Promise<{ username: string }> {
    const user = await this.verify(jwt);
    if (!user) throw new ApiError(401, "BAD_CREDENTIAL", "sign-in could not be verified");
    const already = await this.store.getActor(user.id);
    if (already) return { username: already.displayName };
    const name = username.trim();
    if (!USERNAME_PATTERN.test(name)) {
      throw new ApiError(
        400,
        "BAD_USERNAME",
        "usernames are 1-32 characters of letters, digits, spaces, - and _",
      );
    }
    // Also refuse names matching an agent, so nobody can pose as the bot.
    if ((await this.store.findActorByName("human", name)) || (await this.store.findActorByName("agent", name))) {
      throw new ApiError(409, "USERNAME_TAKEN", `the name ${name} is taken`);
    }
    const actor = await this.store.createHuman(user.id, name, user.email);
    return { username: actor.displayName };
  }

  /** Availability check for the signup form (GET /api/auth/username-available).
   *  Always answers rather than throwing — a form probing names as the user
   *  types wants a verdict, not an error. The verdict is advisory only:
   *  session()/claimUsername() re-check at claim time, so a stale "available"
   *  can never bind a duplicate. */
  async usernameAvailable(name: string): Promise<{ available: boolean; reason?: "INVALID" | "TAKEN" }> {
    const trimmed = name.trim();
    if (!USERNAME_PATTERN.test(trimmed)) return { available: false, reason: "INVALID" };
    if ((await this.store.findActorByName("human", trimmed)) || (await this.store.findActorByName("agent", trimmed))) {
      return { available: false, reason: "TAKEN" };
    }
    return { available: true };
  }

  /**
   * Verify a JWT against Supabase. Three outcomes, and the difference is
   * load-bearing: a definitive rejection (4xx from Supabase) returns null
   * and ends the session; a transient failure (rate limit, network, 5xx)
   * THROWS 503 so callers can tell the client to retry — treating those as
   * "invalid token" made one Supabase hiccup sign the user out entirely.
   * Successes are cached briefly so ws rejoins and bursts of API calls
   * don't re-hit Supabase's rate-limited verification endpoint.
   */
  private async verify(
    jwt: string,
  ): Promise<{ id: string; email: string | null; desiredUsername: string | null } | null> {
    const cached = this.verifyCache.get(jwt);
    if (cached && cached.expiresAt > Date.now()) return cached.user;

    let data: Awaited<ReturnType<SupabaseClient["auth"]["getUser"]>>["data"];
    let error: { status?: number } | null;
    try {
      ({ data, error } = await this.supabase.auth.getUser(jwt));
    } catch {
      throw new ApiError(503, "AUTH_UNAVAILABLE", "could not verify the sign-in right now");
    }
    if (error) {
      const status = error.status;
      // 4xx (except 429) = Supabase examined the token and rejected it.
      // Everything else — 429, 5xx, network errors with no status — is
      // Supabase being unreachable, which says nothing about the token.
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) return null;
      throw new ApiError(503, "AUTH_UNAVAILABLE", "could not verify the sign-in right now");
    }
    if (!data.user) return null;
    const desired = data.user.user_metadata?.desired_username;
    const user = {
      id: data.user.id,
      email: data.user.email ?? null,
      // user_metadata is client-writable JSON, so trust nothing but a string.
      desiredUsername: typeof desired === "string" ? desired : null,
    };
    if (this.verifyCache.size >= 1000) this.sweepVerifyCache();
    this.verifyCache.set(jwt, { user, expiresAt: Date.now() + VERIFY_CACHE_TTL_MS });
    return user;
  }

  private verifyCache = new Map<
    string,
    { user: { id: string; email: string | null; desiredUsername: string | null }; expiresAt: number }
  >();

  private sweepVerifyCache(): void {
    const now = Date.now();
    for (const [jwt, entry] of this.verifyCache) {
      if (entry.expiresAt <= now) this.verifyCache.delete(jwt);
    }
    // Still full of live entries: drop oldest-inserted so the map stays bounded.
    if (this.verifyCache.size >= 1000) {
      for (const jwt of this.verifyCache.keys()) {
        if (this.verifyCache.size < 500) break;
        this.verifyCache.delete(jwt);
      }
    }
  }
}

/** Long enough to absorb a reconnect burst, short enough that a revoked
 *  Supabase session stops working within a minute. */
const VERIFY_CACHE_TTL_MS = 60 * 1000;
