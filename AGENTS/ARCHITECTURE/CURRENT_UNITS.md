# Current units

This page describes units that exist in the code now.

Monorepo of four npm workspaces. `shared` depends on nothing; `server`,
`client`, and `agent` depend only on `shared`. There are no other
cross-package edges — client and agent talk to the server exclusively over
the wire protocol (websocket) and the HTTP board API.

## Units

### packages/shared
- `participant.ts` — participant, chat message, and trace shapes.
- `board.ts` — board item/event shapes, workable statuses, authz contract.
- `agentWork.ts` — durable agent conversation, run-request, permission-mode and interaction shapes.
- `thread.ts` — canonical append-only workspace event and channel shapes.
- `context.ts` — plan, context-entry, cursor and workspace-snapshot shapes.
- `prompt.ts` — typed Prompt Envelope and its render function.
- `protocol.ts` — the wire protocol: zod schemas for client→server frames,
  types for server→client frames.

### packages/server
- `WorkspaceDb` (`db.ts`) — a workspace-scoped view over the shared Supabase Postgres connection. It stamps one verified workspace identity onto actors and every domain store; scoped instances share the root connection rather than opening one pool per workspace.
- `AccountStore` (`auth/AccountStore.ts`) — global human identity plus membership and role lookup. It never selects an active workspace for the user.
- `WorkspaceAccess` (`auth/WorkspaceAccess.ts`) — workspace creation, public-code access requests, expiring single-use invites, owner/member role transitions and last-owner enforcement. Every accepted membership change and access decision is transactional and audited in `thread_events`.
- `WorkspaceRegistry` — lazily creates one `WorkspaceRuntime` per active workspace and routes `/ws/:workspaceId`, `/toolman/:workspaceId`, pairing credentials and workspace-bound API sessions to it.
- `WorkspaceRuntime` — composes one workspace's roster, Hub, stores, Toolman sandbox, projects, context and demos. A runtime broadcasts only to its own connections.
- `MessageStore` (`chat/`) — chat history rows.  → WorkspaceDb
- `Channels` (`chat/`) — the set of chat channels: seeds defaults, validates
  names, records new ones.  → WorkspaceDb
- `Attachments` (`chat/`) — owns uploaded files: stores bytes in the
  Supabase Storage `attachments` bucket, records metadata, binds them to
  messages, serves them back.  → WorkspaceDb
- `Roster` — participant identity + live presence; pre-loads workspace
  members (humans and agents) as offline so registered users never vanish
  from the list.  → WorkspaceDb
- `Hub` — routes websocket frames; the single message-posting, agent-dispatch
  and Toolman gateway. → Roster, MessageStore, AgentWorkStore, Channels,
  Attachments, Sessions, Toolman, InteractionStore, RunnerRuntime
- `BoardService` — every ticket transition, each with its audit row in one
  transaction, fanned out after commit. Tickets start proposed and require an
  accepted plan.  → WorkspaceDb, PlanService
- `PlanService` — persistent megaplan records. Acceptance is human-only and
  grants no mutating authority.  → WorkspaceDb, ThreadEventStore
- `Toolman` — the enforcement point for agent actions; sandboxed filesystem
  and shell mechanics. `authorizeMutation` is the pure policy decision.
  `authorize` exposes that decision on its own so the Hub can settle the board
  ceiling before prompting a human.  → BoardService
- `InteractionStore` (`chat/`) — durable permission prompts. A paused run is a
  row, so it survives a restart and every surface resolves the same request id.
  Startup expires prompts left by a previous process — their waiter is gone.
  → WorkspaceDb, ThreadEventStore
- `ThreadEventStore` (`chat/`) — persists and pages the canonical sequenced
  workspace event stream. → WorkspaceDb
- `AgentWorkStore` (`chat/`) — projects durable agent conversations and
  mention-triggered run requests, including claim, completion, restart
  requeue and approved-ticket dispatch. → WorkspaceDb, ThreadEventStore, MessageStore
