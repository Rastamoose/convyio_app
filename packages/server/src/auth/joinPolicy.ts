import { createHash, timingSafeEqual } from "node:crypto";
import type { JoinEvent } from "@workspace/shared";
import type { JoinDecision } from "../hub";
import type { AgentInvites } from "./AgentInvites";
import type { Auth } from "./Auth";

/**
 * The auth-mode join gate. It exists so the Hub never knows whether
 * identity comes from a Supabase-backed session, the server's shared agent
 * secret, or a user-created per-agent invite. Humans must present a
 * Supabase access token that resolves to a bound actor — the stored actor's
 * name wins over anything in the frame (I1). Agents must present either the
 * configured shared secret or a valid per-agent invite; with none configured,
 * no agent joins. Verifying a Supabase token is a network call, so this
 * returns a Promise — every caller (Hub.handleJoin) awaits it.
 */
export function createJoinGate(
  auth: Auth,
  agentToken: string | null,
  agentInvites: AgentInvites,
): (join: JoinEvent) => Promise<JoinDecision> {
  return async (join) => {
    if (join.kind === "agent") {
      if (join.authToken === undefined) return { ok: false };

      // Server-owned global agent (AGENT_TOKEN) supplies its own name.
      if (agentToken !== null && secretsEqual(join.authToken, agentToken)) {
        return join.name !== undefined ? { ok: true, name: join.name } : { ok: false };
      }

      // User-created credentials; the stored actor identity and harness win.
      const resolved =
        (await agentInvites.resolveInstallation(join.authToken)) ??
        (await agentInvites.resolve(join.authToken));
      return resolved
        ? {
            ok: true,
            name: resolved.actor.displayName,
            actorId: resolved.actor.id,
            profile: resolved.invite,
          }
        : { ok: false };
    }
    const actor = join.authToken ? await auth.resolveSession(join.authToken) : null;
    return actor ? { ok: true, name: actor.displayName } : { ok: false };
  };
}

/** Hash both sides so comparison time leaks neither content nor length. */
function secretsEqual(presented: string, expected: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(presented).digest(),
    createHash("sha256").update(expected).digest(),
  );
}
