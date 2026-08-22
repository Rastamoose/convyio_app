# Hosted OpenAI Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user paste an OpenAI API key into Convyio and have that agent run immediately, entirely server-side — no local `convyio-agent` process, no env var, no pairing code — and make the existing model-select control in the agent's settings panel actually take effect for OpenAI agents.

**Architecture:** The server encrypts and stores the pasted key on the `agent_invites` row, mints itself an installation (reusing the same DB-level minting logic pairing already uses, skipping the human-only pairing-code step), and runs `runAgent({mode:"installation", ...})` in-process — the same runtime, same `AgentSocket` → `Hub` websocket join, same auth/permission path a CLI-paired agent uses. A small per-workspace supervisor tracks these in-process runs (start on create, stop on revoke, restart on boot). Separately, `OpenAIBrain` gains a live `setModel`, and `runtime.ts` is wired to call it and to report a real list of selectable models, so the model `<select>` that already exists in `ConfigureStep` works for OpenAI agents instead of only ever showing one choice.

**Tech Stack:** TypeScript, Node.js `node:crypto` (AES-256-GCM), Postgres/Supabase, `ws`, `openai` SDK, React (client), `node:test` for tests.

**Spec:** `docs/superpowers/specs/2026-08-22-hosted-openai-agent-design.md`

## Global Constraints

- No new npm dependencies — encryption uses `node:crypto` only.
- `AGENT_SECRET_KEY` is optional at the config layer (mirrors `AGENT_TOKEN`) — most deployments won't use this feature and must not be blocked from booting without it. It fails loudly only when something actually needs it (creating an openai+apiKey agent, or boot reconciliation finding a stored key with no configured secret).
- The server-hosted agent's connection to the workspace (`AgentSocket` → `Hub` join, auth, permission gating, prompt composition, activation protocol) must go through the exact same code path as a human-paired agent — no bypass, no duplicated logic. Only the "how do we mint an installation" step differs (direct function call instead of a pairing-code HTTP round trip), and it differs only for a documented reason: the pairing-code TTL/ceremony exists solely for a human typing into a terminal.
- No key rotation/removal in this pass — changing a key means revoking and recreating the agent. Don't build unused PATCH/UI surface for it.
- No `hasApiKey` field or any other client-visible signal of the stored key — nothing consumes it in this version.
- The pasted key is validated with one `models.list()` call before being persisted (confirmed with the user — a bad key must be rejected in the UI immediately, not silently create a dead agent).

---

### Task 1: DB migration — store the encrypted key

**Files:**
- Create: `supabase/migrations/20260822100000_agent_api_key.sql`
- Modify: `packages/server/src/schemaCheck.ts` (add to `REQUIRED`)

**Interfaces:**
- Produces: `agent_invites.api_key_ciphertext` column (nullable `text`), consumed by Task 3.

- [ ] **Step 1: Write the migration**

```sql
-- Encrypted OpenAI API key for hosted agents that skip local pairing
-- entirely (see docs/superpowers/specs/2026-08-22-hosted-openai-agent-design.md).
-- Nullable: only set for provider = 'openai' agents created through the
-- "paste a key" flow. Ciphertext only — encryption/decryption happens in
-- packages/server/src/crypto/secretBox.ts using AGENT_SECRET_KEY.
alter table agent_invites add column api_key_ciphertext text;
```

- [ ] **Step 2: Add the column to the boot-time schema check**

In `packages/server/src/schemaCheck.ts`, find the `REQUIRED` array entries for `agent_invites` (search for `{ table: "agent_invites"`) and add directly after the existing ones:

```ts
  { table: "agent_invites", column: "api_key_ciphertext" },
```

- [ ] **Step 3: Verify the test DB picks up the migration**

