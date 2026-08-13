# Architecture

Monorepo of four npm workspaces. `shared` depends on nothing; `server`,
`client`, and `agent` depend only on `shared`. There are no other
cross-package edges — client and agent talk to the server exclusively over
the wire protocol (websocket) and the HTTP board API.

## Units

### packages/shared
- `participant.ts` — participant, chat message, and trace shapes.
- `board.ts` — board item/event shapes, workable statuses, authz contract.
- `protocol.ts` — the wire protocol: zod schemas for client→server frames,
  types for server→client frames.

### packages/server
- `WorkspaceDb` (`db.ts`) — owns the Supabase Postgres connection: queries,
  transactions, the single workspace row, global actors + workspace
  membership, per-workspace ref allocation. Schema/migrations live in
  `supabase/migrations/`, applied via the Supabase CLI, not in this file.
- `MessageStore` (`chat/`) — chat history rows.  → WorkspaceDb
- `Channels` (`chat/`) — the set of chat channels: seeds defaults, validates
  names, records new ones.  → WorkspaceDb
- `Attachments` (`chat/`) — owns uploaded files: stores bytes in the
  Supabase Storage `attachments` bucket, records metadata, binds them to
  messages, serves them back.  → WorkspaceDb
- `Roster` — participant identity + live presence; pre-loads workspace
  members (humans and agents) as offline so registered users never vanish
  from the list.  → WorkspaceDb
- `Hub` — routes websocket frames; the single message-posting path.
  → Roster, MessageStore, Channels, Attachments, Sessions, Toolman
- `BoardService` — every board transition, each with its audit row in one
  transaction, fanned out after commit.  → WorkspaceDb
- `Toolman` — the enforcement point for agent actions; sandboxed filesystem
  and shell mechanics. `authorizeMutation` is the pure policy decision.
  `authorize` exposes that decision on its own so the Hub can settle the board
  ceiling before prompting a human.  → BoardService
- `InteractionStore` (`chat/`) — durable permission prompts. A paused run is a
  row, so it survives a restart and every surface resolves the same request id.
  Startup expires prompts left by a previous process — their waiter is gone.
  → WorkspaceDb, ThreadEventStore
- `scope.ts` — scope-path semantics: normalize, match, validate.
- `schemaCheck.ts` — boot-time assertion that the database has what the code
  needs, with the fix in the message. A database a few migrations behind
  otherwise starts fine and fails feature by feature, which surfaces in the
  browser as an unexplained "Connecting…" rather than as a missing migration.
- `Sessions` — bearer tokens with TTL and revocation.
- `Auth` (`auth/`) — bridges a verified Supabase session to a workspace
  actor: re-verifies the caller's Supabase access token on every call (via
  a Supabase admin client) and maps it onto an `actors` row, creating one
  the first time a user picks a username. Google OAuth and email/password
  are both entirely Supabase Auth's problem — this class never sees a
  password or a Google credential, only the resulting JWT.  → WorkspaceDb
- `AgentInvites` (`auth/`) — user-created agents: a human names an agent and
  gets a single join token; revoking the invite evicts the agent but keeps
  its actor row for attribution.  → WorkspaceDb
- `joinPolicy.ts` (`auth/`) — the auth-mode join gate: resolves a join frame
  to an allowed participant name (a verified Supabase session, the agent's
  shared secret, or a per-agent invite token), so the Hub never knows how
  identities are proven.  → Auth, AgentInvites
- `api.ts` — HTTP routes for board items, actors, agent invites
  (`/api/agents`), channel creation, file uploads, login (`/api/auth/*`),
  and the unauthenticated `/api/health` liveness probe.  → BoardService,
  Sessions, Auth, AgentInvites, WorkspaceDb, Channels, Attachments
- `staticSite.ts` — serves the built client so production needs one origin
  and no second server; unknown paths fall back to index.html (SPA routing).
  Wired only when the dist directory exists (dev stays API-only).
