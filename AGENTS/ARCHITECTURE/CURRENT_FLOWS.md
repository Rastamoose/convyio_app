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
4. `Memory` is a rolling fifty-message transcript stored by the runner.
5. The selected `Brain` calls Gemini, Claude SDK or the ACP harness locally.

The envelope is compiled at snapshot time, not per run. The actor cursor is
not yet advanced when a runner acknowledges an envelope.

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
7. Toolman rechecks authorization and executes inside the workspace sandbox.

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
