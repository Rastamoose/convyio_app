# Hosted OpenAI agents: paste an API key, no local process

Date: 2026-08-22
Status: approved for planning

## Context

`AddAgentModal.tsx`'s "Use an API key" method is not actually a paste-and-go
flow today. It tells the user to `export OPENAI_API_KEY=...` on whatever
machine will run `convyio-agent`, then copy a pairing command
(`npx convyio-agent connect --server ... --code ...`) into a terminal on that
machine. Users don't want to run anything locally for this path — they just
want to paste a key into Convyio and have the agent work.

The pieces to make that real already exist, they're just wired for a human
with a terminal instead of the server itself:

- `packages/agent/src/runtime.ts`'s `runAgent({mode: "installation", ...})`
  is already decoupled from being its own OS process — `ownProcess: false`
  skips the `SIGINT`/`SIGTERM` binding a standalone CLI needs
  (`runtime.ts:232-235`).
- The OpenAI branch of `localConfiguration()` (`runtime.ts:244-246`) reads
  `process.env.OPENAI_API_KEY` — one global env var, not scoped per agent.
- `AgentInvites.exchangePairing()` (`packages/server/src/auth/AgentInvites.ts:248-285`)
  already does the real work of turning a credential into a running
  installation: it mints an `agent_installations` row and an installation
  token. The first half of that method (consuming a pairing code) exists
  purely so a human can type/paste a short-lived code into a terminal within
  a 10-minute window (`DEFAULT_PAIRING_TTL_MS`) — that ceremony has no
  purpose when the server is granting itself an installation.
- There's no encryption-at-rest anywhere in this app today — only one-way
  SHA-256 hashing for pairing/installation tokens
  (`AgentInvites.ts:20-22`). A pasted API key must be retrievable
  (decrypted), so it needs real encryption, built from scratch.

## Goal

When a user creates an OpenAI-provider agent and pastes an API key into the
modal, the server stores the key (encrypted) and starts running that agent
itself, in-process, immediately — no CLI, no env var, no pairing code shown
to the user. The agent connects to the workspace over the exact same
`AgentSocket` → `Hub` websocket path, with the exact same auth/permission
gating, prompt composition, and activation protocol as a human-paired agent.
That boundary is not touched or duplicated by this work — only the "how does
a credential turn into a running installation" step changes, from
copy-a-code-into-a-terminal to a direct in-process function call.

Out of scope: the "existing agent" method (hooking up an already-running
local coding agent like Claude Code/Codex on the user's own machine) is
untouched — different use case, not part of this ask. Claude/Codex hosted
agents are also out of scope; this is OpenAI-only, matching the existing
`agent.provider === "openai"` gate in `AddAgentModal.tsx:517`.

## Architecture

### 1. Encryption (`packages/server/src/crypto/secretBox.ts`, new)

AES-256-GCM via `node:crypto`, no new dependency. Two functions:

```ts
export function encrypt(plaintext: string): string; // "iv:authTag:ciphertext", hex
export function decrypt(ciphertext: string): string;
```

Key comes from a new required env var `AGENT_SECRET_KEY` (32 bytes,
base64), read once in `config.ts` next to the other secrets. `secretBox`
throws if the env var is missing or malformed — fails at boot, not at
first use, matching `assertSchemaCurrent`'s "fail loud before serving"
pattern already in `index.ts:57`.

### 2. Schema (new migration, `agent_invites` gets one column)

```sql
alter table agent_invites add column api_key_ciphertext text;
```

Nullable — only set for `provider = 'openai'` agents created through this
flow. Never selected into any client-facing response; `AgentInvites.list()`
/`toInvite()` continues to omit it, `board/api.ts`'s `GET /api/agents`
response only ever needs to say `hasApiKey: boolean` for the settings UI to
show "key set" vs. not.

### 3. `AgentInvites`: factor the installation-minting half out

`exchangePairing()` currently does two things in one transaction: consume a
pairing code, then mint an `agent_installations` row + token
(`AgentInvites.ts:272-283`). Split the second half into:

```ts
async mintInstallation(inviteId: string): Promise<{
  invite: AgentInvite;
  installation: AgentInstallation;
  installationToken: string;
} | null>
```

`exchangePairing()` calls `mintInstallation` after it validates and consumes
the code, inside the same transaction — human pairing behavior is
unchanged, byte for byte. The new hosted-agent path calls `mintInstallation`
directly, skipping the pairing-code table entirely: no code, no 10-minute
expiry race, no artifact that would need to be shown to (or copy-pasted by)
anyone.

Also add:

```ts
async setApiKey(inviteId: string, ciphertext: string | null): Promise<void>
```

storing/clearing `api_key_ciphertext`, and extend `create()` to accept an
optional ciphertext at creation time.

### 4. `runtime.ts`: per-agent key instead of a global env var

`InstallationConfiguration` gains `apiKey?: string`. `localConfiguration()`'s
OpenAI branch (`runtime.ts:244-246`) becomes:

```ts
const apiKey = configuration.apiKey ?? process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("An OpenAI API key is required for this agent.");
```

This keeps the existing CLI/env-var path working unchanged for anyone still
pairing manually (nothing about this spec removes that capability from
`packages/agent` — only the UI stops telling users to do it). Hosted agents
always pass `apiKey` explicitly.

### 5. `packages/agent` becomes an importable library, not just a CLI bundle

`packages/agent/package.json` gets an `exports` field, mirroring
`@workspace/shared`'s pattern:

```json
"exports": { "./runtime": "./src/runtime.ts" }
```

`openai` moves from `devDependencies` to `dependencies` in that same
file — today it's a devDependency because the CLI bundle (`npm run build`,
esbuild) inlines it, but `packages/server` will import `runtime.ts`
unbundled (via `tsx`, like it already does for its own source and for
`@workspace/shared`), so `openai` needs to be a real runtime dependency
resolvable from `packages/server`'s process. `packages/server/package.json`
adds `"@workspace/agent": "*"`.

