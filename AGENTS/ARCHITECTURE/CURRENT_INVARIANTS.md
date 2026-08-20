# Current invariants

These constraints describe the implementation now. A target-architecture file
does not supersede them until the corresponding code change lands.

- Toolman authorization is the agent mutation boundary. No agent write path may
  execute before `Toolman.authorize`; unknown tools fail closed. Server-local
  actions recheck in `Toolman.execute`, while project actions run only after the
  Hub has settled that decision plus assignment, consent and permission mode,
  then route to ToolmanGateway or GitRepositories. `ClaudeBrain` enables only
  read-only native tools, so native Claude Code execution cannot mutate around
  this boundary. ACP denies native mutation kinds the same way, but allows
  classified board/project tools from the local Streamable HTTP MCP bridge.
- Authorization starts with the hard ceiling: identity, sandbox, classified
  tool, and either a workable owned ticket or explicit bounded chat grant.
  Project actions then add assignment/checkout and owner-consent policy. The
  conversation permission mode decides how much of the resulting ceiling runs
  without another prompt and can never widen it. An accepted `ask` owner prompt
  answers that action and avoids a duplicate mode prompt. Plan mode refuses
  mutations before any executor.
- Every ticket starts proposed. Approval is human-only and requires an owner,
  acceptance criteria and a complete impact map. A ticket that omits
  `impactMap` inherits the accepted plan's map; approval still refuses an
  incomplete map. Only the assigned owner may start, mutate, block, unblock
  or complete. Completion requires evidence.
- An accepted Plan may have at most one live ticket. Plan acceptance grants
  no mutating authority. Plans and tickets remember an origin channel and
  origin thread event; later Plan/Ticket events reuse that channel so the
  conversation remains the causal ledger. Adding a constraint updates the
  same Plan, records an attributed change-log entry, and writes a
  plan-scoped context entry rather than a second plan.
- `shell_repo` is coarse because a command's writes are not statically
  knowable, so `scope_paths` cannot bound it and `file_write` never implies it.
  Server-local commands start in the workspace sandbox; local project commands
  start at the assigned mount. Managed Git checkouts refuse arbitrary project
  commands and expose only classified first-class Git actions.
- An action class absent from `ACTION_CAPABILITY` can never be authorized, so a
  newly added tool fails closed until it is deliberately classified.
- If a permission decision cannot be recorded, the action does not run
  (`APPROVAL_UNAVAILABLE`): an unauditable mutation is worse than a refusal.
- Tool subprocesses get a minimal environment. `AGENT_TOKEN`, provider keys and
  the database URL live in the server's `process.env` and must never reach a
  child process or its output.
- Actor identity is never taken from a request body: the ws `join` upserts
  the persistent actor, HTTP derives the actor from the bearer token (I1).
- Every workspace-scoped runtime and store carries one immutable workspace id.
  Chat rows, channels, attachments, plans, board/context/agent work, projects,
  Toolman records, linked Git repositories and branch-channel bindings are
  filtered and constrained by it. GitHub connections are the deliberate
  exception: global actor-owned credentials that a workspace link references.
- HTTP workspace tokens contain both actor id and workspace id; every request rechecks membership. A token issued in one workspace cannot select another.
- Each Hub instance belongs to one `WorkspaceRuntime`, so presence and websocket broadcasts cannot cross workspace boundaries.
- Presence reflects a liveness check, not just close frames. The hub pings every connection on a fixed interval and terminates any that misses two consecutive rounds; termination runs the same `onDisconnect` path as a clean close, so a participant whose process died without closing its socket goes grey on the same code path as one that logged off. Nothing may report a participant online on the strength of an open socket alone.
- The first username claim creates a starter workspace, but a global account with no memberships remains valid after leaving and may create or request another workspace. Removal from one workspace never removes the account or its other memberships.
- `AGENT_TOKEN` cannot choose or create an agent identity. It resolves only the active managed noodle membership in the requested workspace; removing that membership prevents rejoin, and only an owner can restore it.
- Workspace creation writes noodle's deterministic `managed-welcome:*` history once. A member's first join writes one deterministic `member-joined:*` system message; reconnect and noodle restore replay neither record.
- Hosted noodle executes outside the shell. Its manifest is authenticated with the same `AGENT_TOKEN`, and each listed workspace receives an independent websocket connection and state directory.
- Hosted noodle's in-memory guardrail is global to its process: ten runs per hour per human actor across workspaces, with only the first rejected run in a window posting the break message and Add Agent action.
- Only owners manage human membership and invites. A workspace must always retain at least one owner.
- Client drafts and unread cursors include the workspace id in their storage key, and switching workspaces remounts the complete workspace state tree.
- Auth mode is a config switch, not a flag: GOOGLE_AUTH_ENABLED and/or
  EMAIL_AUTH set = sign-in required (the Hub only admits joins its
  `authorizeJoin` gate resolves — humans by a verified Supabase session, agents by
  AGENT_TOKEN — and ignores client-supplied human names); neither set = the
  server refuses every join and the client shows a "contact support" dead end.
  The two sign-in methods share one Supabase Auth-backed `Auth` layer; either,
  both, or neither can be on.
