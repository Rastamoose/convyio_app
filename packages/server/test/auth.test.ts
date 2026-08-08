import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { after, describe, test } from "node:test";
import { WorkspaceDb } from "../src/db";
import { Auth } from "../src/auth/Auth";
import { ApiError } from "../src/board/BoardService";
import {
  createGoogleIdTokenVerifier,
  type GoogleIdentity,
  type Jwks,
} from "../src/auth/googleIdToken";
import { createWsEnv } from "./helpers";

const CLIENT_ID = "test-client.apps.googleusercontent.com";

// ---------------------------------------------------------------------------
// Google ID token verification (real RSA keys, fake JWKS fetcher — no network)
// ---------------------------------------------------------------------------

describe("googleIdToken verifier", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "kid-1", alg: "RS256", use: "sig" };
  const fetchJwks = async (): Promise<Jwks> => ({ keys: [jwk], maxAgeMs: null });
  const verify = createGoogleIdTokenVerifier(CLIENT_ID, fetchJwks);

  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

  const signToken = (claims: object, header: object = { alg: "RS256", kid: "kid-1" }): string => {
    const signingInput = `${encode(header)}.${encode(claims)}`;
    const signature = createSign("RSA-SHA256")
      .update(signingInput)
      .sign(privateKey)
      .toString("base64url");
    return `${signingInput}.${signature}`;
  };

  const claims = (over: object = {}) => ({
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "google-sub-1",
    email: "dana@example.com",
    name: "Dana",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  });

  test("accepts a valid token and returns sub/email/name", async () => {
    const identity = await verify(signToken(claims()));
    assert.deepEqual(identity, {
      sub: "google-sub-1",
      email: "dana@example.com",
      name: "Dana",
    });
  });

  test("rejects a token whose payload was tampered with", async () => {
    const token = signToken(claims());
    const [header, , signature] = token.split(".");
    const forged = `${header}.${encode(claims({ sub: "someone-else" }))}.${signature}`;
    await assert.rejects(() => verify(forged), /bad signature/);
  });

  test("rejects a token for another client id", async () => {
    await assert.rejects(() => verify(signToken(claims({ aud: "other-client" }))), /another client/);
  });

  test("rejects a token from another issuer", async () => {
    await assert.rejects(() => verify(signToken(claims({ iss: "https://evil.example" }))), /issuer/);
  });

  test("rejects an expired token but tolerates 60s of skew", async () => {
    const now = Math.floor(Date.now() / 1000);
    await assert.rejects(() => verify(signToken(claims({ exp: now - 120 }))), /expired/);
    await assert.doesNotReject(() => verify(signToken(claims({ exp: now - 30 }))));
  });

  test("rejects an unknown kid and a non-RS256 alg", async () => {
    await assert.rejects(() => verify(signToken(claims(), { alg: "RS256", kid: "kid-2" })), /kid/);
    // alg:none must never reach signature verification.
    const bare = `${encode({ alg: "none", kid: "kid-1" })}.${encode(claims())}.AAAA`;
    await assert.rejects(() => verify(bare), /alg/);
  });
});

// ---------------------------------------------------------------------------
// Auth: login, signup, sessions (verifier seam stubbed)
// ---------------------------------------------------------------------------

const stubVerifier =
  (identity: GoogleIdentity) =>
  async (credential: string): Promise<GoogleIdentity> => {
    if (credential !== `cred-${identity.sub}`) throw new Error("bad credential");
    return identity;
  };

const DANA: GoogleIdentity = { sub: "sub-dana", email: "dana@example.com", name: "Dana Real" };

/** Run fn expecting an ApiError; hand it back for status/code assertions. */
function apiError(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ApiError, `expected an ApiError, got ${err}`);
    return err;
  }
  assert.fail("expected an ApiError, nothing was thrown");
}

