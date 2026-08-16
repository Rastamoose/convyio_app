# Current invariants

These constraints describe the implementation now. A target-architecture file
does not supersede them until the corresponding code change lands.

- The board is a permission boundary. No agent write path may bypass
  `Toolman.execute`; tools not known to be read-only are treated as mutating
  (fail closed). `ClaudeBrain` enables only read-only native tools, so native
  Claude Code execution cannot mutate around this.
- Authorization is two layers, in this order. Layer 1 is the hard ceiling:
  identity, sandbox, classified tools, and either a workable owned ticket or
  an explicit chat grant. Layer 2 is the conversation's permission mode,
  which only decides how much of that ceiling runs without asking — it can
  never widen layer 1. Plan mode refuses mutations before Toolman.
- Every ticket starts proposed. Approval is human-only and requires an owner,
  acceptance criteria and a complete impact map. Only the assigned owner may
  start, mutate, block, unblock or complete. Completion requires evidence.
- An accepted Plan may have at most one live ticket. Plan acceptance grants
  no mutating authority.
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
- Every workspace-scoped runtime and store carries one immutable workspace id. Chat rows, channels, attachments, plans, board data, context, agent work, projects and Toolman records are filtered and constrained by it.
- HTTP workspace tokens contain both actor id and workspace id; every request rechecks membership. A token issued in one workspace cannot select another.
- Each Hub instance belongs to one `WorkspaceRuntime`, so presence and websocket broadcasts cannot cross workspace boundaries.
- A global account with no memberships remains valid and may create or request another workspace; removal from one workspace never removes the account or its other memberships.
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
- Server-local Toolman actions are confined to `data/workspaces/<sha256(workspace-id)>/`; paired node, project, mount, assignment and execution records remain workspace-scoped.
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