- Every board mutation writes exactly one `board_events` row in the same
  transaction (I5) and fans out exactly one `{channel:"board"}` envelope.
- Tickets always carry `scope_paths` (enforced at creation). An entry ending
  in `/` grants a subtree; anything else is exactly that file. Chat grants
  stay inside the workspace sandbox but do not invent a board scope.
- Server-local Toolman actions and managed Git checkouts live under
  `data/workspaces/<sha256(workspace-id)>/`; managed repositories use its
  `repositories/` child. Paired node credentials resolve one workspace
  server-side; project, opaque mount, assignment and execution records remain
  workspace-scoped, while concrete local paths stay only on the node.
- A Toolman folder's creator exclusively controls device revocation, agent
  assignments, assignment revocation, access-request decisions, folder policy
  and direct human file management. Other workspace humans receive no implicit
  local-folder authority.
- Folder policy is independent of action authority: `deny` always refuses;
  `ask` requires the owner online and prompts once per agent conversation;
  `always` is durable folder consent while the assigned node remains available.
  Policy never bypasses the owned ticket or bounded chat grant, project/path/
  capability checks, Plan mode, or the conversation permission mode.
- Agents discover shared projects and their assignment/request state through
  provider-neutral tools. Claude and ACP use the current run's scoped Toolman
  executor for every mutation; their native filesystem and shell paths remain
  read-only. Paired ACP agents receive those tools only over Streamable HTTP
  MCP (`LocalMcpBridge`); a `/tools`/`/call` HTTP stub is not MCP and is not
  sufficient.
- Toolman reconnects with bounded backoff and a connection timeout. One node
  has one live authenticated socket; unpair or revocation evicts the previous
  socket, revoked mounts cannot execute, unauthenticated result frames are
  rejected, and disconnect fails in-flight executions closed. A revoked
  credential never appears to run while disconnected: startup and reconnect
  authentication fail with an actionable re-pair instruction. Re-pairing the
  same owner/device name rotates the token and reactivates the existing node;
  another human cannot claim that name.
- Individual mount removal is owner- or installation-authenticated. It never
  deletes local files, clears only assignments bound to that mount, preserves
  execution history, and archives a directory project only when no mounts
  remain.
- Revocation and permanent device deletion are distinct. Revocation invalidates
  and disconnects the credential but preserves the node, mounts and project
  identity for same-owner repair. Permanent deletion is owner-only and refused
  until the node is revoked; it removes the node and all remaining mounts/
  mount-bound assignments, nulls historical execution references instead of
  deleting history, and leaves device files untouched.
- GitHub connection state is random, SHA-256-hashed at rest, expires after 15
  minutes and is atomically single-use in Postgres; it survives shell restarts
  and cannot be replayed across replicas. The callback's one-use user token is
  used only to prove that the installation belongs to that user, then discarded.
  The durable record contains actor, installation id and permissions—not a
  GitHub token. API/Git transport mints cached one-hour installation tokens from
  a short-lived App JWT; tokens never enter browser, agent, repository remote,
  generic command, event or log state.
- Human Git APIs require a current workspace session; agents cannot call them
  and instead require explicit project assignment plus Toolman and owner-consent
  gates. Linking a private repository deliberately shares its readable forge
  projection with current human members of that workspace.
- Managed Git transport accepts only credential-free `https://github.com/…`
  repository URLs, disables repository hooks and credential helpers during
  authenticated transport, and addresses the stored provider URL rather than
  mutable `origin`. File access rejects traversal, symlinks, sensitive names
  and files over the shared limit.
- Each managed non-default branch has at most one active workspace channel.
  Branch creation creates/reactivates it; branch deletion, repository unlink or
  pull-request merge archives it. Unlink preserves project/event attribution
  and a later relink reuses the same project id.
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