- `DemoOrchestrator` (`demo/`) — replays JSON demo scripts through the real
  pipeline.  → Hub, Roster, BoardService
- `script.ts` (`demo/`) — demo script schema + loader for `assets/demo`.

### packages/client
- `ws.ts` `WorkspaceSocket` — exists so UI code never handles raw WebSocket
  frames or reconnection. Joins with a guest name or an authToken; treats
  the server's `unauthenticated` verdict as fatal (no reconnect loop).
- `lib/serverUrl.ts` — the single place server base URLs (ws + http) are
  derived: VITE_WS_URL override, then dev localhost, then the page's own
  origin (production is single-origin).
- `components/LoginScreen` — the auth-mode front door: starts a Supabase
  sign-in (Google OAuth redirect or email/password) and does not manage
  tokens itself. The first-time username pick lives in `App.tsx`.
- `hooks/useConnection` — socket lifecycle + everything the welcome frame
  carries (self, participants, channels, connected).
- `hooks/useApiSession` — the bearer-token fetch path, bound from the welcome
  frame; every HTTP call goes through it.
- `hooks/useChatMessages`, `hooks/useBoard` (items + optimistic updates),
  `hooks/useAgentTraces`, `hooks/useToasts`, `hooks/useAttachmentDrafts`
  (per-channel pending uploads: immediate upload, previews, ready-id handoff
  on send) — one state domain each.
- `hooks/WorkspaceContext` — composes the hooks; components consume context,
  never the socket or fetch.
- `lib/format.ts`, `lib/status.ts` — the only copies of date formatting and
  status→label/color mappings.
- `components/` — presentation; navigation callbacks are props, workspace
  data/actions come from context.

### packages/agent
- `index.ts` — startup wiring and socket event routing.
- `AgentRunner` (`runner.ts`) — work queue + run cycle: batching, brain
  execution, trace emission, aborts.
- `ProposalLifecycle` — reacts to board decisions (resume approved, drop
  denied, halt on delete) and restart-recovery sweep.
- `Presence` — computes and broadcasts working/blocked/idle status.
- `Brain` (`brain.ts`) — the interface every LLM backend implements
  (`run(input, callbacks, options) -> text`), plus the shared tool/prompt
  shapes both backends use.
- `GeminiBrain` — the Gemini implementation of `Brain`.
- `ClaudeBrain` — the Claude implementation of `Brain`, via
  `@anthropic-ai/claude-agent-sdk`; subscription-authenticated (`claude
  login`), no API key path.
- `BoardClient` — the agent's view of the board over the HTTP API.
- `Memory` / `PendingWork` — rolling transcript / stashed proposal work;
  static async factories so an uninitialized instance cannot exist.

## Constraints that are not visible in the code

- The board is a permission boundary. No agent write path may bypass
  `Toolman.execute`; tools not known to be read-only are treated as mutating
  (fail closed). `ClaudeBrain` enables only read-only native tools, so native
  Claude Code execution cannot mutate around this.
- Authorization is two layers, in this order. Layer 1 is the board grant: an
  item must be workable, cover the path (`scope_paths`) and grant the class of
  action (`capabilities`). Layer 2 is the conversation's permission mode,
  which only decides how much of that grant runs without asking — it can never
  widen layer 1. The Hub settles layer 1 first so no human is asked to approve
  something the board would refuse anyway.
- `shell_repo` is bounded by the sandbox root, not by `scope_paths`: a shell
  command's writes are not statically knowable. That coarseness is the reason
  it is a separate capability a human grants explicitly, rather than something
  `file_write` implies.
- An action class absent from `ACTION_CAPABILITY` can never be authorized, so a
  newly added tool fails closed until it is deliberately classified.
- If a permission decision cannot be recorded, the action does not run
  (`APPROVAL_UNAVAILABLE`): an unauditable mutation is worse than a refusal.
- Tool subprocesses get a minimal environment. `AGENT_TOKEN`, provider keys and
  the database URL live in the server's `process.env` and must never reach a
  child process or its output.