describe("Auth", () => {
  const freshAuth = (t: { after: (fn: () => void) => void }, ttl?: { sessionMs: number; signupMs: number }) => {
    const db = new WorkspaceDb(":memory:");
    t.after(() => db.close());
    return { db, auth: new Auth(db, stubVerifier(DANA), true, ttl) };
  };

  test("first login needs a username; completing it creates the actor", async (t) => {
    const { db, auth } = freshAuth(t);

    const first = await auth.loginWithGoogle("cred-sub-dana");
    assert.equal(first.status, "needs_username");
    assert.ok(first.status === "needs_username" && first.signupToken);

    const signed = auth.completeSignup(
      first.status === "needs_username" ? first.signupToken : "",
      "  dana  ",
    );
    assert.equal(signed.username, "dana");
    const actor = db.findActorByGoogleSub("sub-dana");
    assert.ok(actor);
    assert.equal(actor.displayName, "dana");
    assert.equal(auth.resolveSession(signed.authToken)?.id, actor.id);
  });

  test("second login returns ok with the same actor", async (t) => {
    const { db, auth } = freshAuth(t);
    const first = await auth.loginWithGoogle("cred-sub-dana");
    assert.equal(first.status, "needs_username");
    auth.completeSignup(first.status === "needs_username" ? first.signupToken : "", "dana");

    const again = await auth.loginWithGoogle("cred-sub-dana");
    assert.equal(again.status, "ok");
    assert.ok(again.status === "ok" && again.username === "dana");
    const resolved = auth.resolveSession(again.status === "ok" ? again.authToken : "");
    assert.equal(resolved?.id, db.findActorByGoogleSub("sub-dana")!.id);
  });

  test("username collisions: case-insensitive human clash and agent names → 409", async (t) => {
    const { db, auth } = freshAuth(t);
    db.upsertActor("human", "Dana");
    db.upsertActor("agent", "noodle");
    const login = await auth.loginWithGoogle("cred-sub-dana");
    const signupToken = login.status === "needs_username" ? login.signupToken : "";

    for (const taken of ["dana", "DANA", "noodle"]) {
      const err = apiError(() => auth.completeSignup(signupToken, taken));
      assert.equal(err.status, 409, `name ${taken} must be refused`);
      assert.equal(err.code, "USERNAME_TAKEN");
    }
    // A free name still works afterwards: rejection must not burn the signup.
    assert.equal(auth.completeSignup(signupToken, "dana2").username, "dana2");
  });

  test("malformed usernames → 400 BAD_USERNAME", async (t) => {
    const { auth } = freshAuth(t);
    const login = await auth.loginWithGoogle("cred-sub-dana");
    const signupToken = login.status === "needs_username" ? login.signupToken : "";
    for (const bad of ["", "   ", "x".repeat(33), "no@sign", "sneaky\nname"]) {
      const err = apiError(() => auth.completeSignup(signupToken, bad));
      assert.equal(err.status, 400, `username ${JSON.stringify(bad)} must be refused`);
      assert.equal(err.code, "BAD_USERNAME");
    }
  });

  test("unknown or expired signup tokens → 410", async (t) => {
    const { auth } = freshAuth(t, { sessionMs: 60_000, signupMs: 20 });
    assert.equal(apiError(() => auth.completeSignup("nope", "dana")).status, 410);

    const login = await auth.loginWithGoogle("cred-sub-dana");
    const signupToken = login.status === "needs_username" ? login.signupToken : "";
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(apiError(() => auth.completeSignup(signupToken, "dana")).status, 410);
  });

  test("sessions expire after their TTL and die on logout", async (t) => {
    const { auth } = freshAuth(t, { sessionMs: 20, signupMs: 60_000 });
    const login = await auth.loginWithGoogle("cred-sub-dana");
    const { authToken } = auth.completeSignup(
      login.status === "needs_username" ? login.signupToken : "",
      "dana",
    );
    assert.ok(auth.resolveSession(authToken));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(auth.resolveSession(authToken), null);

    const again = await auth.loginWithGoogle("cred-sub-dana");
    const token = again.status === "ok" ? again.authToken : "";
    assert.ok(auth.resolveSession(token));
    auth.revoke(token);
    assert.equal(auth.resolveSession(token), null);
  });

  test("a credential the verifier refuses → 401 BAD_CREDENTIAL", async (t) => {
    const { auth } = freshAuth(t);
    await assert.rejects(
      () => auth.loginWithGoogle("forged"),
      (err: unknown) => err instanceof ApiError && err.status === 401,
    );
  });
});

// ---------------------------------------------------------------------------
// Auth: email/password signup and login
// ---------------------------------------------------------------------------

