import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Auth } from "../src/auth/Auth";
import { ApiError } from "../src/board/BoardService";
import { createTestDb } from "./pgSchema";
import type { WorkspaceDb } from "../src/db";
import { createWsEnv, fakeSupabase } from "./helpers";

describe("Auth", () => {
  let db: WorkspaceDb;
  let drop: () => Promise<void>;

  before(async () => {
    ({ db, drop } = await createTestDb());
  });
  after(() => drop());

  test("session() reports needs_username for a verified token with no bound actor", async () => {
    const auth = new Auth(db, fakeSupabase({ "tok-1": { id: "user-1", email: "a@example.com" } }));
    assert.deepEqual(await auth.session("tok-1"), { status: "needs_username" });
  });

  test("session() throws BAD_CREDENTIAL for an unverifiable token", async () => {
    const auth = new Auth(db, fakeSupabase({}));
    await assert.rejects(auth.session("bad-tok"), (err) => err instanceof ApiError && err.code === "BAD_CREDENTIAL");
  });

  test("claimUsername() creates the actor with the Supabase user id and rejects a repeat with a different name", async () => {
    const auth = new Auth(db, fakeSupabase({ "tok-2": { id: "user-2", email: "b@example.com" } }));
    const result = await auth.claimUsername("tok-2", "Dana");
    assert.equal(result.username, "Dana");
    const actor = await db.getActor("user-2");
    assert.equal(actor?.displayName, "Dana");
    // Idempotent: a second claim with the same token returns the bound name.
    const again = await auth.claimUsername("tok-2", "SomeoneElse");
    assert.equal(again.username, "Dana");
  });

  test("claimUsername() rejects a name already taken", async () => {
    const auth = new Auth(
      db,
      fakeSupabase({
        "tok-3": { id: "user-3", email: null },
        "tok-4": { id: "user-4", email: null },
      }),
    );
    await auth.claimUsername("tok-3", "Taken");
    await assert.rejects(auth.claimUsername("tok-4", "Taken"), (err) => err instanceof ApiError && err.code === "USERNAME_TAKEN");
  });

  test("resolveSession() returns the bound actor for a claimed token, null otherwise", async () => {
    const auth = new Auth(db, fakeSupabase({ "tok-5": { id: "user-5", email: null } }));
    assert.equal(await auth.resolveSession("tok-5"), null);
    await auth.claimUsername("tok-5", "Erin");
    const actor = await auth.resolveSession("tok-5");
    assert.equal(actor?.displayName, "Erin");
  });

  test("session() auto-claims desired_username from Supabase user_metadata", async () => {
    const auth = new Auth(
      db,
      fakeSupabase({
        "tok-6": { id: "user-6", email: "f@example.com", user_metadata: { desired_username: "Frankie" } },
      }),
    );
    assert.deepEqual(await auth.session("tok-6"), { status: "ok", username: "Frankie" });
    const actor = await db.getActor("user-6");
    assert.equal(actor?.displayName, "Frankie");
  });

  test("session() falls back to needs_username when desired_username is already taken", async () => {
    const auth = new Auth(
      db,
      fakeSupabase({
        "tok-7": { id: "user-7", email: null },
        "tok-8": { id: "user-8", email: null, user_metadata: { desired_username: "Grace" } },
      }),
    );
    await auth.claimUsername("tok-7", "Grace");
    assert.deepEqual(await auth.session("tok-8"), { status: "needs_username" });
    assert.equal(await db.getActor("user-8"), null);
  });

  test("session() falls back to needs_username for an invalid desired_username", async () => {
    const auth = new Auth(
      db,
      fakeSupabase({
        "tok-9": { id: "user-9", email: null, user_metadata: { desired_username: "***bad***" } },
      }),
    );
    assert.deepEqual(await auth.session("tok-9"), { status: "needs_username" });
    assert.equal(await db.getActor("user-9"), null);
  });

  test("usernameAvailable() reports free, taken (case-insensitively) and invalid names", async () => {
    const auth = new Auth(db, fakeSupabase({ "tok-10": { id: "user-10", email: null } }));
    assert.deepEqual(await auth.usernameAvailable("Hana"), { available: true });
    await auth.claimUsername("tok-10", "Hana");
    assert.deepEqual(await auth.usernameAvailable("hana"), { available: false, reason: "TAKEN" });
    assert.deepEqual(await auth.usernameAvailable("***"), { available: false, reason: "INVALID" });
  });
});

// ---------------------------------------------------------------------------
// Websocket join gating (auth-enabled hub; guest mode is covered by the
// untouched existing suites)
// ---------------------------------------------------------------------------

describe("ws join gating with auth enabled", async () => {
  const env = await createWsEnv({
    auth: { users: { "tok-dana": { id: "user-dana", email: "dana@example.com" } }, agentToken: "secret123" },
  });
  after(() => env.close());

  const signIn = async (): Promise<string> => {
    const session = await env.auth!.session("tok-dana");
    if (session.status === "ok") return "tok-dana";
    await env.auth!.claimUsername("tok-dana", "dana");
    return "tok-dana";
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
    assert.equal(outcome.welcome.self.id, (await env.db.getActor("user-dana"))!.id);
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
