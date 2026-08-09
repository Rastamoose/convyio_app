import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Auth } from "../src/auth/Auth";
import { ApiError } from "../src/board/BoardService";
import { createTestDb } from "./pgSchema";
import type { WorkspaceDb } from "../src/db";

/** A fake Supabase admin client: getUser(jwt) resolves via a fixed lookup
 *  table the test controls, so these tests never touch the network. */
function fakeSupabase(users: Record<string, { id: string; email: string | null }>): SupabaseClient {
  return {
    auth: {
      getUser: async (jwt: string) => {
        const user = users[jwt];
        return user ? { data: { user }, error: null } : { data: { user: null }, error: new Error("invalid") };
      },
    },
  } as unknown as SupabaseClient;
}

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
});
