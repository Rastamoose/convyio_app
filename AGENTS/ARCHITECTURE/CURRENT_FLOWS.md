# Current end-to-end flows

This page describes behavior implemented now, before the target workflow in
`TARGET_WORKFLOW.md`.

## Join and identity

1. A browser or agent opens the websocket and sends `join`.
2. `joinPolicy.ts` verifies a Supabase human session, the server-wide agent
   token, or a paired-agent installation token.
3. `Roster` resolves the persistent actor and workspace membership.
4. `Hub` sends `welcome` with identity, participants, channels, recent chat,
   an HTTP bearer token, API URL and any agent profile.
5. A paired runner reports its harness and configuration revision before the
   server offers it work.

Human identity comes from the verified Supabase user. Agent identity comes
from the admitted token. Request bodies never choose the acting actor.

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

Agent-authored mentions do not currently create work. Board ownership does not
currently dispatch work.

## Current LLM context

1. The server sends an assignment containing its conversation and triggering
   chat message.
2. `AgentRunner` constructs model context locally from `BoardClient.summary()`
   and `Memory.context()`.
3. `Memory` is a rolling fifty-message transcript stored by the runner.
4. The selected `Brain` calls Gemini, Claude SDK or the ACP harness locally.
5. The server does not currently construct or version the model's complete
   context wrapper.

Agents load a cursor-bearing workspace snapshot on join
(`/api/workspace/snapshot`) and merge it with any board envelopes that
arrived while the snapshot was in flight. The welcome frame carries
`snapshotSeq` so later events at or below that sequence are already
represented. The current compact model summary includes owner names when
present; the roster is not yet compiled into every run.

## Board and action authorization

1. An agent creates an inert proposal through the board HTTP API.
2. A human approves or denies it.
3. Approval of the proposing agent's item is observed by that runner's local
   `ProposalLifecycle`, which resumes work from `PendingWork`.
4. For each world action, the agent sends `action_request` with a board item
   reference.
5. `Hub` asks Toolman whether the board item is workable and grants the
   requested path and capability.
6. The conversation permission mode either denies the action, allows it, or
   creates a durable human interaction request.
7. Toolman rechecks authorization and executes inside the workspace sandbox.

The board grant is currently mandatory for every agent mutation. Chat
permission can narrow that grant but cannot independently authorize ad-hoc
work.

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
