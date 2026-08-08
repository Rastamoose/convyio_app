import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { Actor } from "@workspace/shared";
import { ApiError } from "../board/BoardService";
import type { WorkspaceDb } from "../db";
import type { GoogleIdentity } from "./googleIdToken";

/**
 * Auth owns login identity: it exchanges verified Google credentials or an
 * email/password pair for workspace actors and persistent sessions, so the
 * hub and the API never know Google exists. Sessions live in auth_sessions
 * (30-day TTL, lazily swept like the ws-API Sessions registry, but
 * DB-backed: a login must survive a server restart). Pending Google
 * signups — verified identities that still need a username — are
 * in-memory and short-lived by design.
 */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SIGNUP_TTL_MS = 10 * 60 * 1000;

// 1-32 chars of letters/digits/spaces/-/_; applied after trim, so a name
// can never be only whitespace.
const USERNAME_PATTERN = /^[A-Za-z0-9 _-]{1,32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const SCRYPT_KEYLEN = 64;

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, SCRYPT_KEYLEN);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Fixed per-process, never matches a real hash — used to keep loginWithEmail's
// runtime the same whether or not the account exists, so a timing difference
// can't be used to enumerate registered emails.
const DUMMY_HASH = hashPassword(randomUUID());

export type LoginResult =
  | { status: "ok"; authToken: string; username: string }
  | { status: "needs_username"; signupToken: string };

interface PendingSignup {
  sub: string;
  email: string | null;
  expiresAt: number;
}

export class Auth {
  private signups = new Map<string, PendingSignup>();

  constructor(
    private store: WorkspaceDb,
    private verifyGoogleCredential: ((credential: string) => Promise<GoogleIdentity>) | null,
    private emailAuthEnabled: boolean = true,
    private ttl: { sessionMs: number; signupMs: number } = {
      sessionMs: SESSION_TTL_MS,
      signupMs: SIGNUP_TTL_MS,
    },
  ) {}

  /** Verify the Google credential and log in, or park it pending a username. */
  async loginWithGoogle(credential: string): Promise<LoginResult> {
    if (!this.verifyGoogleCredential) {
      throw new ApiError(409, "AUTH_DISABLED", "Google sign-in is not configured");
    }
    let identity: GoogleIdentity;
    try {
      identity = await this.verifyGoogleCredential(credential);
    } catch {
      // The reason (bad signature, expiry, wrong audience) is not the
      // client's business; a single opaque 401 leaks nothing to probing.
      throw new ApiError(401, "BAD_CREDENTIAL", "Google sign-in could not be verified");
    }
    const actor = this.store.findActorByGoogleSub(identity.sub);
    if (actor) {
      return { status: "ok", authToken: this.issueSession(actor.id), username: actor.displayName };
    }
    this.sweepSignups();
    const signupToken = randomUUID();
    this.signups.set(signupToken, {
      sub: identity.sub,
      email: identity.email ?? null,
      expiresAt: Date.now() + this.ttl.signupMs,
    });
    return { status: "needs_username", signupToken };
  }

  /** Bind a username to a pending signup, creating the persistent actor. */
  completeSignup(signupToken: string, username: string): { authToken: string; username: string } {
    const pending = this.signups.get(signupToken);
    if (!pending || pending.expiresAt <= Date.now()) {
      this.signups.delete(signupToken);
      throw new ApiError(410, "SIGNUP_EXPIRED", "sign in with Google again to pick a username");
    }
    // Two tabs finishing the same signup: the first one won, log this one in.
    const already = this.store.findActorByGoogleSub(pending.sub);
    if (already) {
      this.signups.delete(signupToken);
      return { authToken: this.issueSession(already.id), username: already.displayName };
    }
    const name = username.trim();
    if (!USERNAME_PATTERN.test(name)) {
      throw new ApiError(
        400,
        "BAD_USERNAME",
        "usernames are 1-32 characters of letters, digits, spaces, - and _",
      );
    }
    // Also refuse names matching an agent, so nobody can pose as the bot.
    if (this.store.findActorByName("human", name) || this.store.findActorByName("agent", name)) {
      throw new ApiError(409, "USERNAME_TAKEN", `the name ${name} is taken`);
    }
    const actor = this.store.createGoogleHuman(name, pending.sub, pending.email);
    this.signups.delete(signupToken);
    return { authToken: this.issueSession(actor.id), username: actor.displayName };
  }

