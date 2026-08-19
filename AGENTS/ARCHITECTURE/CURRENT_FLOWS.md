# Current end-to-end flows

This page describes behavior implemented now, before the target workflow in
`TARGET_WORKFLOW.md`.

## Account, workspace selection and join

1. Supabase authenticates the browser and the server binds one global human actor/username.
2. The first username claim—manual or from `desired_username` metadata—creates `{username}'s workspace` with that actor as owner.
3. `GET /api/account` returns every workspace membership and access request. Zero memberships is valid after leaving.
4. A pending invite continues before the client automatically opens a sole membership. Otherwise the human opens a membership or uses the lobby to create another workspace or request access.
5. The browser connects to `/ws/:workspaceId`; the join gate verifies the Supabase token and that exact membership.
6. `WorkspaceRegistry` resolves or creates the workspace runtime. Its Hub sends workspace-only roster, channels, history and a workspace-bound HTTP bearer token.
7. Switching changes `/w/:workspaceId`, closes the old socket, unmounts its provider and creates a fresh workspace session.

Agent and Toolman pairing codes resolve the workspace from their server-side records. A presented credential cannot choose or widen its workspace.

## Workspace access

A public workspace code is a locator, not authority. Submitting it creates one idempotent pending request; an owner approval inserts membership and resolves the request in the same transaction. Invite tokens are hashed at rest, expire after seven days, are revocable and may be consumed by one actor. Membership and role changes retain actor history and append attributed workspace events. A member's first membership insertion also writes a durable `member-joined:{workspaceId}:{actorId}` system message. Reconnects and noodle restore do not write another.

## Workspace creation and hosted noodle

Workspace creation atomically inserts the workspace, owner membership, `#general`, the managed noodle actor and membership, both join notices, and three welcome messages. Stable `member-joined:*` and `managed-welcome:*` ids make those messages one-time history.

The authenticated `/api/hosted-agent/workspaces` manifest lists only workspaces where noodle remains a member. The separate hosted runner maintains one connection and data directory per listed workspace and closes a connection when that membership disappears. Owner restore re-adds only the existing membership; it does not replay the join notice or welcomes.

## Chat and durable agent work

1. `Hub.postMessage` derives authorized agent mentions from a human-authored
   message.
2. `MessageStore` writes the message while `AgentWorkStore` creates one durable
   run request per mentioned agent in the same transaction.
3. The server sends `work_available` to an online ready runner.
4. The runner claims request ids and receives hydrated assignments.
5. The runner emits activity and a final result; the server persists the
   resulting events and optional agent message.
6. Claimed work is requeued when the agent reconnects.

Agent-authored mentions do not currently create work. Approving a ticket
whose owner is an agent queues a durable run request for that owner.

## Current LLM context

1. The server sends an assignment containing its conversation and triggering
   chat message.
2. On join the runner loads `/api/workspace/snapshot` and, when available,
   `/api/workspace/prompt-envelope`.
3. `BoardClient.summary()` renders that envelope (policy, actor, plans,
   live tickets, members, context) when one was loaded; otherwise it falls
   back to a local item list.
4. `BoardClient` also loads the agent's project catalogue, assignment and
   pending-request projection. Provider-neutral tools can list projects and
   file an owner-targeted access request; neither action grants access.
5. `Memory` is a rolling fifty-message transcript stored by the runner.
6. The selected `Brain` calls Gemini, Claude SDK or the ACP harness locally.

The envelope is compiled at snapshot time, not per run. The actor cursor is
not yet advanced when a runner acknowledges an envelope.

## Toolman folder sharing and collaboration

1. A human creates a one-time Toolman pairing in Resources. The local CLI
   exchanges it for a workspace-bound installation token, registers one or
   more folders by opaque mount id, and keeps every absolute path on-device.
2. A mounted folder becomes a workspace project owned by the human who paired
   the node. Device and project names cannot be claimed by another human.
3. The owner assigns a specific workspace agent to a specific mount, or an
   agent discovers the project with `project_list` and submits
   `project_request_access`; only the owner can resolve that request.
