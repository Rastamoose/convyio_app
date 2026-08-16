# Recorded architecture decisions

Entries remain after they are superseded: later decisions say what changed and
why. Current behavior is documented in the current-state pages.

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
  front must set them (see ../DEPLOY.md).
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
- 2026-08-13 — A model the harness does not advertise falls back to the
  harness default and reports `degraded` + `MODEL_UNAVAILABLE`, rather than
  failing preflight. A model preference is stored server-side and outlives
  the harness version that accepted it, so a stale preference must not take
  an agent offline. Consequence: an agent can run on a model other than the
  one configured, and the profile panel is the only place that difference is
  visible.
- 2026-08-15 — The client adopted a written design language
  (`AGENTS/DESIGN.md`): tokens named by role (`accent`, `on-accent`,
  `subtle`, `backdrop` — the old `blurple` was amber, `mention-*` was
  generic), sans for prose with self-hosted JetBrains Mono
  (`@fontsource/jetbrains-mono`, replacing the Google Fonts link) reserved
  for code, refs and micro-labels, and the neo-brutalist hard shadows on the
  auth screens retired in favor of `elevated` panels. Consequence: color
  renames are total — old token names do not compile, and a new token wants
  a role name, not a hue name.
- 2026-08-15 — The app shell became a frame composition: an `app-frame`
  canvas (with a faint amber glow in dark mode) carries the sidebar directly;
  `elevated` surfaces are glass (translucent tint + backdrop blur +
  saturate). The sidebar collapses via ⌘B/Ctrl-B or the TopBar toggle,
  persisted in `localStorage` (`convyio:sidebar-open`).
  `--color-sidebar`/`--color-userpanel` are gone — the sidebar has no surface
  of its own. Consequence: anything positioned relative to the sidebar edge
  (e.g. ApprovalQueue's fixed offset) assumes the 240px width and only exists
  while the sidebar is open.
- 2026-08-15 — The floating content panel from the frame composition was
  reverted (it read as a copy of another product's skeleton). The layout is
  now "the desk": full-bleed tonal zones, sidebar on the canvas with one
  hairline edge, content edge-to-edge. Two identity details land instead:
  mentions render as an amber highlighter wash (the landing page's marker
  gesture), and the board can pin open as a 400px pane beside the chat (the
  "workbench"; persisted as `convyio:board-pinned`), so approval stays
  visible mid-conversation. Consequence: `BoardView` renders at both
  full-window and 400px widths — column layout must stay horizontally
  scrollable rather than assuming room for all five columns.
- 2026-08-15 — Approvals live in chat. A proposed item is a
  `ProposalCard` in the conversation timeline; a paused run's
  `PermissionCard` sits on that run (or in the timeline if the run
  is not visible). The AppBar "N waiting" chip and the Board tab
  render the same request/item ids — they are indexes, not a second
  home. Toast "View" stays in chat and scrolls to the card.
  Consequence: `item.proposed` no longer writes a chat system line
  next to the card; `item.approved` / `item.denied` still do.
  The earlier 2026-08-15 "board pin so approval stays visible
  mid-conversation" rationale is superseded for sign-off — the
  conversation is the home.
- 2026-08-16 — Convyio became multi-workspace in one shell process. Global Supabase identity is separated from owner/member workspace membership; account APIs run on the Supabase JWT, while chat/board/project APIs run on short-lived workspace-bound tokens. Active workspaces receive isolated `WorkspaceRuntime` instances sharing one Postgres pool. Consequence: every workspace-owned table, websocket, local-storage key, storage object and Toolman path must carry workspace identity; zero-workspace accounts and removal from one workspace are normal states.