  /** Create a new email/password account and log in. */
  signupWithEmail(
    email: string,
    password: string,
    username: string,
  ): { authToken: string; username: string } {
    if (!this.emailAuthEnabled) {
      throw new ApiError(409, "AUTH_DISABLED", "email sign-in is not configured");
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      throw new ApiError(400, "BAD_EMAIL", "enter a valid email address");
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new ApiError(400, "WEAK_PASSWORD", `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    if (this.store.findActorByEmail(normalizedEmail)) {
      throw new ApiError(409, "EMAIL_TAKEN", "an account with that email already exists");
    }
    const name = username.trim();
    if (!USERNAME_PATTERN.test(name)) {
      throw new ApiError(
        400,
        "BAD_USERNAME",
        "usernames are 1-32 characters of letters, digits, spaces, - and _",
      );
    }
    if (this.store.findActorByName("human", name) || this.store.findActorByName("agent", name)) {
      throw new ApiError(409, "USERNAME_TAKEN", `the name ${name} is taken`);
    }
    const actor = this.store.createEmailHuman(name, normalizedEmail, hashPassword(password));
    return { authToken: this.issueSession(actor.id), username: actor.displayName };
  }

  /** Log in with email/password. */
  loginWithEmail(email: string, password: string): { authToken: string; username: string } {
    if (!this.emailAuthEnabled) {
      throw new ApiError(409, "AUTH_DISABLED", "email sign-in is not configured");
    }
    const normalizedEmail = email.trim().toLowerCase();
    const actor = this.store.findActorByEmail(normalizedEmail);
    const hash = actor ? this.store.getPasswordHash(actor.id) : null;
    // Always run the scrypt comparison, matching account or not, so the
    // response time can't be used to tell whether an email is registered.
    const passwordOk = verifyPassword(password, hash ?? DUMMY_HASH);
    if (!actor || !hash || !passwordOk) {
      throw new ApiError(401, "BAD_CREDENTIALS", "incorrect email or password");
    }
    return { authToken: this.issueSession(actor.id), username: actor.displayName };
  }

  resolveSession(authToken: string): Actor | null {
    const row = this.store.db
      .prepare(`SELECT actor_id, expires_at FROM auth_sessions WHERE token = ?`)
      .get(authToken) as { actor_id: string; expires_at: number } | undefined;
    if (!row) return null;
    if (row.expires_at <= Date.now()) {
      this.revoke(authToken);
      return null;
    }
    return this.store.getActor(row.actor_id);
  }

  revoke(authToken: string): void {
    this.store.db.prepare(`DELETE FROM auth_sessions WHERE token = ?`).run(authToken);
  }

  private issueSession(actorId: string): string {
    this.sweepSessions();
    const token = randomUUID();
    this.store.db
      .prepare(
        `INSERT INTO auth_sessions (token, actor_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
      )
      .run(token, actorId, Date.now(), Date.now() + this.ttl.sessionMs);
    return token;
  }

  /** Lazy sweeps on issue, so neither store can grow without bound. */
  private sweepSessions(): void {
    this.store.db.prepare(`DELETE FROM auth_sessions WHERE expires_at <= ?`).run(Date.now());
  }

  private sweepSignups(): void {
    const now = Date.now();
    for (const [token, signup] of this.signups) {
      if (signup.expiresAt <= now) this.signups.delete(token);
    }
  }
}