4. The owner independently sets folder policy: `deny` refuses, `ask` requires
   the owner online and prompts once per agent conversation, and `always` is
   durable folder consent while the node is connected. None of these modes
   widens board/chat authority or the conversation permission mode.
5. Every agent project action first passes Toolman authorization, assignment
   and checkout checks, then folder policy. File writes may use an owned
   workable project-bound ticket or a bounded chat grant; shell and Git
   mutations additionally require `shell_repo`.
6. The server records the execution and routes an already-authorized local
   action to the assigned live node. The node confines list/read/search/write/
   edit/move/delete operations to the mounted folder and protects sensitive
   names, symlinks, traversal and output/file-size limits.
7. The project owner may browse, create, edit and delete local files directly
   from Resources over owner-only workspace HTTP routes; other humans receive
   no implicit folder authority.
8. The Toolman process reconnects with bounded backoff after network or shell
   restarts and counts itself connected only after `toolman_welcome`.
   Re-pairing, unpairing or owner revocation disconnects the old socket;
   revoked mounts cannot execute and in-flight work fails closed.

## GitHub repositories

1. A human starts server-owned GitHub OAuth from a workspace. Random in-memory
   state binds actor, workspace, callback and browser return origin. The server
   exchanges the code and stores AES-256-GCM encrypted access/refresh tokens on
   the global actor; expiring access tokens rotate under one refresh lock.
2. The human selects a GitHub repository. The server accepts only a
   credential-free `https://github.com/…` clone URL, creates or reactivates one
   workspace Git project and clones an isolated managed checkout under the
   workspace's hashed `DATA_DIR` directory.
3. Humans use Projects for overview/import, remote or working-tree files,
   branches, commits, sync state, pull requests/checks/changed files and issues.
   Unlink archives the project, assignments and branch rooms, removes its
   checkout, and supports later relink to the same project id.
4. Agents use the same project catalogue, assignment and owner-consent flow as
   local folders. Managed checkouts expose first-class status, fetch, pull,
   push, branch and commit actions; arbitrary project commands are refused
   there and require a paired local Toolman checkout. Provider credentials
   never enter agent, browser, remote URL or generic command state.
5. Creating a non-default branch creates a linked chat channel. Deleting the
   branch or merging its pull request archives that channel; Projects can jump
   directly into the room.

## Board and action authorization

1. Substantial work starts as a Plan. A human accepts it once; acceptance
   grants no mutating authority.
2. The next ticket is created against that accepted plan. Every ticket starts
   proposed, including human-created ones.
3. A human approves the ticket with an owner, acceptance criteria and a
   complete impact map. The server then queues work for an agent owner.
4. For each world action, the agent sends `action_request` with a board item
   reference, or without one for an explicit chat grant.
5. `Hub` asks Toolman whether the action is authorized. A ticket mutation
   still requires a workable owned item. A chat grant still fails closed on
   unclassified tools and path escape.
6. The conversation permission mode either denies the action, allows it, or
   creates a durable human interaction request. Modes never override the
   hard ceiling.
7. `Toolman.execute` rechecks server-local actions before the workspace
   sandbox. Project actions run only after the Hub has settled that same hard
   decision plus assignment/consent/mode, then route to the assigned Toolman
   mount or managed Git checkout without exposing credentials or absolute paths.

## Approval surfaces

A human decision is made in the conversation. Proposed items render as
live proposal cards in the chat timeline; a paused run's permission
prompt renders on that run, or as its own timeline card if the run is
not visible. The AppBar queue and the Board tab are other views of the
same records — they do not mint a second copy of the question.

An `item.proposed` envelope therefore does not also become a chat
system line. Later board events (`item.approved`, `item.denied`, and
so on) still do.

## Board synchronization

Every board mutation updates the item and appends one `board_events` audit row
plus one canonical `thread_events` row in the same transaction. After commit,
the server broadcasts the updated item to every websocket participant.

Clients and agents separately project those envelopes into local board state.

## Workspace event ledger

`thread_events` is the canonical append-only workspace event stream. Every row
has a monotonic sequence, actor provenance, optional channel, conversation,
run and subject relationships, and a JSON payload.

The stream is currently used for activity history and audit. It is not yet
compiled into per-agent shared context.