- Actor identity is never taken from a request body: the ws `join` upserts
  the persistent actor, HTTP derives the actor from the bearer token (I1).
- Auth mode is a config switch, not a flag: GOOGLE_AUTH_ENABLED and/or
  EMAIL_AUTH set = sign-in required (the Hub only admits joins its
  `authorizeJoin` gate resolves — humans by a verified Supabase session, agents by
  AGENT_TOKEN — and ignores client-supplied human names); neither set = the
  server refuses every join and the client shows a "contact support" dead end.
  The two sign-in methods share one Supabase Auth-backed `Auth` layer; either,
  both, or neither can be on.
- Every board mutation writes exactly one `board_events` row in the same
  transaction (I5) and fans out exactly one `{channel:"board"}` envelope.
- Agent-origin board items always carry `scope_paths` (enforced at creation);
  the toolman refuses unscoped agent items rather than treating them as
  unrestricted. Human items without scope are an explicit unrestricted grant.
- Toolman file actions are confined to `data/workspace/`.
- The Hub knows nothing about demos; `DemoOrchestrator` attaches through the
  Hub's three hooks and feeds inputs through the same paths humans use.
- `messages.author_id` has no FK to `actors`: kept loose so a message and
  its reactions can be deleted together without a cascade depending on the
  author row still existing.
- Client components must never copy an entity from a context list
  (agentInvites, participants, channels, board) into local useState and
  render from that copy — store only the id (plus any truly ephemeral data
  with no other source, e.g. a one-time secret) and re-derive via `.find()`
  on the context list every render, so the source updating/removing it is
  reflected automatically. Any modal that stays mounted across open/close
  (parent toggles an `open` prop instead of conditionally rendering) must
  reset its transient local state in a `useEffect` keyed on `open`, since
  unmounting won't do it for you. (`AddAgentModal`'s "created agent" banner
  was the counterexample, fixed 2026-08-13.)

## Decisions a reader would not predict

- 2026-08-05 — Chat history lives in the same SQLite file as the board
  (`data/board.db`); the legacy `data/messages.json` is imported once and
  renamed `.imported`. Consequence: one transactional store, no JSON storage
  layer.
- 2026-08-05 — Demo scripts are pure data (`assets/demo/scripts/*.json`)
  replayed by an orchestrator through the real hub/board pipeline. The
  client-side standalone demo fallback was deleted; demos require a running
  server and agent. Consequence: demo output is real system behavior, one
  source of truth for scripts.
- 2026-08-05 — Proposals declare `scope_paths` and the toolman enforces them
  per-path. Consequence: approving a proposal grants a bounded footprint,
  not workspace-wide write access.
- 2026-08-05 — Sessions are in-memory with a 12h TTL, revoked when a human's
  last connection closes. A server restart logs everyone out; accepted for a
  single-node deployment.
- 2026-08-05 — Google ID-token verification is hand-rolled on node:crypto
  (JWKS fetch, RS256 verify, iss/aud/exp checks) instead of pulling
  google-auth-library. Consequence: we own the edge cases (kid rotation,
  clock skew, alg confusion), tested in auth.test.
- 2026-08-05 — Google login sessions are DB rows (`auth_sessions`, 30-day
  TTL, lazy sweep) unlike the in-memory ws-API `Sessions`: a restart must
  not log every Google user out. The short-lived ws-API token stays
  in-memory and is still minted fresh per welcome.
- 2026-08-05 — `GET /api/uploads/:id/:name` is deliberately unauthenticated:
  the unguessable UUID id is the capability, the same model as Discord CDN
  links, because `<img>` tags cannot send Authorization headers. Consequence:
  anyone holding an attachment URL can fetch its bytes. Uploading stays
  bearer-token gated; unbound uploads are swept after 1h (lazily, on the
  next upload).
