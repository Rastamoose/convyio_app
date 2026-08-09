import { randomUUID } from "node:crypto";

/**
 * Session registry. Tokens are issued when a participant joins over the
 * websocket and map to a persistent actor identity. HTTP routes derive the
 * actor from the token only — never from the request body (I1). Tokens
 * expire after the TTL and are revoked when their participant fully
 * disconnects; a rejoin always issues a fresh one.
 */

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

interface Session {
  actorId: string;
  expiresAt: number;
}

export class Sessions {
  private tokens = new Map<string, Session>();

  constructor(private ttlMs: number = DEFAULT_TTL_MS) {}

  issue(actorId: string): string {
    this.sweep();
    const token = randomUUID();
    this.tokens.set(token, { actorId, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  resolve(token: string): string | null {
    const session = this.tokens.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.tokens.delete(token);
      return null;
    }
    return session.actorId;
  }

  revokeFor(actorId: string): void {
    for (const [token, session] of this.tokens) {
      if (session.actorId === actorId) this.tokens.delete(token);
    }
  }

  /** Clear every issued session, e.g. between tests that share one env. */
  clear(): void {
    this.tokens.clear();
  }

  /** Drop expired sessions so the map cannot grow without bound. */
  private sweep(): void {
    const now = Date.now();
    for (const [token, session] of this.tokens) {
      if (session.expiresAt <= now) this.tokens.delete(token);
    }
  }
}