- `scope.ts` — scope-path semantics: normalize, match, validate.
- `schemaCheck.ts` — boot-time assertion that the database has what the code
  needs, with the fix in the message. A database a few migrations behind
  otherwise starts fine and fails feature by feature, which surfaces in the
  browser as an unexplained "Connecting…" rather than as a missing migration.
- `Sessions` — bearer tokens with TTL and revocation.
- `RunnerRuntime` — ephemeral per-runner health and capabilities. Not
  persisted: it describes a process, not a profile.
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
- `ContextStore` (`context/`) — durable shared-context entries (decision,
  constraint, fact, blocker, handoff, summary). Entries are attributed and
  superseded, never rewritten. → WorkspaceDb, ThreadEventStore
- `ContextCursorStore` (`context/`) — per-actor acknowledged workspace-event
  cursor; never rewinds. → WorkspaceDb, ThreadEventStore
- `WorkspaceSnapshotBuilder` (`context/`) — cursor-bearing projection of
  items, plans, members and active context. Captures thread_events.seq first so
  live events after that seq remain applyable. → WorkspaceDb, BoardService,
  PlanService, ContextStore
- `PromptEnvelopeBuilder` (`context/`) — hashed policy files plus the live
  snapshot compiled for a run. Exposed as `GET /api/workspace/prompt-envelope`.
  → WorkspaceSnapshotBuilder
- `DemoOrchestrator` (`demo/`) — replays JSON demo scripts through the real
  pipeline. Approves tickets with an owner and can accept plans.
  → Hub, Roster, BoardService, PlanService
- `script.ts` (`demo/`) — demo script schema + loader for `assets/demo`.

### packages/client
- `App.tsx` — account boot and workspace navigation: sign-in, permanent username, invite continuation, membership lobby, persisted last-workspace selection and keyed `WorkspaceProvider` remounts.
- `WorkspaceLobby` — lists memberships and pending/denied requests; creates workspaces and submits access requests by public code.
- `WorkspaceInviteFlow` — previews an invite before auth, preserves it across OAuth/email redirects and accepts it after identity is established.
- `WorkspaceSettings` — workspace code, invite links, access decisions, roles, member removal and self-service leave.
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
- `hooks/useChatMessages`, `hooks/useBoard` (items, plans, optimistic updates),
  `hooks/useAgentTraces`, `hooks/useToasts`, `hooks/useAttachmentDrafts`
  (per-channel pending uploads: immediate upload, previews, ready-id handoff
  on send) — one state domain each.
- `WorkspaceContext` — one selected workspace's state only. Drafts, unread cursors, HTTP credentials, messages, board state and sockets are discarded or namespace-scoped when switching.
- `lib/format.ts`, `lib/status.ts` — the only copies of date formatting and
  status→label/color mappings.
- `index.css` — the design-token layer (Tailwind v4 `@theme`): every color a
  component may use, named by role, plus the `elevated` utility that owns all
  floating surfaces. The language it implements is `AGENTS/DESIGN.md`.
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
- `AcpBrain` — the Agent Client Protocol implementation of `Brain`; spawns
  the Claude ACP harness and denies any non-read tool call.
- `cli.ts` — the `convyio-agent` entry point: pair, run, status.
  Deliberately never imports `config.ts`, so a paired agent cannot inherit
  the repo-root `.env`.
- `installation.ts` — the durable pairing credential on disk, outside the
  repo.
- `runtime.ts` — resolves a stored profile into an effective local
  configuration and reports the result as runner health.
- `BoardClient` — the agent's view of the board over the HTTP API; loads
  the Prompt Envelope when present.
- `ConversationSessions` — persists each conversation's provider-session id
  and permission mode outside the repository.
- `nativeTools.ts` — provider-neutral ceiling for Claude/ACP native tools.
  Mutations still go through Toolman.
- `Memory` — rolling transcript; static async factory so an uninitialized
  instance cannot exist. Approved ticket work is queued by the server.