- 2026-08-05 — `welcome.apiUrl` is derived per connection from the upgrade
  request's Host and X-Forwarded-Proto headers, not configured at boot: a
  boot-time URL breaks behind any real domain or reverse proxy. Consequence:
  the server trusts those headers to name its public origin, so a proxy in
  front must set them (see DEPLOY.md).
- 2026-08-09 — `ClaudeBrain` authenticates exclusively via a pre-logged-in
  `claude` CLI subprocess (subscription auth, `claude login`), deliberately
  with no `ANTHROPIC_API_KEY` fallback. Consequence: every host running the
  agent with `AGENT_PROVIDER=claude` needs a one-time interactive login;
  headless/CI deploys of this provider aren't possible until that changes.
- 2026-08-13 — Resolved the 2026-08-09 native-tool bypass. `ClaudeBrain` now
  enables only read-only native tools (Read, Glob, Grep, WebFetch, WebSearch);
  every mutation goes through the MCP-routed board tools, so the board is a
  complete permission boundary under `AGENT_PROVIDER=claude` too. Shell now
  exists as a first-class `run_shell` action gated by the `shell_repo`
  capability and executed in the server's sandbox with a minimal environment,
  rather than as an ungated native tool reaching the whole host.
- 2026-08-09 — Persistence, auth, and file storage moved from
  `node:sqlite`/hand-rolled Google ID-token verification+scrypt/local disk
  to Supabase (Postgres, Auth, Storage) — a clean cutover, no data
  migration, since there was no production data yet. Consequence: every
  store method that used to be a synchronous `DatabaseSync` call is now
  `async` (a Postgres round-trip); `actors.id` for a Supabase-authenticated
  human is the Supabase Auth user id (`auth.users.id`), not an
  app-generated uuid; agent actors are unaffected (they never went through
  Supabase Auth). See `docs/superpowers/plans/2026-08-09-supabase-migration.md`.
- 2026-08-12 — RLS is enabled deny-all (no policies) on every table
  (`supabase/migrations/20260812090000_enable_rls.sql`). Supabase exposes
  all `public` tables through its PostgREST Data API, so before this,
  anyone holding the publishable key — it ships in the client bundle —
  could read and write every table directly, bypassing the server's auth
  and the board permission boundary entirely. This app never uses the Data
  API: the server connects straight to Postgres as the table-owning
  `postgres` role, which plain (non-FORCE) RLS does not restrict.
  Consequence: any future feature that wants client-side Supabase reads
  must add explicit RLS policies rather than flipping RLS off.
- 2026-08-12 — The workspace became a first-class entity (supersedes "one
  hardcoded server"): a `workspaces` table (single row named `test_space`,
  keeping the old meta server_id uuid) plus a `workspace_members` join table
  separate global identity (`actors`; Supabase Auth ids for humans) from
  workspace registration. Membership is written at signup, agent-invite
  creation, and AGENT_TOKEN agent creation; demo personas and guest actors
  stay non-members and are never pre-loaded into the roster. Offline members
  (humans included) persist in the roster — "humans exist only while a tab
  is open" is gone, though API tokens still die with the last connection.
  `server_id` is renamed to `workspace_id` everywhere (schema, code, wire)
  and `meta` is dropped. Still exactly one workspace, no multi-tenancy in
  the transport — multi-workspace is structure-ready, not implemented.
- 2026-08-13 — Agent identity is workspace-scoped, not a global account:
  `findActorByName("agent", ...)` only matches agents still in
  `workspace_members` for this workspace, and revoking an agent invite
  (`DELETE /api/agents/:id`) now also drops that membership row
  (previously it only flipped `agent_invites.revoked_at`, leaving the
  agent a member forever). Consequence: once an agent is removed, its
  name is free again for what is a genuinely new actor row/id — old board
  items and messages keep pointing at the retired actor for attribution,
  but nothing links the new agent to the old one. Humans are unaffected:
  `findActorByName("human", ...)` stays global with no workspace filter,
  matching the permanent-username, multi-workspace-capable account model.
