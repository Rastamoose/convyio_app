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
- `WorkspaceDb` (`db.ts`) — owns the SQLite file: schema, migrations,
  transactions, actors, per-server ref allocation.
- `MessageStore` (`chat/`) — chat history rows.  → WorkspaceDb
- `Channels` (`chat/`) — the set of chat channels: seeds defaults, validates
  names, records new ones.  → WorkspaceDb
- `Attachments` (`chat/`) — owns uploaded files: stores bytes on disk
  (`data/uploads/<id>`), records metadata, binds them to messages, serves
  them back.  → WorkspaceDb
- `Roster` — participant identity + live presence.  → WorkspaceDb
- `Hub` — routes websocket frames; the single message-posting path.
  → Roster, MessageStore, Channels, Attachments, Sessions, Toolman
- `BoardService` — every board transition, each with its audit row in one
  transaction, fanned out after commit.  → WorkspaceDb
- `Toolman` — the enforcement point for agent actions; sandboxed filesystem
  mechanics. `authorizeMutation` is the pure policy decision.  → BoardService
- `scope.ts` — scope-path semantics: normalize, match, validate.
- `Sessions` — bearer tokens with TTL and revocation.
- `Auth` (`auth/`) — owns login identity: exchanges verified Google
  credentials for workspace actors and persistent 30-day sessions
  (auth_sessions), so the hub and the API never know Google exists.
  → WorkspaceDb
- `googleIdToken.ts` (`auth/`) — verifies a Google ID token and nothing
  else; the JWKS fetcher is injectable so tests never touch the network.
- `joinPolicy.ts` (`auth/`) — the auth-mode join gate: resolves a join frame
  to an allowed participant name (human session token or agent shared
  secret), so the Hub never knows how identities are proven.  → Auth
- `api.ts` — HTTP routes for board items, actors, channel creation, file
  uploads, login (`/api/auth/*`), and the unauthenticated `/api/health`
  liveness probe.  → BoardService, Sessions, Auth, WorkspaceDb, Channels,
  Attachments
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
- `components/LoginScreen` — the auth-mode front door: Google Sign-In button
  (GIS script), credential exchange, first-time username pick. App only
  receives the finished authToken.
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
  (fail closed). Exception, tracked below: `ClaudeBrain`'s native Claude Code
  tools (`AGENT_PROVIDER=claude`) currently bypass this — accepted MVP debt,
  not the general rule.
- Actor identity is never taken from a request body: the ws `join` upserts
  the persistent actor, HTTP derives the actor from the bearer token (I1).
- Auth mode is a config switch, not a flag: GOOGLE_CLIENT_ID and/or
  EMAIL_AUTH set = sign-in required (the Hub only admits joins its
  `authorizeJoin` gate resolves — humans by session token, agents by
  AGENT_TOKEN — and ignores client-supplied human names); neither set = the
  guest flow, byte-for-byte the old behavior. The two sign-in methods share
  one `Auth`/session layer; either, both, or neither can be on.
- Every board mutation writes exactly one `board_events` row in the same
  transaction (I5) and fans out exactly one `{channel:"board"}` envelope.
- Agent-origin board items always carry `scope_paths` (enforced at creation);
  the toolman refuses unscoped agent items rather than treating them as
  unrestricted. Human items without scope are an explicit unrestricted grant.
- Toolman file actions are confined to `data/workspace/`.
- The Hub knows nothing about demos; `DemoOrchestrator` attaches through the
  Hub's three hooks and feeds inputs through the same paths humans use.
- `messages.author_id` has no FK to `actors`: history imported from the
  legacy JSON store may predate actor rows.

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
- One hardcoded server: `server_id` is plumbed through the data model but
  there is no multi-tenancy in the transport.
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
- 2026-08-09 — `ClaudeBrain` leaves Claude Code's native tools (Bash, Write,
  Edit, ...) enabled ungated, alongside the existing board tools. This
  bypasses the invariant below ("no agent write paths bypass Toolman") for
  the claude provider specifically — accepted as MVP debt. Consequence: with
  `AGENT_PROVIDER=claude`, the board is not a complete permission boundary; a
  human board approval is not required for Claude to write files or run
  shell commands. Follow-up: route `ClaudeBrain`'s `canUseTool` callback
  through the same board-approval flow `board_propose`/`write_file` already
  use.