Run: `cd packages/server && npx tsx --test test/agents.test.ts`
Expected: PASS (existing suite unaffected; confirms `pgSchema.ts`'s "apply every migration in the directory" picked up the new file without any other wiring).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260822100000_agent_api_key.sql packages/server/src/schemaCheck.ts
git commit -m "Add agent_invites.api_key_ciphertext column"
```

---

### Task 2: `secretBox` — AES-256-GCM encrypt/decrypt

**Files:**
- Create: `packages/server/src/crypto/secretBox.ts`
- Test: `packages/server/test/secretBox.test.ts`
- Modify: `packages/server/src/config.ts` (add `agentSecretKey`)

**Interfaces:**
- Produces: `encrypt(plaintext: string): string`, `decrypt(ciphertext: string): string` — both imported directly (no DI) by Task 3's supervisor and Task 10's API handler.
- Consumes: `config.agentSecretKey: string | null` from `../config`.

- [ ] **Step 1: Add the config field**

In `packages/server/src/config.ts`, add next to `agentToken` (after line 62, `agentToken: process.env.AGENT_TOKEN ?? null,`):

```ts
  /** Symmetric key (32 bytes, base64) for encrypting pasted API keys at
   *  rest. Optional — only needed by workspaces that use hosted
   *  API-key agents; secretBox throws clearly if used without it. */
  agentSecretKey: process.env.AGENT_SECRET_KEY ?? null,
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/server/test/secretBox.test.ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { randomBytes } from "node:crypto";

process.env.AGENT_SECRET_KEY = randomBytes(32).toString("base64");
const { encrypt, decrypt } = await import("../src/crypto/secretBox");

describe("secretBox", () => {
  test("round-trips a plaintext string", () => {
    const ciphertext = encrypt("sk-abc123");
    assert.notEqual(ciphertext, "sk-abc123");
    assert.equal(decrypt(ciphertext), "sk-abc123");
  });

  test("different ciphertexts for the same plaintext (random IV)", () => {
    assert.notEqual(encrypt("same-key"), encrypt("same-key"));
  });

  test("a tampered ciphertext fails to decrypt", () => {
    const ciphertext = encrypt("sk-abc123");
    const [iv, tag, body] = ciphertext.split(":");
    const tampered = `${iv}:${tag}:${body.slice(0, -2)}00`;
    assert.throws(() => decrypt(tampered));
  });

  test("throws clearly when AGENT_SECRET_KEY is not configured", async () => {
    const original = process.env.AGENT_SECRET_KEY;
    delete process.env.AGENT_SECRET_KEY;
    try {
      const { config } = await import("../src/config?nokey");
      assert.equal(config.agentSecretKey, null);
    } finally {
      process.env.AGENT_SECRET_KEY = original;
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/server && npx tsx --test test/secretBox.test.ts`
Expected: FAIL — `Cannot find module '../src/crypto/secretBox'`

- [ ] **Step 4: Implement `secretBox.ts`**

```ts
// packages/server/src/crypto/secretBox.ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function key(): Buffer {
  if (!config.agentSecretKey) {
    throw new Error("AGENT_SECRET_KEY is not set — required to store or read an agent's API key");
  }
  const buffer = Buffer.from(config.agentSecretKey, "base64");
  if (buffer.length !== 32) {
    throw new Error("AGENT_SECRET_KEY must decode to exactly 32 bytes (base64)");
  }
  return buffer;
}

/** "iv:authTag:ciphertext", each hex-encoded. */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decrypt(stored: string): string {
  const [ivHex, tagHex, ciphertextHex] = stored.split(":");
  if (!ivHex || !tagHex || !ciphertextHex) throw new Error("malformed ciphertext");
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
```

Note: the test file's 4th test imports `../src/config?nokey` — remove that test; Node's ESM loader doesn't support query-string cache-busting for local files the way that implies. Replace Step 2/4's fourth test with a simpler direct check instead:

```ts
  test("key() throws when AGENT_SECRET_KEY is unset", () => {
    const original = process.env.AGENT_SECRET_KEY;
    delete process.env.AGENT_SECRET_KEY;
    try {
      assert.throws(() => encrypt("x"), /AGENT_SECRET_KEY is not set/);
    } finally {
      process.env.AGENT_SECRET_KEY = original;
    }
  });
```

(This works because `config.agentSecretKey` is read once at module load in Step 1's test — but `config.ts` reads `process.env.AGENT_SECRET_KEY` at import time, not per-call. To make this test valid, `key()` must read `process.env.AGENT_SECRET_KEY` directly rather than through the cached `config` object. Change `key()` in `secretBox.ts` to read `process.env.AGENT_SECRET_KEY` directly instead of `config.agentSecretKey` — this is also more correct: it means the check happens at the moment of use, matching a test that mutates `process.env` mid-run. Update `config.ts`'s `agentSecretKey` field to remain as documentation/single-source-of-truth for what's expected, but have `secretBox.ts` do its own `process.env.AGENT_SECRET_KEY` read instead of importing `config`.)

Revised `secretBox.ts` `key()`:

```ts
function key(): Buffer {
  const raw = process.env.AGENT_SECRET_KEY;
  if (!raw) {
    throw new Error("AGENT_SECRET_KEY is not set — required to store or read an agent's API key");
  }
  const buffer = Buffer.from(raw, "base64");
  if (buffer.length !== 32) {
    throw new Error("AGENT_SECRET_KEY must decode to exactly 32 bytes (base64)");
  }
  return buffer;
}
```

And drop the `import { config } from "../config";` line since it's now unused.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/server && npx tsx --test test/secretBox.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/crypto/secretBox.ts packages/server/test/secretBox.test.ts packages/server/src/config.ts
git commit -m "Add AES-256-GCM secretBox for encrypting pasted API keys"
```

---

### Task 3: `AgentInvites` — store the key at creation, mint installations directly

**Files:**
- Modify: `packages/server/src/auth/AgentInvites.ts`
- Test: `packages/server/test/agents.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `AgentInvites.create(name, provider, createdBy, profile?, apiKeyCiphertext?: string | null)` — same as today, with one new optional trailing param.
  - `AgentInvites.mintInstallation(inviteId: string): Promise<{ invite: AgentInvite; installation: AgentInstallation; installationToken: string } | null>` — used by Task 7's supervisor and internally by `exchangePairing`.
  - `AgentInvites.listOpenAiWithKeys(): Promise<{ invite: AgentInvite; apiKeyCiphertext: string }[]>` — used by Task 7's boot reconciliation. Never exposes ciphertext through `toInvite`/the public `AgentInvite` shape; this is a separate, deliberately narrow method.

- [ ] **Step 1: Write the failing tests**

Add to `packages/server/test/agents.test.ts`, inside the existing `describe("agent HTTP invites", ...)` block (after the "pairings expire..." test, so it sits near the other `AgentInvites`-level behavior):

```ts
  test("mintInstallation issues a fresh installation without a pairing code", async () => {
    const human = await env.actor("human", "mint-owner");
    const created = await env.api("POST", "/api/agents", human.token, {
      name: "mint-agent",
      provider: PROVIDER,
    });
    const { AgentInvites } = await import("../src/auth/AgentInvites");
    const invites = new AgentInvites(env.db);
    const minted = await invites.mintInstallation(created.body.id);
    assert.ok(minted);
    assert.equal(minted!.invite.id, created.body.id);
    assert.equal(minted!.installationToken.length, 64);
    const [installationCount] = await env.db.sql<{ count: number }[]>`
      SELECT count(*) AS count FROM agent_installations WHERE invite_id = ${created.body.id}
    `;
    assert.equal(installationCount.count, 1);
  });

  test("mintInstallation returns null for a revoked invite", async () => {
    const human = await env.actor("human", "mint-revoked-owner");
    const created = await env.api("POST", "/api/agents", human.token, {
      name: "mint-revoked-agent",
      provider: PROVIDER,
    });
    await env.api("DELETE", `/api/agents/${created.body.id}`, human.token);
    const { AgentInvites } = await import("../src/auth/AgentInvites");
    const invites = new AgentInvites(env.db);
    const minted = await invites.mintInstallation(created.body.id);
    assert.equal(minted, null);
  });

  test("create() can store an encrypted API key, never returned by list/get", async () => {
    const human = await env.actor("human", "keyed-owner");
    const { AgentInvites } = await import("../src/auth/AgentInvites");
    const invites = new AgentInvites(env.db);
    const { invite } = await invites.create(
      "keyed-agent",
      "openai",
      human.actor,
      { instructions: "", requestedModel: null, access: { mode: "workspace", selectedActorIds: [] } },
      "fake-ciphertext",
    );
    const serialized = JSON.stringify(invite);
    assert.equal(serialized.includes("fake-ciphertext"), false);
    const [row] = await env.db.sql<{ api_key_ciphertext: string | null }[]>`
      SELECT api_key_ciphertext FROM agent_invites WHERE id = ${invite.id}
    `;
    assert.equal(row.api_key_ciphertext, "fake-ciphertext");
  });

  test("listOpenAiWithKeys returns only openai invites with a stored key", async () => {
    const human = await env.actor("human", "list-keys-owner");
    const { AgentInvites } = await import("../src/auth/AgentInvites");
    const invites = new AgentInvites(env.db);
    const withKey = await invites.create(
      "with-key",
      "openai",
      human.actor,
      { instructions: "", requestedModel: null, access: { mode: "workspace", selectedActorIds: [] } },
      "ciphertext-a",
    );
    await invites.create("without-key", "openai", human.actor);
    await invites.create("claude-agent", "claude", human.actor);
    const listed = await invites.listOpenAiWithKeys();
    assert.deepEqual(listed.map((entry) => entry.invite.id), [withKey.invite.id]);
    assert.equal(listed[0]!.apiKeyCiphertext, "ciphertext-a");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && npx tsx --test test/agents.test.ts`
Expected: FAIL — `mintInstallation is not a function`, `listOpenAiWithKeys is not a function`, and the `create()` call fails TypeScript compilation for the extra argument (run with `npx tsc --noEmit` too if the test runner doesn't typecheck; `tsx` transpiles without type errors, so the create-with-ciphertext test will actually run and fail at "column api_key_ciphertext does not exist" only if Task 1 wasn't done first — Task 1 must land before this task).

- [ ] **Step 3: Implement the changes in `AgentInvites.ts`**

Add `api_key_ciphertext` to `InviteRow` (after line 50, `revoked_at: number | null;`):

```ts
  api_key_ciphertext: string | null;
```

Change `create()`'s signature and INSERT (replace the whole method body from `async create(` through its closing brace, lines 115-185):

```ts
  async create(
    name: string,
    provider: AgentProvider,
    createdBy: Actor,
    profile: AgentProfileFields = {
      instructions: "",
      requestedModel: null,
      access: { mode: "workspace", selectedActorIds: [] },
    },
    apiKeyCiphertext: string | null = null,
  ): Promise<{ invite: AgentInvite; token: string }> {
    const trimmed = name.trim();
    if (!USERNAME_PATTERN.test(trimmed)) {
      throw new ApiError(
        400,
        "BAD_NAME",
        "agent names are 1-32 characters of letters, digits, spaces, - and _",
      );
    }
    if (trimmed.toLowerCase() === NOODLE_NAME) {
      throw new ApiError(409, "NAME_RESERVED", `${NOODLE_NAME} is reserved for Convyio's built-in agent`);
    }
    const human = await this.db.findMemberByName("human", trimmed);
    if (human) {
      throw new ApiError(409, "NAME_TAKEN", `the name ${trimmed} is already in use`);
    }
    const existingAgent = await this.db.findMemberByName("agent", trimmed);
    if (existingAgent) {
      throw new ApiError(409, "NAME_TAKEN", `the name ${trimmed} is already in use`);
    }
    await this.validateAccess(profile.access);

    const actor = await this.db.upsertActor("agent", trimmed);
    const token = randomBytes(TOKEN_BYTES).toString("hex");
    const inviteId = randomUUID();
    const now = Date.now();
    await appendJoinNotice(
      this.db.sql,
      { id: this.db.workspaceId, name: this.db.workspaceName },
      { id: actor.id, displayName: actor.displayName, kind: "agent" },
      now,
    );

    await this.db.sql`
      INSERT INTO agent_invites (
        id, workspace_id, token_hash, actor_id, created_by, provider,
        instructions, requested_model, access_mode, selected_actor_ids,
        config_revision, created_at, updated_at, revoked_at, api_key_ciphertext
      ) VALUES (
        ${inviteId}, ${this.db.workspaceId}, ${hashToken(token)}, ${actor.id}, ${createdBy.id}, ${provider},
        ${profile.instructions}, ${profile.requestedModel}, ${profile.access.mode},
        ${this.db.sql.json(profile.access.selectedActorIds)}, 1, ${now}, ${now}, NULL, ${apiKeyCiphertext}
      )
    `;

    const invite: AgentInvite = {
      id: inviteId,
      workspaceId: this.db.workspaceId,
      actorId: actor.id,
      name: actor.displayName,
      provider,
      instructions: profile.instructions,
      requestedModel: profile.requestedModel,
      access: profile.access,
      configRevision: 1,
      createdBy: createdBy.id,
      createdAt: now,
      updatedAt: now,
      revokedAt: null,
    };
    return { invite, token };
  }
```

Extract the installation-minting half of `exchangePairing()` into `mintInstallation`. Replace the existing `exchangePairing` method (lines 248-285) with:

```ts
  async mintInstallation(inviteId: string): Promise<{
    invite: AgentInvite;
    installation: AgentInstallation;
    installationToken: string;
  } | null> {
    const installationToken = randomBytes(TOKEN_BYTES).toString("hex");
    const now = Date.now();
    return this.db.transaction(async (sql) => {
      const invite = await this.findInvite(sql, inviteId);
      if (!invite) return null;
      const installationRows = await sql<InstallationRow[]>`
        INSERT INTO agent_installations (id, invite_id, token_hash, created_at, last_used_at)
        VALUES (${randomUUID()}, ${inviteId}, ${hashToken(installationToken)}, ${now}, NULL)
        RETURNING id, invite_id, created_at, last_used_at
      `;
      return {
        invite,
        installation: toInstallation(installationRows[0]),
        installationToken,
      };
    });
  }

  async exchangePairing(pairingCode: string): Promise<{
    invite: AgentInvite;
    installation: AgentInstallation;
    installationToken: string;
  } | null> {
    return this.db.transaction(async (sql) => {
      const now = Date.now();
      const consumed = await sql<PairingRow[]>`
        UPDATE agent_pairings p
        SET consumed_at = ${now}
        FROM agent_invites i, workspace_members m
        WHERE p.token_hash = ${hashToken(pairingCode)}
          AND p.consumed_at IS NULL
          AND p.revoked_at IS NULL
          AND p.expires_at > ${now}
          AND i.id = p.invite_id
          AND i.workspace_id = ${this.db.workspaceId}
          AND i.revoked_at IS NULL
          AND m.workspace_id = i.workspace_id
          AND m.actor_id = i.actor_id
        RETURNING p.id, p.invite_id, p.created_at, p.expires_at, p.consumed_at, p.revoked_at
      `;
      if (!consumed[0]) return null;
      const minted = await this.mintInstallationWithin(sql, consumed[0].invite_id);
      if (!minted) throw new Error("active pairing lost its agent invite");
      return minted;
    });
  }
```

`mintInstallation` above calls `this.findInvite(sql, inviteId)` inside its own transaction, but `exchangePairing` needs to mint *within the same transaction* it already opened (to keep the "consume code" and "mint installation" atomic, exactly as today). Rather than nesting transactions, factor the shared minting body into a private helper both public methods call, given a `Sql` handle:

Replace the two methods above with this final version instead (supersedes the previous code block — use this one):

```ts
  async mintInstallation(inviteId: string): Promise<{
    invite: AgentInvite;
    installation: AgentInstallation;
    installationToken: string;
  } | null> {
    return this.db.transaction((sql) => this.mintInstallationWithin(sql, inviteId));
  }

  async exchangePairing(pairingCode: string): Promise<{
    invite: AgentInvite;
    installation: AgentInstallation;
    installationToken: string;
  } | null> {
    return this.db.transaction(async (sql) => {
      const now = Date.now();
      const consumed = await sql<PairingRow[]>`
        UPDATE agent_pairings p
        SET consumed_at = ${now}
        FROM agent_invites i, workspace_members m
        WHERE p.token_hash = ${hashToken(pairingCode)}
          AND p.consumed_at IS NULL
          AND p.revoked_at IS NULL
          AND p.expires_at > ${now}
          AND i.id = p.invite_id
          AND i.workspace_id = ${this.db.workspaceId}
          AND i.revoked_at IS NULL
          AND m.workspace_id = i.workspace_id
          AND m.actor_id = i.actor_id
        RETURNING p.id, p.invite_id, p.created_at, p.expires_at, p.consumed_at, p.revoked_at
      `;
      if (!consumed[0]) return null;
      const minted = await this.mintInstallationWithin(sql, consumed[0].invite_id);
      if (!minted) throw new Error("active pairing lost its agent invite");
      return minted;
    });
  }

  private async mintInstallationWithin(sql: Sql, inviteId: string): Promise<{
    invite: AgentInvite;
    installation: AgentInstallation;
    installationToken: string;
  } | null> {
    const invite = await this.findInvite(sql, inviteId);
    if (!invite) return null;
    const installationToken = randomBytes(TOKEN_BYTES).toString("hex");
    const now = Date.now();
    const installationRows = await sql<InstallationRow[]>`
      INSERT INTO agent_installations (id, invite_id, token_hash, created_at, last_used_at)
      VALUES (${randomUUID()}, ${inviteId}, ${hashToken(installationToken)}, ${now}, NULL)
      RETURNING id, invite_id, created_at, last_used_at
    `;
    return { invite, installation: toInstallation(installationRows[0]), installationToken };
  }
```

Add `listOpenAiWithKeys` near `list()` (after the existing `list()` method, around what was line 338):

```ts
  /** Internal only — never exposes ciphertext through the public AgentInvite
   *  shape. Used by ApiKeyAgentSupervisor to restart hosted agents on boot. */
  async listOpenAiWithKeys(): Promise<{ invite: AgentInvite; apiKeyCiphertext: string }[]> {
    const rows = await this.db.sql<InviteRow[]>`
      SELECT i.*, a.display_name AS name
      FROM agent_invites i
      JOIN actors a ON a.id = i.actor_id
      JOIN workspace_members m ON m.actor_id = i.actor_id AND m.workspace_id = i.workspace_id
      WHERE i.workspace_id = ${this.db.workspaceId}
        AND i.revoked_at IS NULL
        AND i.provider = 'openai'
        AND i.api_key_ciphertext IS NOT NULL
      ORDER BY i.created_at DESC
    `;
    return rows.map((row) => ({ invite: toInvite(row), apiKeyCiphertext: row.api_key_ciphertext! }));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && npx tsx --test test/agents.test.ts`
Expected: PASS (all tests, including the 3 pre-existing pairing tests that exercise `exchangePairing` — confirms the refactor kept behavior identical).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/auth/AgentInvites.ts packages/server/test/agents.test.ts
git commit -m "AgentInvites: mint installations directly, store an optional API key ciphertext"
```

---

### Task 4: `OpenAIBrain.setModel` — live model switching at the brain level

**Files:**
- Modify: `packages/agent/src/openaiBrain.ts`
- Modify: `packages/agent/src/brain.ts`
- Test: `packages/agent/test/openaiBrain.test.ts` (extend)

**Interfaces:**
- Produces: `OpenAIBrain.setModel(model: string): void`; `Brain.setModel?(model: string): void` (optional on the interface — `GeminiBrain`/`ClaudeBrain` don't implement it).

- [ ] **Step 1: Write the failing test**

Add to `packages/agent/test/openaiBrain.test.ts`, inside `describe("OpenAIBrain", ...)`:

```ts
  test("setModel changes the model used in the next request", async () => {
    const { brain, requests } = stubbedBrain(() => stream([{ choices: [{ delta: { content: "ok" }, index: 0, finish_reason: null }] }]));
    await brain.run({ system: "sys", context: "ctx", prompt: "hi" }, noopCallbacks);
    brain.setModel("gpt-5-mini");
    await brain.run({ system: "sys", context: "ctx", prompt: "hi again" }, noopCallbacks);

    assert.equal((requests[0] as unknown as { model: string }).model, "fake-model");
    assert.equal((requests[1] as unknown as { model: string }).model, "gpt-5-mini");
  });
```

This requires `create`'s request object to include `model` — check `RecordedRequest`'s type at the top of the test file; the `create` stub already records the full request object (`requests.push(request)`), so `request.model` is present at runtime even though `RecordedRequest`'s declared interface only lists `messages`. Widen `RecordedRequest` in the test file to include `model`:

```ts
interface RecordedRequest {
  model: string;
  messages: ChatCompletionMessageParam[];
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && npx tsx --test test/openaiBrain.test.ts`
Expected: FAIL — `brain.setModel is not a function`

- [ ] **Step 3: Implement `setModel`**

In `packages/agent/src/openaiBrain.ts`, add after the constructor (after line 30, the closing `}` of the constructor):

```ts

  setModel(model: string): void {
    this.model = model;
  }
```

In `packages/agent/src/brain.ts`, add to the `Brain` interface (replace lines 55-57):

```ts
/** A concrete LLM backend the agent can run a batch of work through. */
export interface Brain {
  run(input: BrainInput, callbacks: BrainCallbacks, options?: BrainRunOptions): Promise<BrainResult>;
  /** Only implemented by brains whose model can change without reconnecting
   *  (currently OpenAI). Absent on brains where model is fixed at construction. */
  setModel?(model: string): void;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/agent && npx tsx --test test/openaiBrain.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/openaiBrain.ts packages/agent/src/brain.ts packages/agent/test/openaiBrain.test.ts
git commit -m "OpenAIBrain: support switching model without reconnecting"
```

---

### Task 5: `runtime.ts` — per-agent API key, real model choices, live switching

**Files:**
- Modify: `packages/agent/src/runtime.ts`
- Test: `packages/agent/test/runtime.test.ts` (extend)

**Interfaces:**
- Consumes: `Brain.setModel?` from Task 4.
- Produces: `InstallationConfiguration.apiKey?: string`; `OPENAI_MODEL_CHOICES: readonly string[]` (exported for Task 7's tests to reference, and so the list has one home); `resolveOpenAiModel(requestedModel: string | null): string` (exported, pure — the one bit of actual branching logic in this change).

- [ ] **Step 1: Write the failing test**

Add to `packages/agent/test/runtime.test.ts`:

```ts
import { resolveOpenAiModel, OPENAI_MODEL_CHOICES } from "../src/runtime";

describe("OpenAI model resolution", () => {
  test("falls back to the default when no model was requested", () => {
    assert.equal(resolveOpenAiModel(null), OPENAI_MODEL_CHOICES[0]);
  });

  test("uses the requested model when set", () => {
    assert.equal(resolveOpenAiModel("gpt-5-nano"), "gpt-5-nano");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && npx tsx --test test/runtime.test.ts`
Expected: FAIL — `resolveOpenAiModel is not exported`

- [ ] **Step 3: Implement the changes in `runtime.ts`**

Add near the top, after the `PLATFORM_POLICY` constant (after line 30):

```ts
export const OPENAI_MODEL_CHOICES = ["gpt-5", "gpt-5-mini", "gpt-5-nano"] as const;

export function resolveOpenAiModel(requestedModel: string | null): string {
  return requestedModel ?? OPENAI_MODEL_CHOICES[0];
}
```

Change `InstallationConfiguration` (line 47):

```ts
type InstallationConfiguration = { mode: "installation"; installation: StoredInstallation; apiKey?: string; ownProcess?: boolean };
```

Change the OpenAI branch of `localConfiguration()` (lines 244-266) — replace the whole `if (item.agent.provider === "openai") { ... }` block:

```ts
    if (item.agent.provider === "openai") {
      const apiKey = configuration.apiKey ?? process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("An OpenAI API key is required for this agent.");
      const model = resolveOpenAiModel(item.agent.requestedModel);
      return {
        name: item.agent.name,
        wsUrl: item.wsUrl,
        token: item.installationToken,
        dataDir,
        brain: new OpenAIBrain(apiKey, model) as Brain,
        acp: null,
        systemPrompt: PLATFORM_POLICY,
        harness: { id: "openai", version: "0.1.0" },
        options: [{
          id: "model",
          label: "Model",
          category: "model",
          kind: "select",
          value: model,
          choices: OPENAI_MODEL_CHOICES.map((choice) => ({ value: choice, label: choice })),
        }] as RunnerConfigOption[],
        effectiveModel: model as string | undefined,
      };
    }
```

Now wire live switching. In the `profileUpdates` queue callback (the non-ACP `else` branch, lines 118-121), the current code is:

```ts
      } else {
        runner.updateSystemPrompt(composePrompt(local.systemPrompt, profile.instructions));
        reportLegacyReady(socket, revision, local.harness, local.options, local.effectiveModel);
      }
```

Replace it with:

```ts
      } else {
        runner.updateSystemPrompt(composePrompt(local.systemPrompt, profile.instructions));
        if (configuration.mode === "installation" && configuration.installation.agent.provider === "openai") {
          currentModel = resolveOpenAiModel(profile.requestedModel);
          local.brain.setModel?.(currentModel);
        }
        reportLegacyReady(socket, revision, local.harness, local.options, currentModel);
      }
```

This needs a mutable `currentModel` tracked outside `local` (since `local.effectiveModel` is fixed at startup and `reportLegacyReady` needs the live value). Add it right after `const local = await localConfiguration(configuration);` (line 52):

```ts
  const local = await localConfiguration(configuration);
  let currentModel = local.effectiveModel;
```

And update the two other `reportLegacyReady` call sites in this file (line 120, already changed above, and line 160 inside the `welcome` handler) to use `currentModel` instead of `local.effectiveModel`:

```ts
        } else {
          reportLegacyReady(socket, event.agentConfig?.configRevision ?? 1, local.harness, local.options, currentModel);
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/agent && npx tsx --test test/runtime.test.ts`
Expected: PASS (existing tests plus the 2 new ones)

- [ ] **Step 5: Full package test run to catch any missed call site**

Run: `cd packages/agent && npm test`
Expected: PASS. If `tsc`/`tsx` complains about `local.effectiveModel` being unused or a type mismatch, re-check every `reportLegacyReady(...)` call in `runtime.ts` was updated to pass `currentModel`.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/runtime.ts packages/agent/test/runtime.test.ts
git commit -m "runtime: per-agent OpenAI API key, real model choices, live model switching"
```

---

### Task 6: Make `packages/agent` importable as a library

**Files:**
- Modify: `packages/agent/package.json`
- Modify: `packages/server/package.json`

**Interfaces:**
- Produces: `@workspace/agent/runtime` resolvable from `packages/server` (used by Task 7).

- [ ] **Step 1: Add the exports field and move `openai` to dependencies**

In `packages/agent/package.json`, add an `"exports"` field (after `"bin"`, before `"scripts"`):

```json
  "exports": {
    "./runtime": "./src/runtime.ts"
  },
```

Move `"openai": "^7.5.0"` from `devDependencies` to `dependencies`. The full `dependencies`/`devDependencies` split becomes:

```json
  "dependencies": {
    "@agentclientprotocol/claude-agent-acp": "0.64.2",
    "openai": "^7.5.0"
  },
  "devDependencies": {
    "@agentclientprotocol/sdk": "1.3.0",
    "@anthropic-ai/claude-agent-sdk": "^0.3.226",
    "@google/genai": "^0.10.0",
    "@modelcontextprotocol/sdk": "1.29.0",
    "@types/node": "^22.10.5",
    "@types/ws": "^8.5.13",
    "@workspace/shared": "*",
    "dotenv": "^17.4.2",
    "tsx": "^4.23.5",
    "ws": "^8.18.0",
    "zod": "^4.4.3"
  }
```

- [ ] **Step 2: Add the workspace dependency to `packages/server`**

In `packages/server/package.json`, add to `dependencies` (alongside the existing `"@workspace/shared": "*"`):

```json
    "@workspace/agent": "*",
```

- [ ] **Step 3: Install and verify resolution**

Run: `npm install` (repo root)
Then: `cd packages/server && npx tsx -e "import('@workspace/agent/runtime').then((m) => console.log(typeof m.runAgent))"`
Expected: prints `function`

- [ ] **Step 4: Commit**

```bash
git add packages/agent/package.json packages/server/package.json package-lock.json
git commit -m "Make packages/agent importable as a library from packages/server"
```

---

### Task 7: `ApiKeyAgentSupervisor`

**Files:**
- Create: `packages/server/src/agents/ApiKeyAgentSupervisor.ts`
- Test: `packages/server/test/apiKeyAgentSupervisor.test.ts`

**Interfaces:**
- Consumes: `AgentInvites.mintInstallation`, `AgentInvites.listOpenAiWithKeys` (Task 3); `secretBox.decrypt` (Task 2); `runAgent` from `@workspace/agent/runtime` (Task 6, injectable for tests exactly like `HostedSupervisor`'s `runAgent` option).
- Produces: `class ApiKeyAgentSupervisor { start(invite: AgentInvite, apiKey: string): Promise<void>; stop(actorId: string): void; syncAll(): Promise<void>; closeAll(): void }` — used by Task 8's `WorkspaceRuntime`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/server/test/apiKeyAgentSupervisor.test.ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentInvite } from "@workspace/shared";
import { ApiKeyAgentSupervisor } from "../src/agents/ApiKeyAgentSupervisor";

function invite(overrides: Partial<AgentInvite> = {}): AgentInvite {
  return {
    id: "invite-1",
    workspaceId: "workspace-1",
    actorId: "actor-1",
    name: "openai-agent",
    provider: "openai",
    instructions: "",
    requestedModel: null,
    access: { mode: "workspace", selectedActorIds: [] },
    configRevision: 1,
    createdBy: "human-1",
    createdAt: 1,
    updatedAt: 1,
    revokedAt: null,
    ...overrides,
  };
}

function fakeAgentInvites(overrides: Partial<{
  mintInstallation: (id: string) => Promise<any>;
  listOpenAiWithKeys: () => Promise<any[]>;
}> = {}) {
  return {
    mintInstallation: overrides.mintInstallation ?? (async (id: string) => ({
      invite: invite({ id }),
      installation: { id: "installation-1", agentId: id, createdAt: 1, lastUsedAt: null },
      installationToken: "installation-token",
    })),
    listOpenAiWithKeys: overrides.listOpenAiWithKeys ?? (async () => []),
  } as any;
}

describe("ApiKeyAgentSupervisor", () => {
  test("start() mints an installation and calls runAgent in installation mode", async () => {
    const calls: any[] = [];
    const supervisor = new ApiKeyAgentSupervisor(
      fakeAgentInvites(),
      { id: "workspace-1", name: "Test" },
      3001,
      async (config) => { calls.push(config); return { close() {} }; },
    );
    await supervisor.start(invite(), "sk-test");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mode, "installation");
    assert.equal(calls[0].apiKey, "sk-test");
    assert.equal(calls[0].ownProcess, false);
    assert.equal(calls[0].installation.installationToken, "installation-token");
    assert.equal(calls[0].installation.wsUrl, "ws://127.0.0.1:3001/ws/workspace-1");
    assert.equal(calls[0].installation.apiUrl, "http://127.0.0.1:3001");
  });

  test("start() no-ops if the invite was revoked before minting completed", async () => {
    const calls: any[] = [];
    const supervisor = new ApiKeyAgentSupervisor(
      fakeAgentInvites({ mintInstallation: async () => null }),
      { id: "workspace-1", name: "Test" },
      3001,
      async (config) => { calls.push(config); return { close() {} }; },
    );
    await supervisor.start(invite(), "sk-test");
    assert.equal(calls.length, 0);
  });

  test("stop() closes the connection and start() can be called again for the same actor", async () => {
    const closed: string[] = [];
    let opened = 0;
    const supervisor = new ApiKeyAgentSupervisor(
      fakeAgentInvites(),
      { id: "workspace-1", name: "Test" },
      3001,
      async () => { opened += 1; return { close: () => closed.push("closed") }; },
    );
    await supervisor.start(invite({ actorId: "actor-1" }), "sk-test");
    supervisor.stop("actor-1");
    assert.deepEqual(closed, ["closed"]);
    await supervisor.start(invite({ actorId: "actor-1" }), "sk-test");
    assert.equal(opened, 2);
  });

  test("stop() on an unknown actor is a no-op", () => {
    const supervisor = new ApiKeyAgentSupervisor(
      fakeAgentInvites(),
      { id: "workspace-1", name: "Test" },
      3001,
      async () => ({ close() {} }),
    );
    supervisor.stop("never-started");
  });

  test("syncAll() starts every stored openai invite, decrypting each key", async () => {
    const decrypted: string[] = [];
    const calls: any[] = [];
    const supervisor = new ApiKeyAgentSupervisor(
      fakeAgentInvites({
        listOpenAiWithKeys: async () => [
          { invite: invite({ id: "a", actorId: "actor-a" }), apiKeyCiphertext: "cipher-a" },
          { invite: invite({ id: "b", actorId: "actor-b" }), apiKeyCiphertext: "cipher-b" },
        ],
      }),
      { id: "workspace-1", name: "Test" },
      3001,
      async (config) => { calls.push(config); return { close() {} }; },
      (ciphertext) => { decrypted.push(ciphertext); return `plain-${ciphertext}`; },
    );
    await supervisor.syncAll();
    assert.equal(calls.length, 2);
    assert.deepEqual(decrypted, ["cipher-a", "cipher-b"]);
    assert.equal(calls[0].apiKey, "plain-cipher-a");
  });

  test("closeAll() closes every running connection", async () => {
    const closed: string[] = [];
    const supervisor = new ApiKeyAgentSupervisor(
      fakeAgentInvites({
        listOpenAiWithKeys: async () => [
          { invite: invite({ id: "a", actorId: "actor-a" }), apiKeyCiphertext: "cipher-a" },
          { invite: invite({ id: "b", actorId: "actor-b" }), apiKeyCiphertext: "cipher-b" },
        ],
      }),
      { id: "workspace-1", name: "Test" },
      3001,
      async () => ({ close: () => closed.push("x") }),
      () => "plain",
    );
    await supervisor.syncAll();
    supervisor.closeAll();
    assert.deepEqual(closed, ["x", "x"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && npx tsx --test test/apiKeyAgentSupervisor.test.ts`
Expected: FAIL — `Cannot find module '../src/agents/ApiKeyAgentSupervisor'`

- [ ] **Step 3: Implement `ApiKeyAgentSupervisor.ts`**

```ts
// packages/server/src/agents/ApiKeyAgentSupervisor.ts
import type { AgentInvite } from "@workspace/shared";
import type { runAgent as runAgentType } from "@workspace/agent/runtime";
import { decrypt } from "../crypto/secretBox";
import type { AgentInvites } from "../auth/AgentInvites";

type RunAgent = typeof runAgentType;

/**
 * Runs OpenAI hosted agents (invite has a stored API key) in-process,
 * connecting over the same AgentSocket -> Hub websocket path a CLI-paired
 * agent uses. One instance per workspace, held by WorkspaceRuntime.
 *
 * Minting an installation here skips the pairing-code step entirely — that
 * ceremony exists only so a human can type/paste a short-lived code into a
 * terminal, which doesn't apply when the server is granting itself an
 * installation for a key it already has.
 */
export class ApiKeyAgentSupervisor {
  private connections = new Map<string, { close(): void }>();

  constructor(
    private agentInvites: Pick<AgentInvites, "mintInstallation" | "listOpenAiWithKeys">,
    private workspace: { id: string; name: string },
    private port: number,
    private runAgent: RunAgent,
    private decryptKey: (ciphertext: string) => string = decrypt,
  ) {}

  async start(invite: AgentInvite, apiKey: string): Promise<void> {
    const minted = await this.agentInvites.mintInstallation(invite.id);
    if (!minted) return; // invite was revoked between creation and start
    const apiUrl = `http://127.0.0.1:${this.port}`;
    const connection = await this.runAgent({
      mode: "installation",
      apiKey,
      ownProcess: false,
      installation: {
        installation: minted.installation,
        installationToken: minted.installationToken,
        agent: minted.invite,
        workspace: this.workspace,
        apiUrl,
        wsUrl: `ws://127.0.0.1:${this.port}/ws/${encodeURIComponent(this.workspace.id)}`,
        serverOrigin: apiUrl,
        workspacePath: apiUrl,
        pairedAt: Date.now(),
      },
    });
    this.connections.get(invite.actorId)?.close();
    this.connections.set(invite.actorId, connection);
  }

  stop(actorId: string): void {
    this.connections.get(actorId)?.close();
    this.connections.delete(actorId);
  }

  async syncAll(): Promise<void> {
    const stored = await this.agentInvites.listOpenAiWithKeys();
    for (const { invite, apiKeyCiphertext } of stored) {
      try {
        await this.start(invite, this.decryptKey(apiKeyCiphertext));
      } catch (error) {
        console.warn(`[hosted-agent] could not start ${invite.id}:`, error instanceof Error ? error.message : error);
      }
    }
  }

  closeAll(): void {
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
  }
}
```

Note: `StoredInstallation` (the type `installation` must match) has fields beyond what `mintInstallation` returns — `workspacePath`, `serverOrigin`, `pairedAt` are CLI-only concerns (where on disk the pairing was saved, what directory it's for). They're populated above with harmless placeholder values (`apiUrl` for `serverOrigin`, since this connection has no real filesystem workspace path) — `runtime.ts`'s `localConfiguration` for the `"openai"` provider branch never reads `workspacePath` or `serverOrigin` (only the ACP/claude branch does, for `AcpBrain`), so these values are inert for this path. Confirm this by re-reading `runtime.ts`'s installation-mode `localConfiguration` openai branch (Task 5) before writing this file — it only destructures `item.wsUrl`, `item.installationToken`, `item.agent`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && npx tsx --test test/apiKeyAgentSupervisor.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/agents/ApiKeyAgentSupervisor.ts packages/server/test/apiKeyAgentSupervisor.test.ts
git commit -m "Add ApiKeyAgentSupervisor: runs hosted OpenAI agents in-process"
```

---

### Task 8: Wire the supervisor into `WorkspaceRuntime`

**Files:**
- Modify: `packages/server/src/WorkspaceRuntime.ts`

**Interfaces:**
- Consumes: `ApiKeyAgentSupervisor` (Task 7), `runAgent` from `@workspace/agent/runtime` (Task 6).
- Produces: `WorkspaceRuntime.startApiKeyAgent(invite: AgentInvite, apiKey: string): Promise<void>`; `WorkspaceRuntime.stopApiKeyAgent(actorId: string): void`. `WorkspaceRuntimeOptions` gains `port: number`.

- [ ] **Step 1: Add `port` to `WorkspaceRuntimeOptions` and construct the supervisor**

In `packages/server/src/WorkspaceRuntime.ts`, add the import:

```ts
import { runAgent } from "@workspace/agent/runtime";
import { ApiKeyAgentSupervisor } from "./agents/ApiKeyAgentSupervisor";
```

Add `port: number;` to `WorkspaceRuntimeOptions` (after `dataDir: string;`, line 45).

Add a field to the class (after `readonly hub!: Hub;`, line 76):

```ts
  readonly apiKeyAgents!: ApiKeyAgentSupervisor;
```

In `create()`, after `const agentInvites = new AgentInvites(db);` (line 91), construct the supervisor:

```ts
    const apiKeyAgents = new ApiKeyAgentSupervisor(
      agentInvites,
      { id: db.workspaceId, name: db.workspaceName },
      options.port,
      runAgent,
    );
```

Add `apiKeyAgents,` to the `Object.assign(runtime, { ... })` call (alongside `hub,` at line 188).

At the end of `create()`, before `return runtime;` (line 221), start any agents that were already stored (server restart case):

```ts
    void apiKeyAgents.syncAll();
```

(`void` + fire-and-forget is intentional and safe here — `AgentSocket.connect()` inside `runAgent()` is itself async/non-blocking and retries with backoff if the HTTP server isn't listening yet, exactly like every other agent connection at boot. See `packages/agent/src/socket.ts`'s `open()`/`error` handler comment: "the first attempts lose the race by design.")

- [ ] **Step 2: Add `startApiKeyAgent`/`stopApiKeyAgent` methods**

After `updateAgent()` (line 224-226):

```ts
  async startApiKeyAgent(invite: AgentInvite, apiKey: string): Promise<void> {
    await this.apiKeyAgents.start(invite, apiKey);
  }

  stopApiKeyAgent(actorId: string): void {
    this.apiKeyAgents.stop(actorId);
  }
```

- [ ] **Step 3: Stop hosted agents on workspace close**

Change `close()` (lines 228-230):

```ts
  async close(): Promise<void> {
    this.apiKeyAgents.closeAll();
    await Promise.all([this.hub.close(), this.toolmanGateway.close()]);
  }
```

- [ ] **Step 4: Typecheck**

Run: `cd packages/server && npx tsc --noEmit`
Expected: no new errors. (This surfaces any missed call site passing `WorkspaceRuntimeOptions` without `port` — Task 9 fixes the one real caller, `WorkspaceRegistry`.)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/WorkspaceRuntime.ts
git commit -m "WorkspaceRuntime: wire up ApiKeyAgentSupervisor lifecycle"
```

---

### Task 9: Thread `port` through `WorkspaceRegistry`

**Files:**
- Modify: `packages/server/src/WorkspaceRegistry.ts`

**Interfaces:**
- Consumes: `WorkspaceRuntimeOptions.port` (Task 8).

- [ ] **Step 1: Add a `port` constructor param and pass it through**

Add `private port: number,` to the constructor param list (after `private dataDir: string,`, line 22).

In `get()`, add `port: this.port,` to the `WorkspaceRuntime.create({...})` call (alongside `dataDir: this.dataDir,`, line 40).

- [ ] **Step 2: Typecheck**

Run: `cd packages/server && npx tsc --noEmit`
Expected: a new error at the `new WorkspaceRegistry(...)` call site in `index.ts` — missing argument. This is expected; Task 11 fixes it.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/WorkspaceRegistry.ts
git commit -m "WorkspaceRegistry: thread the listen port through to WorkspaceRuntime"
```

---

### Task 10: `board/api.ts` — accept, validate, and store the pasted key

**Files:**
- Modify: `packages/server/src/board/api.ts`

**Interfaces:**
- Consumes: `AgentInvites.create` (Task 3, new `apiKeyCiphertext` param), `secretBox.encrypt` (Task 2), `WorkspaceRuntime.startApiKeyAgent`/`stopApiKeyAgent` (Task 8).
- Produces: `ApiServices.onCreateAgent?: ((invite: AgentInvite, apiKey: string) => void) | null`; `ApiServices.validateOpenAiKey?: (apiKey: string) => Promise<boolean>` (defaults to a real `OpenAI(...).models.list()` check when not provided).

- [ ] **Step 1: Add the schema field**

Change `createAgentBodySchema` (line 128-134):

```ts
const createAgentBodySchema = z.object({
  name: z.string().min(1).max(32),
  provider: z.enum(["claude", "codex", "openai"] as const),
  instructions: z.string().max(20000).default(""),
  model: z.string().trim().min(1).max(200).nullable().default(null),
  access: agentAccessSchema.default({ mode: "workspace", selectedActorIds: [] }),
  apiKey: z.string().trim().min(1).max(500).optional(),
});
```

- [ ] **Step 2: Add the default validator and `ApiServices`/`RouteServices` fields**

Near the top of `api.ts`, add an import:

```ts
import OpenAI from "openai";
```

Add a module-level default validator function (near the other free functions at the bottom of the file, e.g. next to `workspaceSocketUrl`):

```ts
async function defaultValidateOpenAiKey(apiKey: string): Promise<boolean> {
  try {
    await new OpenAI({ apiKey }).models.list();
    return true;
  } catch {
    return false;
  }
}
```

In `ApiServices` (after `onRevokeAgent?: ...`, line 236):

```ts
  onCreateAgent?: ((invite: AgentInvite, apiKey: string) => void) | null;
  validateOpenAiKey?: (apiKey: string) => Promise<boolean>;
```

In `createApiHandler`'s destructuring (after `onRevokeAgent = null,`, line 272):

```ts
    onCreateAgent = null,
    validateOpenAiKey = defaultValidateOpenAiKey,
```

In `RouteServices` (after `onRevokeAgent: ...`, line 630):

```ts
  onCreateAgent: ((invite: AgentInvite, apiKey: string) => void) | null;
  validateOpenAiKey: (apiKey: string) => Promise<boolean>;
```

In the top-level (non-multi-tenant) `scoped` object literal (after `onRevokeAgent,`, line 585):

```ts
              onCreateAgent,
              validateOpenAiKey,
```

- [ ] **Step 3: Update the POST /api/agents handler**

Add a static import at the top of `api.ts`, alongside the other local imports (e.g. near the `ApiError`/`BoardService` imports):

```ts
import { encrypt } from "../crypto/secretBox";
```

Replace the handler body (lines 792-804):

```ts
  // POST /api/agents — create a new user-created agent invite (humans only).
  if (parts[1] === "agents" && parts.length === 2 && method === "POST") {
    if (!agentInvites) throw new ApiError(501, "NOT_IMPLEMENTED", "agent invites are not available");
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can add agents");
    const body = createAgentBodySchema.parse(await readBody(req));
    if (body.provider === "openai" && body.apiKey) {
      const valid = await validateOpenAiKey(body.apiKey);
      if (!valid) throw new ApiError(400, "INVALID_API_KEY", "this OpenAI API key was rejected");
      const { invite, token } = await agentInvites.create(
        body.name,
        body.provider,
        actor,
        { instructions: body.instructions, requestedModel: body.model, access: body.access },
        encrypt(body.apiKey),
      );
      onCreateAgent?.(invite, body.apiKey);
      return json(res, 201, { ...invite, token });
    }
    const { invite, token } = await agentInvites.create(body.name, body.provider, actor, {
      instructions: body.instructions,
      requestedModel: body.model,
      access: body.access,
    });
    const pairing = await agentInvites.createPairing(invite.id, actor);
    if (!pairing) throw new Error("new agent invite could not issue a pairing");
    return json(res, 201, { ...invite, token, ...pairing });
  }
```

- [ ] **Step 4: Update the DELETE /api/agents/:id handler**

Change (lines 834-842):

```ts
  if (parts[1] === "agents" && parts.length === 3 && method === "DELETE") {
    if (!agentInvites) throw new ApiError(501, "NOT_IMPLEMENTED", "agent invites are not available");
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can remove agents");
    const revoked = await agentInvites.revoke(parts[2]);
    if (!revoked) throw new ApiError(404, "NOT_FOUND", "no such agent invite");
    await db.removeMember(revoked.actorId);
    if (onRevokeAgent) onRevokeAgent(revoked.actorId);
    return json(res, 200, { ok: true });
  }
```

No change needed here — `onRevokeAgent` already fires with `actorId`; Task 11 makes the callback itself also stop the hosted agent. Leave this handler as-is.

- [ ] **Step 5: Wire `runtimeRouteServices` (multi-tenant path)**

Change `runtimeRouteServices` (lines 1598-1636) — add a `validateOpenAiKey` parameter and the two new fields:

```ts
function runtimeRouteServices(
  runtime: WorkspaceRuntime,
  accounts: AccountStore | null,
  workspaceAccess: WorkspaceAccess | null,
  github: GitHub | null,
  validateOpenAiKey: (apiKey: string) => Promise<boolean>,
): RouteServices {
  return {
    db: runtime.db,
    service: runtime.board,
    messages: runtime.messages,
    threadEvents: runtime.threadEvents,
    channels: runtime.channels,
    attachments: runtime.attachments,
    agentInvites: runtime.agentInvites,
    runnerRuntime: runtime.runnerRuntime,
    onUpdateAgent: (profile) => runtime.updateAgent(profile),
    onRevokeAgent: (actorId) => {
      runtime.hub.closeAgentConnection(actorId);
      runtime.stopApiKeyAgent(actorId);
    },
    onCreateAgent: (invite, apiKey) => void runtime.startApiKeyAgent(invite, apiKey),
    validateOpenAiKey,
    onRemoveMember: (actorId) => {
      runtime.hub.closeAgentConnection(actorId);
      runtime.hub.closeHumanConnection(actorId);
    },
    onAddMember: (actorId) => void runtime.hub.addOfflineMember(actorId),
    snapshot: runtime.snapshot,
    plans: runtime.plans,
    envelope: runtime.envelope,
    context: runtime.context,
    notes: runtime.notes,
    resourceAccess: runtime.resourceAccess,
    resourceManifest: runtime.resourceManifest,
    github,
    gitRepositories: runtime.gitRepositories,
    projects: runtime.projects,
    toolmanNodes: runtime.toolmanNodes,
    toolmanGateway: runtime.toolmanGateway,
    executions: runtime.executions,
    accounts,
    workspaceAccess,
  };
}
```

Update its one call site (find `runtimeRouteServices(authenticated.runtime,` — near line 574) to pass `validateOpenAiKey` as the 5th argument:

```ts
        const scoped = authenticated.runtime
          ? runtimeRouteServices(authenticated.runtime, accounts, workspaceAccess, github, validateOpenAiKey)
          : { ... };
```

- [ ] **Step 6: Typecheck**

Run: `cd packages/server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/board/api.ts
git commit -m "board/api: accept and validate a pasted OpenAI key on agent creation"
```

---

### Task 11: `index.ts` wiring

**Files:**
- Modify: `packages/server/src/index.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `WorkspaceRegistry`'s new `port` param (Task 9), `ApiServices.onCreateAgent` (Task 10), `WorkspaceRuntime.startApiKeyAgent`/`stopApiKeyAgent` (Task 8).

- [ ] **Step 1: Pass `config.port` to `WorkspaceRegistry`**

Change the `new WorkspaceRegistry(...)` call (lines 81-92) — add `config.port,` right after `config.dataDir,` (line 88), matching Task 9's constructor placement (`port` was added immediately after the `dataDir` param, before `defaultWorkspaceId`):

```ts
  const registry = new WorkspaceRegistry(
    db,
    sessions,
    auth,
    config.agentToken,
    supabase,
    github,
    config.dataDir,
    config.port,
    db.workspaceId,
    scripts,
    path.join(ASSETS_DIR, "demo/seed"),
  );
```

This must match Task 9's parameter order exactly — both are positional, so a mismatch here would silently pass the wrong value as the wrong param instead of failing to compile (both `dataDir`/`port`-adjacent params are different types — `string` vs `number` — so TypeScript will actually catch a swap here at compile time; still, verify the order side-by-side with `WorkspaceRegistry`'s constructor before moving on).

- [ ] **Step 2: Wire `onCreateAgent` in the single-workspace `createApiHandler` call**

Add to the `createApiHandler({...})` call (after `onRevokeAgent: (actorId) => runtime.hub.closeAgentConnection(actorId),`, line 108):

```ts
    onRevokeAgent: (actorId) => {
      runtime.hub.closeAgentConnection(actorId);
      runtime.stopApiKeyAgent(actorId);
    },
    onCreateAgent: (invite, apiKey) => void runtime.startApiKeyAgent(invite, apiKey),
```

(This replaces the single-line `onRevokeAgent` at line 108 with the two-statement version, and adds `onCreateAgent` as a new line.)

- [ ] **Step 3: Document `AGENT_SECRET_KEY` in `.env.example`**

Add near the other agent-related env vars in `.env.example` (after the `AGENT_TOKEN` block, or near the `--- Agent ---` section):

```
# Encryption key for API keys pasted into the "Use an API key" agent method
# (32 random bytes, base64). Generate with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# Optional — without it, users can still pair agents locally with
# convyio-agent; only the paste-a-key-in-the-UI path needs this.
# AGENT_SECRET_KEY=
```

- [ ] **Step 4: Typecheck and run the full server test suite**

Run: `cd packages/server && npx tsc --noEmit && npm test`
Expected: no type errors; full suite passes (this is the first point where every prior task's wiring is exercised together).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/index.ts .env.example
git commit -m "index.ts: wire ApiKeyAgentSupervisor into the single-workspace boot path"
```

---

### Task 12: Server test — creating an OpenAI agent with a pasted key

**Files:**
- Test: `packages/server/test/agents.test.ts` (extend)

**Interfaces:**
- Consumes: `createEnv`'s `onCreateAgent`/`validateOpenAiKey` overrides (this task adds them to the helper).

- [ ] **Step 1: Extend `createEnv` to accept the two new options**

In `packages/server/test/helpers.ts`, change `createEnv`'s options and pass-through:

```ts
export async function createEnv(options: {
  hostedAgentToken?: string | null;
  onCreateAgent?: (invite: AgentInvite, apiKey: string) => void;
  validateOpenAiKey?: (apiKey: string) => Promise<boolean>;
} = {}): Promise<Env> {
```

Add `import type { AgentInvite } from "@workspace/shared";` if not already imported at the top (check — `Actor` etc. are already imported from `@workspace/shared` at line 10; add `AgentInvite` to that same import list).

In the `createApiHandler({...})` call inside `createEnv` (around line 141-160), add:

```ts
    onCreateAgent: options.onCreateAgent ?? null,
    validateOpenAiKey: options.validateOpenAiKey,
```

- [ ] **Step 2: Write the failing test**

Add to `packages/server/test/agents.test.ts`:

```ts
describe("hosted OpenAI agents (paste a key, no local pairing)", async () => {
  test("a valid key creates the agent, stores it encrypted, and starts it — no pairing code returned", async () => {
    const started: Array<{ actorId: string; apiKey: string }> = [];
    const env = await createEnv({
      onCreateAgent: (invite, apiKey) => started.push({ actorId: invite.actorId, apiKey }),
      validateOpenAiKey: async () => true,
    });
    try {
      const human = await env.actor("human", "hosted-owner");
      const created = await env.api("POST", "/api/agents", human.token, {
        name: "hosted-agent",
        provider: "openai",
        apiKey: "sk-valid-key",
      });
      assert.equal(created.status, 201, created.body.message);
      assert.equal("pairingCode" in created.body, false);
      assert.equal(started.length, 1);
      assert.equal(started[0]!.actorId, created.body.actorId);
      assert.equal(started[0]!.apiKey, "sk-valid-key");

      const [row] = await env.db.sql<{ api_key_ciphertext: string | null }[]>`
        SELECT api_key_ciphertext FROM agent_invites WHERE id = ${created.body.id}
      `;
      assert.ok(row.api_key_ciphertext);
      assert.notEqual(row.api_key_ciphertext, "sk-valid-key");

      const list = await env.api("GET", "/api/agents", human.token);
      const serialized = JSON.stringify(list.body);
      assert.equal(serialized.includes("sk-valid-key"), false);
      assert.equal(serialized.includes(row.api_key_ciphertext!), false);
    } finally {
      await env.close();
    }
  });

  test("an invalid key is rejected and no agent is created", async () => {
    const started: unknown[] = [];
    const env = await createEnv({
      onCreateAgent: (invite, apiKey) => started.push({ invite, apiKey }),
      validateOpenAiKey: async () => false,
    });
    try {
      const human = await env.actor("human", "hosted-bad-key-owner");
      const created = await env.api("POST", "/api/agents", human.token, {
        name: "hosted-bad-key-agent",
        provider: "openai",
        apiKey: "sk-bad-key",
      });
      assert.equal(created.status, 400);
      assert.equal(created.body.error, "INVALID_API_KEY");
      assert.equal(started.length, 0);
      const list = await env.api("GET", "/api/agents", human.token);
      assert.equal(list.body.agents.length, 0);
    } finally {
      await env.close();
    }
  });

  test("an openai agent created without an apiKey falls back to the normal pairing flow", async () => {
    const started: unknown[] = [];
    const env = await createEnv({ onCreateAgent: (invite, apiKey) => started.push({ invite, apiKey }) });
    try {
      const human = await env.actor("human", "no-key-owner");
      const created = await env.api("POST", "/api/agents", human.token, {
        name: "no-key-agent",
        provider: "openai",
      });
      assert.equal(created.status, 201, created.body.message);
      assert.equal(typeof created.body.pairingCode, "string");
      assert.equal(started.length, 0);
    } finally {
      await env.close();
    }
  });
});
```

Note: this suite creates its own `env` per test (rather than sharing the outer `describe`'s single `env`, as the rest of the file does) because each test needs different `onCreateAgent`/`validateOpenAiKey` fakes — `createEnv()` bakes those in at construction. Place this `describe` block after the existing `describe("agent HTTP invites", ...)` block, at the same top level as `describe("global agent token", ...)`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/server && npx tsx --test test/agents.test.ts`
Expected: FAIL — `apiKey` unrecognized by schema (400 for the "valid key" test instead of 201), until Task 10 is done. If Task 10 is already done by this point (tasks executed in order), this instead fails because `createEnv` doesn't yet accept `onCreateAgent`/`validateOpenAiKey` (Step 1 not yet applied) — apply Step 1 first, then this step's failure should be a clean assertion failure, not a crash.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && npx tsx --test test/agents.test.ts`
Expected: PASS (all tests in the file, old and new)

- [ ] **Step 5: Full server suite**

Run: `cd packages/server && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/test/helpers.ts packages/server/test/agents.test.ts
git commit -m "Test: creating an OpenAI agent with a pasted key skips pairing and starts it"
```

---

### Task 13: `WorkspaceContext.tsx` — send the pasted key

**Files:**
- Modify: `packages/client/src/hooks/WorkspaceContext.tsx`

**Interfaces:**
- Produces: `createAgent` gains an optional `apiKey` field in its input, and its return type's `pairingCode` becomes `string | null`.

- [ ] **Step 1: Update the type declaration**

Change (lines 148-154):

```ts
  createAgent: (fields: {
    name: string;
    provider: AgentProvider;
    instructions?: string;
    model?: string | null;
    access?: AgentAccessPolicy;
    apiKey?: string;
  }) => Promise<{ id: string; pairingCode: string | null } | null>;
```

- [ ] **Step 2: Update the implementation**

Change `createAgent` (lines 576-610):

```ts
  const createAgent = async (fields: {
    name: string;
    provider: AgentProvider;
    instructions?: string;
    model?: string | null;
    access?: AgentAccessPolicy;
    apiKey?: string;
  }): Promise<{ id: string; pairingCode: string | null } | null> => {
    const request = api.fetch("/api/agents", {
      method: "POST",
      body: JSON.stringify(fields),
    });
    if (!request) return null;
    try {
      const res = await request;
      if (!res.ok) {
        pushToast(`Could not add the agent: ${await api.errorMessage(res)}`);
        return null;
      }
      // The response also carries `token` (the agent's own join secret) and,
      // for agents that pair locally, `pairing`; neither is surfaced to the
      // UI. `pairingCode` is absent entirely for hosted API-key agents —
      // there's nothing for a human to pair.
      const data = (await res.json()) as AgentInvite & { token: string; pairingCode?: string };
      setAgentInvites((prev) => [
        {
          ...data,
          runtime: { connected: false, health: "checking", configRevision: data.configRevision, options: [] },
        },
        ...prev,
      ]);
      return { id: data.id, pairingCode: data.pairingCode ?? null };
    } catch (err) {
      pushToast(`Could not add the agent: ${String(err)}`);
      return null;
    }
  };
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/client && npx tsc --noEmit`
Expected: errors at `AddAgentModal.tsx`'s use of `result.pairingCode` (now possibly `null`) — expected, fixed in Task 14.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/hooks/WorkspaceContext.tsx
git commit -m "WorkspaceContext: send an optional apiKey when creating an agent"
```

---

### Task 14: `AddAgentModal.tsx` — paste-a-key UI, drop the local-method instructions

**Files:**
- Modify: `packages/client/src/components/AddAgentModal.tsx`

**Interfaces:**
- Consumes: `createAgent`'s updated signature (Task 13).

- [ ] **Step 1: Reword `MethodStep`**

Change the "Use an API key" button's description (lines 396-399):

```tsx
        <div className="mt-0.5 text-xs text-muted">
          Paste an OpenAI API key and Convyio runs the agent for you — no installs, no terminal.
        </div>
```

- [ ] **Step 2: Add `apiKey` state to `AddAgentModal`**

Add state (after `const [instructions, setInstructions] = useState(DEFAULT_INSTRUCTIONS);`, line 120):

```ts
  const [apiKey, setApiKey] = useState("");
```

Reset it in the modal-open effect (in the `if (open) { ... }` block, after `setInstructions(DEFAULT_INSTRUCTIONS);`, line 133):

```ts
      setApiKey("");
```

- [ ] **Step 3: Update `submitCreate` — send the key, route apikey agents straight to `configure`**

Replace `submitCreate` (lines 166-185):

```ts
  const submitCreate = async () => {
    if (!nameValid || creating) return;
    if (method === "apikey" && apiKey.trim() === "") return;
    setCreating(true);
    setCreateError(null);
    const result = await createAgent({
      name: trimmedName,
      provider: method === "apikey" ? "openai" : "claude",
      instructions,
      model: null,
      access: { mode: "workspace", selectedActorIds: [] },
      ...(method === "apikey" ? { apiKey: apiKey.trim() } : {}),
    });
    setCreating(false);
    if (!result) {
      setCreateError("Could not create the agent. The name may be taken, invalid, or the key was rejected.");
      return;
    }
    setActiveAgentId(result.id);
    if (method === "apikey") {
      // The server already minted itself an installation and started the
      // agent — there's nothing for a human to pair.
      setStep("configure");
      return;
    }
    setPairingCode(result.pairingCode);
    setStep("pair");
  };
```

- [ ] **Step 4: Update `CreateStep` — API key input instead of env-var instructions**

Change the function signature to accept `apiKey`/`onApiKeyChange` (add to the props type and destructuring, lines 405-427):

```tsx
function CreateStep({
  method,
  onBack,
  name,
  onNameChange,
  nameValid,
  instructions,
  onInstructionsChange,
  apiKey,
  onApiKeyChange,
  creating,
  error,
  onSubmit,
}: {
  method: Method;
  onBack: () => void;
  name: string;
  onNameChange: (value: string) => void;
  nameValid: boolean;
  instructions: string;
  onInstructionsChange: (value: string) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  creating: boolean;
  error: string | null;
  onSubmit: () => void;
}) {
```

Replace the apikey-method `<p>` (lines 451-461, the `) : (` branch) with an input field:

```tsx
        ) : (
          <>
            <div className="flex gap-2">
              <HarnessOption label="OpenAI" selected />
            </div>
            <div className="mt-2">
              <label
                htmlFor="agent-api-key"
                className="mb-1 block text-[10px] font-bold tracking-wider text-muted uppercase"
              >
                API key
              </label>
              <input
                id="agent-api-key"
                type="password"
                value={apiKey}
                onChange={(e) => onApiKeyChange(e.target.value)}
                placeholder="sk-…"
                autoComplete="off"
                className="w-full rounded-md border border-divider bg-input px-3 py-2.5 text-body outline-none focus:ring-2 focus:ring-accent"
              />
              <p className="mt-1 text-xs text-faint">
                Get a key at{" "}
                <a
                  href="https://platform.openai.com/api-keys"
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent hover:underline"
                >
                  platform.openai.com/api-keys
                </a>
                . Convyio stores it encrypted and runs the agent for you.
              </p>
            </div>
          </>
        )}
```

Update the submit button's `disabled` condition (line 495) to also require a key for the apikey method:

```tsx
        disabled={!nameValid || creating || (method === "apikey" && apiKey.trim() === "")}
```

- [ ] **Step 5: Pass the new props from `AddAgentModal`'s `CreateStep` usage**

Update the `<CreateStep ... />` call (lines 244-260):

```tsx
          {step === "create" && (
            <CreateStep
              method={method}
              onBack={() => setStep("method")}
              name={name}
              onNameChange={(value) => {
                setName(value);
                setCreateError(null);
              }}
              nameValid={nameValid}
              instructions={instructions}
              onInstructionsChange={setInstructions}
              apiKey={apiKey}
              onApiKeyChange={(value) => {
                setApiKey(value);
                setCreateError(null);
              }}
              creating={creating}
              error={createError}
              onSubmit={() => void submitCreate()}
            />
          )}
```

- [ ] **Step 6: Simplify `PairStep` — drop the apikey branches (unreachable now)**

`PairStep` is only ever reached for `method === "existing"` agents now (Step 3 routes apikey creations straight to `configure`), and Step 7 below removes the only other way to reach it for an openai agent (the "Re-pair" button). Replace the whole `PairStep` function (lines 504-613) with the pre-existing-agent-only version:

```tsx
function PairStep({
  agent,
  pairingCode,
  apiUrl,
  onContinue,
}: {
  agent: AgentSummary;
  pairingCode: string | null;
  apiUrl: string;
  onContinue: () => void;
}) {
  const cliCommand = pairingCode ? pairCommand(apiUrl, pairingCode) : "";
  const prompt = pairingCode ? setupPrompt(apiUrl, pairingCode, agent.name) : "";

  const diagnostic = diagnosticMessage(agent.runtime.diagnosticCode);
  let statusText: string;
  let statusClass: string;
  if (!agent.runtime.connected) {
    statusText = "Waiting for the agent to connect…";
    statusClass = "border-away text-muted";
  } else if (agent.runtime.health === "dormant") {
    // Pairing succeeded; the harness just has not been woken yet. Showing this
    // as a fault would make a correct first-run look broken.
    statusText = "Paired and connected — asleep until you activate it.";
    statusClass = "border-away text-muted";
  } else if (agent.runtime.health === "checking") {
    statusText = "Connected — running preflight checks…";
    statusClass = "border-away text-muted";
  } else if (agent.runtime.health === "ready") {
    statusText = "Connected and ready.";
    statusClass = "border-online text-online";
  } else {
    statusText = `${runtimeHealthLabel(agent.runtime)}${diagnostic ? ` — ${diagnostic}` : ""}`;
    statusClass = "border-dead text-dead";
  }

  return (
    <>
      <p className="mb-4 text-sm text-muted">
        Paste this into Claude Code, Cursor, Codex, or any coding agent on this computer.
        It pairs <span className="text-body">{agent.name}</span> locally. Your subscription stays
        on this machine — Convyio never sees that login. Folders are attached later with Toolman.
      </p>

      {pairingCode && (
        <div className="mb-4 space-y-3">
          <SetupPromptCard value={prompt} />
          <div>
            <p className="mb-2 text-[10px] font-bold tracking-wider text-muted uppercase">
              Or run it yourself
            </p>
            <div className="space-y-2">
              <PairingCopyRow label="CLI" value={cliCommand} />
              <PairingCopyRow label="Pairing code" value={pairingCode} />
            </div>
          </div>
        </div>
      )}

      <div className={`mb-4 rounded-md border-l-4 bg-subtle px-3 py-2 text-sm ${statusClass}`}>
        {statusText}
      </div>

      {/* Any connected runner may continue, not just a healthy one: the
          configure step is where an auth_required or degraded runner gets
          fixed, and it is useless before the runner has reported its options. */}
      <button
        onClick={onContinue}
        disabled={!agent.runtime.connected}
        className="w-full rounded-md bg-accent py-2.5 font-medium text-on-accent transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        Continue
      </button>
    </>
  );
}
```

- [ ] **Step 7: Hide "Re-pair" for hosted OpenAI agents in `ConfigureStep`**

In `ConfigureStep`'s header actions (lines 736-751), gate the "Re-pair" button on provider:

```tsx
        <div className="flex shrink-0 items-center gap-3">
          {canActivate && agent.runtime.connected && (
            <button
              onClick={() => onSetActive(asleep)}
              className="cursor-pointer rounded-md border border-subtle px-2.5 py-1 text-xs font-medium text-body hover:bg-subtle"
            >
              {asleep ? "Activate" : "Put to sleep"}
            </button>
          )}
          {agent.provider !== "openai" && (
            <button
              onClick={onRepair}
              className="cursor-pointer text-xs font-medium text-accent hover:underline"
            >
              Re-pair
            </button>
          )}
        </div>
```

- [ ] **Step 8: Typecheck**

Run: `cd packages/client && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Manual verification in the browser**

Run: `npm run dev` (repo root, or whatever the project's existing dev-server script is — check `package.json`/`AGENTS.md` for the exact command already documented for this repo).
In the browser: open the workspace, click "Add an agent" → "Use an API key" → confirm the description no longer mentions an environment variable, confirm there's a password-style API key field (not shell-export instructions), submit with a name and a (test/fake) key, and confirm the modal goes straight to the configure step (not a pairing-code screen). Confirm the "Model" dropdown shows `gpt-5` / `gpt-5-mini` / `gpt-5-nano` once the agent reports ready. Confirm an "existing agent" (Claude) creation still shows the pairing prompt/CLI command exactly as before. Confirm the "Re-pair" button is absent for the OpenAI agent's configure view but still present for the Claude one.

- [ ] **Step 10: Commit**

```bash
git add packages/client/src/components/AddAgentModal.tsx
git commit -m "AddAgentModal: paste-a-key UI for OpenAI agents, drop local pairing instructions"
```

---

## Self-Review Notes

- **Spec coverage:** §1 (encryption) → Task 2. §2 (schema) → Task 1. §3 (`mintInstallation`/`setApiKey`) → Task 3 (note: `setApiKey` from the spec was simplified during planning to a `create()`-time param, since the validate-then-create ordering in Task 10 means there's never a case of setting the key after the row exists — see Task 3's interfaces). §4 (`runtime.ts` apiKey) → Task 5. §5 (library exports) → Task 6. §6 (`ApiKeyAgentSupervisor`) → Task 7. §7 (API layer) → Task 10. §8 (client) → Tasks 13-14. §9 (model switching) → Tasks 4-5. Error handling → Task 10 (400 on bad key) and Task 5/socket.ts (retry/backoff covers runtime failures, already existing code). Testing → one task per component (2, 3, 4, 5, 7, 12).
- **Type consistency check:** `ApiKeyAgentSupervisor.start(invite, apiKey)` (Task 7) matches `WorkspaceRuntime.startApiKeyAgent(invite, apiKey)` (Task 8) matches `onCreateAgent: (invite, apiKey) => ...` (Tasks 10, 11) matches `createAgent`'s `apiKey` field (Task 13) matches the JSX prop `apiKey`/`onApiKeyChange` (Task 14) — consistent naming throughout, no `apiKeyCiphertext` ever crosses into a public type.
- **No placeholders:** every step has real code, not descriptions of code.
