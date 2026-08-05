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
- `api.ts` — HTTP routes for board items, actors, channel creation, and
  file uploads.  → BoardService, Sessions, WorkspaceDb, Channels, Attachments
- `DemoOrchestrator` (`demo/`) — replays JSON demo scripts through the real
  pipeline.  → Hub, Roster, BoardService
- `script.ts` (`demo/`) — demo script schema + loader for `assets/demo`.

### packages/client
- `ws.ts` `WorkspaceSocket` — exists so UI code never handles raw WebSocket
  frames or reconnection.
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
- `GeminiBrain` — the concrete LLM client (no interface: single
  implementation by design; extract one when a second provider exists).
- `BoardClient` — the agent's view of the board over the HTTP API.
- `Memory` / `PendingWork` — rolling transcript / stashed proposal work;
  static async factories so an uninitialized instance cannot exist.

## Constraints that are not visible in the code

- The board is a permission boundary. No agent write path may bypass
  `Toolman.execute`; tools not known to be read-only are treated as mutating
  (fail closed).
- Actor identity is never taken from a request body: the ws `join` upserts
  the persistent actor, HTTP derives the actor from the bearer token (I1).
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
- 2026-08-05 — `GET /api/uploads/:id/:name` is deliberately unauthenticated:
  the unguessable UUID id is the capability, the same model as Discord CDN
  links, because `<img>` tags cannot send Authorization headers. Consequence:
  anyone holding an attachment URL can fetch its bytes. Uploading stays
  bearer-token gated; unbound uploads are swept after 1h (lazily, on the
  next upload).
- One hardcoded server: `server_id` is plumbed through the data model but
  there is no multi-tenancy in the transport.
