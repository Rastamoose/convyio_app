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
   *  username step after a fresh Supabase sign-in. */
  async session(jwt: string): Promise<SessionResult> {
    const user = await this.verify(jwt);
    if (!user) throw new ApiError(401, "BAD_CREDENTIAL", "sign-in could not be verified");
    const actor = await this.store.getActor(user.id);
    return actor ? { status: "ok", username: actor.displayName } : { status: "needs_username" };
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

  private async verify(jwt: string): Promise<{ id: string; email: string | null } | null> {
    const { data, error } = await this.supabase.auth.getUser(jwt);
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? null };
  }
}
