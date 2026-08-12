import assert from "node:assert/strict";
import http from "node:http";
import { after, describe, test } from "node:test";
import { createWsEnv, type FakeSupabaseUser } from "./helpers";

// ---------------------------------------------------------------------------
// The complete sign-up/onboarding journey, server-side: Supabase hands the
// client a verified JWT (faked here), then the server takes over — GET
// /api/auth/session, the username step, the ws join gate, and the welcome
// frame's HTTP bearer token that carries the user into the main app. One
// env, one schema; every journey uses its own prefixed usernames.
// ---------------------------------------------------------------------------

describe("sign-up/onboarding journey", async () => {
  // The table object is read per getUser call, so tests may mutate it
  // mid-flight (the outage journey depends on that).
  const users: Record<string, FakeSupabaseUser | "unavailable"> = {
    "tok-alice": {
      id: "user-alice",
      email: "alice@example.com",
      user_metadata: { desired_username: "journey1-alice" },
    },
    "tok-bob": { id: "user-bob", email: "bob@example.com" },
    "tok-carol": { id: "user-carol", email: null },
    "tok-dup1": { id: "user-dup1", email: null, user_metadata: { desired_username: "journey5-dupe" } },
    "tok-dup2": { id: "user-dup2", email: null, user_metadata: { desired_username: "journey5-dupe" } },
    "tok-outage": "unavailable",
    "tok-frank": { id: "user-frank", email: null, user_metadata: { desired_username: "journey6-frank" } },
    "tok-mallory": { id: "user-mallory", email: null },
  };
  const env = await createWsEnv({ auth: { users, agentToken: "agent-secret" } });
  after(() => env.close());

  const get = async (path: string, token?: string) => {
    const res = await fetch(`${env.baseUrl}${path}`, {
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: await res.json() };
  };
  const post = async (path: string, token: string, body?: unknown) => {
    const res = await fetch(`${env.baseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  test("email signup with chosen username onboards straight through", async () => {
    // The email signup form stashed desired_username in user_metadata, so
    // the first session call auto-claims it — no username step.
    const session = await get("/api/auth/session", "tok-alice");
    assert.equal(session.status, 200);
    assert.deepEqual(session.body, { status: "ok", username: "journey1-alice" });

    // Into the app: the ws join presents the same Supabase token.
    const joined = await env.join({ type: "join", kind: "human", authToken: "tok-alice" });
    assert.ok(joined.welcome, `expected a welcome, got error: ${joined.error}`);
    assert.equal(joined.error, null);
    assert.equal(joined.welcome.self.name, "journey1-alice");
    assert.equal(joined.welcome.self.kind, "human");
    assert.equal(joined.welcome.self.id, "user-alice");

    // The welcome frame's token binds the HTTP session — the last hop of
    // onboarding is being a first-class API caller.
    assert.equal(typeof joined.welcome.token, "string");
    const roster = await get("/api/actors", joined.welcome.token);
    assert.equal(roster.status, 200);
    const self = roster.body.actors.find((a: { id: string }) => a.id === "user-alice");
    assert.ok(self, "expected the new user in the roster");
    assert.equal(self.displayName, "journey1-alice");
    assert.equal(self.kind, "human");
  });

  test("google-style signup (no metadata) onboards via the username step", async () => {
    // Google OAuth carries no desired_username, so the server asks for one.
    const first = await get("/api/auth/session", "tok-bob");
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { status: "needs_username" });

    const claim = await post("/api/auth/username", "tok-bob", { username: "journey2-bob" });
    assert.equal(claim.status, 200);
    assert.deepEqual(claim.body, { username: "journey2-bob" });

    const second = await get("/api/auth/session", "tok-bob");
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, { status: "ok", username: "journey2-bob" });

    const joined = await env.join({ type: "join", kind: "human", authToken: "tok-bob" });
    assert.ok(joined.welcome, `expected a welcome, got error: ${joined.error}`);
    assert.equal(joined.welcome.self.name, "journey2-bob");
    assert.equal(joined.welcome.self.id, "user-bob");
  });

  test("claim is permanent: second sign-in skips the username step", async () => {
    // A returning user goes straight to ok — no username step ever again.
    const session = await get("/api/auth/session", "tok-bob");
    assert.equal(session.status, 200);
    assert.deepEqual(session.body, { status: "ok", username: "journey2-bob" });

    // Re-claiming with a DIFFERENT name never rebinds: idempotent 200
    // returning the original (two tabs finishing signup at once).
    const reclaim = await post("/api/auth/username", "tok-bob", { username: "journey3-imposter" });
    assert.equal(reclaim.status, 200);
    assert.deepEqual(reclaim.body, { username: "journey2-bob" });
  });

  test("username conflicts", async () => {
    // Same name as journey 2's user, different case: taken is case-insensitive.
    const humanClash = await post("/api/auth/username", "tok-carol", { username: "JOURNEY2-BOB" });
    assert.equal(humanClash.status, 409);
    assert.equal(humanClash.body.error, "USERNAME_TAKEN");

    const humanProbe = await get(`/api/auth/username-available?name=${encodeURIComponent("JOURNEY2-BOB")}`);
    assert.equal(humanProbe.status, 200);
    assert.deepEqual(humanProbe.body, { available: false, reason: "TAKEN" });

    // Agents occupy the same namespace: nobody can sign up as the bot.
    const bot = await env.join({ type: "join", kind: "agent", name: "botley", authToken: "agent-secret" });
    assert.ok(bot.welcome, `expected the agent to join, got error: ${bot.error}`);
    assert.equal(bot.welcome.self.name, "botley");

    const agentProbe = await get("/api/auth/username-available?name=botley");
    assert.equal(agentProbe.status, 200);
    assert.deepEqual(agentProbe.body, { available: false, reason: "TAKEN" });

    const agentClash = await post("/api/auth/username", "tok-carol", { username: "botley" });
    assert.equal(agentClash.status, 409);
    assert.equal(agentClash.body.error, "USERNAME_TAKEN");
  });

  test("duplicate desired_username falls back cleanly", async () => {
    // Two signups picked the same desired_username; the first session call
    // wins the auto-claim.
    const first = await get("/api/auth/session", "tok-dup1");
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { status: "ok", username: "journey5-dupe" });

    // The loser is NOT an error — it falls back to the manual username step.
    const second = await get("/api/auth/session", "tok-dup2");
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, { status: "needs_username" });

    const claim = await post("/api/auth/username", "tok-dup2", { username: "journey5-dupe2" });
    assert.equal(claim.status, 200);
    assert.deepEqual(claim.body, { username: "journey5-dupe2" });
  });

  test("a Supabase outage never breaks onboarding fatally", async () => {
    // (a) A never-verified token during an outage: 503 AUTH_UNAVAILABLE,
    // never a 401 — a 401 would make the client sign the user out.
    const session = await get("/api/auth/session", "tok-outage");
    assert.equal(session.status, 503);
    assert.equal(session.body.error, "AUTH_UNAVAILABLE");

    // The ws join closes retryably, not with the fatal "unauthenticated".
    const joined = await env.join({ type: "join", kind: "human", authToken: "tok-outage" });
    assert.equal(joined.welcome, null);
    assert.equal(joined.error, "auth temporarily unavailable");
    assert.notEqual(joined.error, "unauthenticated");
    assert.equal(joined.closed, true);

    // (b) A user who already onboarded rides out the outage on the verify
    // cache — one Auth instance serves HTTP and ws, so the HTTP session
    // call warms the cache the ws join reads.
    const before = await get("/api/auth/session", "tok-frank");
    assert.deepEqual(before.body, { status: "ok", username: "journey6-frank" });
    const firstJoin = await env.join({ type: "join", kind: "human", authToken: "tok-frank" });
    assert.ok(firstJoin.welcome, `expected a welcome, got error: ${firstJoin.error}`);

    users["tok-frank"] = "unavailable"; // Supabase goes down...
    const rejoin = await env.join({ type: "join", kind: "human", authToken: "tok-frank" });
    assert.ok(rejoin.welcome, `expected the cache to absorb the outage, got error: ${rejoin.error}`);
    assert.equal(rejoin.welcome.self.name, "journey6-frank");
  });

  test("malformed inputs are rejected, never crash", async () => {
    // An invalid username from a verified user: the specific 400.
    const bad = await post("/api/auth/username", "tok-mallory", { username: "***" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "BAD_USERNAME");

    // An empty body is a schema failure, still a clean 400.
    const empty = await post("/api/auth/username", "tok-mallory");
    assert.equal(empty.status, 400);

    // Absurd lengths are just "invalid" — the probe endpoint always answers 200.
    const long = await get(`/api/auth/username-available?name=${"x".repeat(250)}`);
    assert.equal(long.status, 200);
    assert.deepEqual(long.body, { available: false, reason: "INVALID" });

    // No Authorization header at all vs. a garbage bearer: distinct codes.
    const anonymous = await get("/api/auth/session");
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error, "UNAUTHENTICATED");

    const garbage = await get("/api/auth/session", "not-a-supabase-jwt");
    assert.equal(garbage.status, 401);
    assert.equal(garbage.body.error, "BAD_CREDENTIAL");
  });

  // Browsers attach an Origin header to POSTs even same-origin, and prod
  // serves client+API from one origin that is neither localhost nor the
  // CORS_ORIGIN default. Classifying that as cross-origin once swallowed
  // every browser POST in production as a silent 204 (the claim "succeeded"
  // client-side, no actor existed, the ws join bounced the user out).
  test("same-origin POSTs route; foreign-origin POSTs fail loudly", async () => {
    // node fetch can't spoof Host, so use http.request to replay prod: the
    // page and the API share the host, and the browser sends both headers.
    const { port } = new URL(env.baseUrl);
    const request = (headers: Record<string, string>, method = "POST") =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, path: "/api/auth/username", method, headers },
          (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on("error", reject);
        req.end(method === "POST" ? JSON.stringify({ username: "cors-probe" }) : undefined);
      });

    const sameOrigin = await request({
      host: "app.convyio.com",
      origin: "https://app.convyio.com",
      authorization: "Bearer not-a-supabase-jwt",
      "content-type": "application/json",
    });
    // 401 BAD_CREDENTIAL proves the request ROUTED (under the bug: silent 204).
    assert.equal(sameOrigin.status, 401);
    assert.equal(JSON.parse(sameOrigin.body).error, "BAD_CREDENTIAL");

    const foreign = await request({
      host: "app.convyio.com",
      origin: "https://evil.example.com",
      authorization: "Bearer not-a-supabase-jwt",
      "content-type": "application/json",
    });
    assert.equal(foreign.status, 403);
    assert.equal(JSON.parse(foreign.body).error, "ORIGIN_FORBIDDEN");

    // Preflight for a disallowed origin stays a bare 204 (the browser then
    // refuses to send the real request).
    const preflight = await request(
      { host: "app.convyio.com", origin: "https://evil.example.com" },
      "OPTIONS",
    );
    assert.equal(preflight.status, 204);
  });
});