describe("Auth: email/password", () => {
  const freshEmailAuth = (t: { after: (fn: () => void) => void }, emailAuthEnabled = true) => {
    const db = new WorkspaceDb(":memory:");
    t.after(() => db.close());
    return { db, auth: new Auth(db, null, emailAuthEnabled) };
  };

  test("signup creates the actor and logs it in; login then finds the same actor", async (t) => {
    const { db, auth } = freshEmailAuth(t);
    const signed = auth.signupWithEmail("dana@example.com", "correct-horse", "dana");
    assert.equal(signed.username, "dana");
    const actor = db.findActorByEmail("dana@example.com");
    assert.ok(actor);
    assert.equal(auth.resolveSession(signed.authToken)?.id, actor.id);

    const again = auth.loginWithEmail("DANA@example.com", "correct-horse");
    assert.equal(again.username, "dana");
    assert.equal(auth.resolveSession(again.authToken)?.id, actor.id);
  });

  test("wrong password, and an unregistered email, both → 401 BAD_CREDENTIALS", (t) => {
    const { auth } = freshEmailAuth(t);
    auth.signupWithEmail("dana@example.com", "correct-horse", "dana");

    for (const attempt of [
      () => auth.loginWithEmail("dana@example.com", "wrong-password"),
      () => auth.loginWithEmail("nobody@example.com", "correct-horse"),
    ]) {
      const err = apiError(attempt);
      assert.equal(err.status, 401);
      assert.equal(err.code, "BAD_CREDENTIALS");
    }
  });

  test("duplicate email, taken username, weak password, bad email → rejected", (t) => {
    const { auth } = freshEmailAuth(t);
    auth.signupWithEmail("dana@example.com", "correct-horse", "dana");

    assert.equal(
      apiError(() => auth.signupWithEmail("dana@example.com", "another-pass", "dana2")).code,
      "EMAIL_TAKEN",
    );
    assert.equal(
      apiError(() => auth.signupWithEmail("new@example.com", "another-pass", "dana")).code,
      "USERNAME_TAKEN",
    );
    assert.equal(
      apiError(() => auth.signupWithEmail("new@example.com", "short", "newname")).code,
      "WEAK_PASSWORD",
    );
    assert.equal(
      apiError(() => auth.signupWithEmail("not-an-email", "another-pass", "newname")).code,
      "BAD_EMAIL",
    );
  });

  test("email auth disabled → 409 AUTH_DISABLED on both signup and login", (t) => {
    const { auth } = freshEmailAuth(t, false);
    assert.equal(
      apiError(() => auth.signupWithEmail("dana@example.com", "correct-horse", "dana")).status,
      409,
    );
    assert.equal(apiError(() => auth.loginWithEmail("dana@example.com", "correct-horse")).status, 409);
  });

  test("a Google-only account (no password set) refuses email login → 401", (t) => {
    const db = new WorkspaceDb(":memory:");
    t.after(() => db.close());
    const auth = new Auth(db, stubVerifier(DANA), true);
    db.createGoogleHuman("dana", "sub-dana", "dana@example.com");
    const err = apiError(() => auth.loginWithEmail("dana@example.com", "anything"));
    assert.equal(err.status, 401);
    assert.equal(err.code, "BAD_CREDENTIALS");
  });
});

// ---------------------------------------------------------------------------
// Websocket join gating (auth-enabled hub; guest mode is covered by the
// untouched existing suites)
// ---------------------------------------------------------------------------

describe("ws join gating with auth enabled", async () => {
  const env = await createWsEnv({
    auth: { verifier: stubVerifier(DANA), agentToken: "secret123" },
  });
  after(() => env.close());

  const signIn = async (): Promise<string> => {
    const login = await env.auth!.loginWithGoogle("cred-sub-dana");
    if (login.status === "ok") return login.authToken;
    return env.auth!.completeSignup(login.signupToken, "dana").authToken;
  };

  test("humans without a token, or with a dead one, are refused and closed", async () => {
    const bare = await env.join({ type: "join", name: "mallory", kind: "human" });
    assert.equal(bare.welcome, null);
    assert.equal(bare.error, "unauthenticated");
    assert.equal(bare.closed, true);

    const dead = await env.join({ type: "join", kind: "human", authToken: "not-a-session" });
    assert.equal(dead.welcome, null);
    assert.equal(dead.error, "unauthenticated");
  });

  test("a live session joins as its own username, whatever the frame claims", async () => {
    const authToken = await signIn();
    const outcome = await env.join({
      type: "join",
      kind: "human",
      name: "impostor",
      authToken,
    });
    assert.ok(outcome.welcome, "expected a welcome");
    assert.equal(outcome.welcome.self.name, "dana");
    assert.equal(outcome.welcome.self.id, env.db.findActorByGoogleSub("sub-dana")!.id);
  });

  test("agents need the exact shared secret", async () => {
    const missing = await env.join({ type: "join", name: "noodle", kind: "agent" });
    assert.equal(missing.welcome, null);
    assert.equal(missing.error, "unauthenticated");

    const wrong = await env.join({
      type: "join",
      name: "noodle",
      kind: "agent",
      authToken: "secret124",
    });
    assert.equal(wrong.welcome, null);

    const right = await env.join({
      type: "join",
      name: "noodle",
      kind: "agent",
      authToken: "secret123",
    });
    assert.ok(right.welcome, "expected a welcome");
    assert.equal(right.welcome.self.name, "noodle");
    assert.equal(right.welcome.self.kind, "agent");
  });
});
