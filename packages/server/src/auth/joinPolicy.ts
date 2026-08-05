import { createHash, timingSafeEqual } from "node:crypto";
import type { JoinEvent } from "@workspace/shared";
import type { JoinDecision } from "../hub";
import type { Auth } from "./Auth";

/**
 * The auth-mode join gate. It exists so the Hub never knows whether identity
 * comes from a Google-backed session or the agent's shared secret, and Auth
 * never knows websockets exist. Humans must present a live session token —
 * the stored actor's name wins over anything in the frame (I1). Agents must
 * present the configured shared secret; with none configured, no agent joins.
 */
export function createJoinGate(
  auth: Auth,
  agentToken: string | null,
): (join: JoinEvent) => JoinDecision {
  return (join) => {
    if (join.kind === "agent") {
      const authorized =
        agentToken !== null && join.authToken !== undefined && secretsEqual(join.authToken, agentToken);
      return authorized && join.name !== undefined ? { ok: true, name: join.name } : { ok: false };
    }
    const actor = join.authToken ? auth.resolveSession(join.authToken) : null;
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