### 6. `ApiKeyAgentSupervisor` (`packages/server/src/agents/ApiKeyAgentSupervisor.ts`, new)

One instance per `WorkspaceRuntime` (constructed in
`WorkspaceRuntime.create()` alongside `hub`, `agentInvites`, etc. — see
`WorkspaceRuntime.ts:127-160`). Holds `Map<agentId, {close(): void}>`.

```ts
class ApiKeyAgentSupervisor {
  constructor(private agentInvites: AgentInvites, private port: number) {}
  async start(invite: AgentInvite, apiKey: string): Promise<void> {
    const minted = await this.agentInvites.mintInstallation(invite.id);
    if (!minted) return; // invite was revoked between create and start
    const installation: StoredInstallation-shaped object = {
      installation: minted.installation,
      installationToken: minted.installationToken,
      agent: minted.invite,
      workspace: { id, name },
      apiUrl: `http://127.0.0.1:${this.port}`,
      wsUrl: `ws://127.0.0.1:${this.port}/ws/${encodeURIComponent(workspaceId)}`,
    };
    const connection = await runAgent({ mode: "installation", installation, apiKey, ownProcess: false });
    this.connections.set(invite.id, connection);
  }
  stop(agentId: string): void { this.connections.get(agentId)?.close(); this.connections.delete(agentId); }
  async syncAll(): Promise<void> { /* boot reconciliation, see below */ }
}
```

The `wsUrl` is a loopback address on the port the server is already
listening on (`config.port`, `index.ts:170`) — no dependency on any
incoming request's `Host` header (`requestOrigin()` can't be used here,
there is no request). This is an ordinary websocket connection into the
server's own `Hub`, going through the identical join/auth path
(`hub.ts`'s roster join, `authorizeJoin`, `runner_status` protocol) that any
other agent — human-paired, `HostedSupervisor`-run, or hosted — uses. No
new or bypassed permission path.

**Boot reconciliation** (`syncAll()`, called once at the end of
`WorkspaceRuntime.create()`): list invites via `agentInvites.list()`,
filter to `provider === "openai"` with a stored `api_key_ciphertext`,
decrypt each, call `start()`. This is what keeps hosted agents running
across a server restart — mirrors the reconciliation `HostedSupervisor`
does by polling, except here the server already knows its own invites
directly, so it's a one-shot pass on boot rather than a poll loop.

**Shutdown**: `WorkspaceRuntime.close()` (`WorkspaceRuntime.ts:228-230`)
gains `for (const id of ...) this.apiKeyAgents.stop(id)` alongside
`hub.close()`.

### 7. API layer (`packages/server/src/board/api.ts`)

`createAgentBodySchema` (line 128) gains:

```ts
apiKey: z.string().trim().min(1).max(500).optional(),
```

`POST /api/agents` handler (line 792): after `agentInvites.create(...)`,
if `body.provider === "openai" && body.apiKey`:
1. Validate the key with one lightweight call (`new OpenAI({apiKey}).models.list()`)
   before persisting — a bad key is rejected in the response immediately
   (`400 INVALID_API_KEY`) instead of silently creating a dead agent that
   never reports ready.
2. `agentInvites.setApiKey(invite.id, secretBox.encrypt(body.apiKey))`.
3. Call the new `onCreateAgent?.(invite, body.apiKey)` callback (new field
   on `createApiHandler`'s options, alongside the existing `onUpdateAgent`/
   `onRevokeAgent`), wired in `index.ts` to
   `(invite, apiKey) => runtime.startApiKeyAgent(invite, apiKey)`.
4. Skip `createPairing()` entirely for this case — there's nothing for a
   human to pair; the response omits `pairingCode`.

`DELETE /api/agents/:id` (line 834): `onRevokeAgent` (`index.ts:108`)
becomes `(actorId) => { runtime.hub.closeAgentConnection(actorId); runtime.stopApiKeyAgent(actorId); }`.

`GET /api/agents` (line 775): each agent gains `hasApiKey: boolean`
(`invite.apiKeyCiphertext !== null` — a field the DB layer exposes without
ever exposing the ciphertext itself in the shared `AgentInvite` type).

A key-rotation path (`PATCH /api/agents/:id` gaining an optional `apiKey`)
is small enough to fold into this same change: on patch, if `apiKey` is
present, stop the existing connection, re-encrypt/store, re-`start()`.

### 8. Client (`packages/client/src`)

- `WorkspaceContext.tsx` `createAgent` (~576-608): POST body gains
  `apiKey` when provider is `"openai"`.
- `AddAgentModal.tsx`:
  - `MethodStep` (378-403): reword the "Use an API key" description —
    drop "set locally as an environment variable"; something like "Paste
    an API key and Convyio runs the agent for you."
  - `CreateStep` (452-460, apikey branch): replace the
    `Set OPENAI_API_KEY on the machine running convyio-agent` instructional
    text with a password-style `<input>` for the key, included in the
    `createAgent` call.
  - `PairStep` (541-613): the apikey branch (578-589) — shell-export
    commands and `pairCommand` — is skipped entirely for this method. By
    the time `CreateStep` returns, the server has already started the
    agent. Show a lightweight status (starting → ready/error) instead,
    driven by the same `runner.summary()` health data `GET /api/agents`
    already returns (`runtime.health`) — no new status mechanism, reuse
    whatever indicator the agent list already renders for connected/
    checking/degraded agents.
  - `setupPrompt`/"existing agent" branch is untouched.

### 9. Model switching (OpenAI)

`ConfigureStep` (`AddAgentModal.tsx:764-796`) already has a model `<select>`
wired to the existing `PATCH /api/agents/:id` → `agentInvites.update()` →
`configRevision` bump → `profileUpdates.enqueue()` pipeline
(`runtime.ts:92-128`). This is the "profile tab" model-switch control — no
new tab or UI surface needed. But for OpenAI agents it doesn't currently do
anything real:

- `OpenAIBrain` (`openaiBrain.ts:22-30`) takes `model` once in its
  constructor and never re-reads it — `run()` always uses `this.model`.
  Add `setModel(model: string): void { this.model = model; }`.
- `Brain` (`brain.ts`) gains an optional `setModel?(model: string): void`
  on the interface — implemented by `OpenAIBrain`, left unimplemented by
  `GeminiBrain`/`ClaudeBrain` (the ACP path already reconfigures via
  `local.acp.configure()` at `runtime.ts:104`, a separate mechanism that's
  untouched).
- `runtime.ts`'s `profileUpdates` handler, non-ACP branch
  (`runtime.ts:118-121`): before `reportLegacyReady`, call
  `local.brain.setModel?.(model)` where `model = profile.requestedModel ??
  DEFAULT_OPENAI_MODEL`, and report that resolved model (a small mutable
  variable tracked outside `local`, since `local.effectiveModel` is
  currently fixed at startup) instead of the stale startup-time value.
- The `RunnerConfigOption` choices list built in `localConfiguration()`'s
  OpenAI branch (`runtime.ts:257-264`) changes from a single-entry list
  (just the current model) to a real fixed set of selectable OpenAI chat
  models, e.g. `gpt-5`, `gpt-5-mini`, `gpt-5-nano` (module-level const
  array — no API call to list models, matching the "no unrequested
  abstraction" bar; add to the array later if OpenAI ships new ones).

## Error handling

- Bad API key at creation time → `400 INVALID_API_KEY` from the
  `models.list()` preflight check, surfaced as a form error in `CreateStep`
  — no agent/invite row is created if this check runs before
  `agentInvites.create()`.
- Key later revoked/expired at the OpenAI end → the running `runAgent`
  connection will fail at its own OpenAI call boundary; this surfaces via
  the existing `runner_status`/health protocol (`degraded`/`misconfigured`)
  exactly as any other runtime failure does today. No new failure path to
  build.
- Server restart mid-flight → `syncAll()` on boot restarts every stored
  hosted agent; no manual re-pairing needed, which is the actual point of
  this feature (nothing about the agent's liveness should depend on a
  human's machine or terminal being open).

## Testing

- `AgentInvites.mintInstallation` / `exchangePairing` still share the same
  transactional minting logic — existing pairing tests continue to cover
  the shared path; add one test that calls `mintInstallation` directly
  (no pairing code) and asserts it produces a valid installation.
- `secretBox`: round-trip encrypt/decrypt test, and a test that a tampered
  ciphertext fails to decrypt (GCM auth tag).
- `ApiKeyAgentSupervisor`: unit test with a fake `runAgent` (already the
  pattern `hostedSupervisor.test.ts`-style tests use via the injectable
  `runAgent` option) asserting `start`/`stop`/`syncAll` lifecycle.
- One integration-level test: `POST /api/agents` with `provider: "openai"`
  and `apiKey` set results in a `Hub` connection appearing for that actor
  (reuse existing agent-connection test fixtures).

## Accepted debt / follow-ups

- No key-rotation UI in the modal itself for v1 (the PATCH endpoint
  supports it per §7, but wiring a "change key" affordance into the
  agent's settings view is left for a follow-up — not required for "paste
  a key and it works").
- `AGENT_SECRET_KEY` is a single static key read from the environment —
  no rotation/versioning scheme. Fine for a first cut; would need a
  key-id prefix on the ciphertext before this key is ever rotated.
