# Target architecture: planning, work and shared context

> Status: agreed architectural direction. Tickets 1–8 have landed in
> current-state pages; remaining gaps are per-run envelope compilation,
> cursor acknowledgement, and fuller provider-tool unification.
> Current behavior remains defined by the `CURRENT_*.md` pages.

## Goal

Convyio contains isolated shared workspaces. Within each workspace, humans and agents use the same identity, message, ownership, work and event records; workspace membership and runtime state never cross into another workspace. The agent tag and agent-only execution tools should be the meaningful differences.

Features must be designed across the ecosystem rather than inside package
silos. Planning and ticket approval therefore require an explicit impact map
covering shared protocol, server, client, agent harnesses, database and
security, deployment, tests, demos and documentation. A reasoned `N/A` is a
valid assessment.

## Relationship map

```text
human or agent message
        │
        ▼
Convyio shell
  ├── records the workspace event
  ├── classifies/binds the work workflow
  ├── compiles canonical shared context
  └── dispatches only authorized work
        │
        ├── megaplan ──► Plan ──► next Ticket ──► approved owner
        │
        └── ad-hoc ────► chat grant ────────────► authorized agent
                                                │
                                                ▼
                                         paired runner
                                                │
                                                ▼
                                           LLM provider
                                                │
                                                ▼
                                    Toolman + server hard ceiling
                                                │
                                                ▼
                                         workspace ledger
```

The shell brokers calls to the selected paired runner. The runner uses its
owner's provider credentials. Other authorized workspace members may invoke
that agent through the shell without receiving those credentials.

## Work classification

Every addressed task is classified before its first mutation.

A task is megaplan work when it has dependent steps, crosses ecosystem
surfaces, needs multiple owners, contains material design uncertainty, or the
human explicitly asks for planning or a megaplan.

A task is ad-hoc when it has one bounded outcome, one responsible actor, no
dependent ticket sequence and a scope suitable for one conversational run.

Ambiguous work requires a clarifying question. Classification is recorded with
provenance and rationale. Prompt policy guides the semantic choice; server
records and authorization enforce the selected workflow.

## Megaplan workflow

1. Planning is read-only and asks at least one clarifying question.
2. A persistent Plan records the objective, definition of done, ordered
   outline, constraints, decisions, impact map and expected responsibilities.
3. A human accepts the Plan once. Acceptance grants no execution authority.
4. Only the next executable Ticket is created conversationally.
5. Every Ticket begins proposed, including a human-created Ticket.
6. Approval requires a human decision, owner, explicit scope and capabilities,
   impact map and acceptance criteria.
7. At most one non-terminal Ticket exists for a Plan.
8. The server dispatches an approved Ticket only to its owner.
9. Only the owner may start, block, complete or execute against it.
10. Completion requires a summary and verification evidence mapped to the
    acceptance criteria.
11. The next Ticket is created only after the current Ticket is terminal.
12. A fundamental objective change creates a replacement Plan; discoveries
    that do not change the objective are appended as decisions or context.

Changing owner, scope, capabilities or acceptance criteria after approval
revokes that approval and requires another explicit human decision.

## Ad-hoc workflow

Small direct work does not create board noise. It uses a durable chat grant
bound to the agent, conversation/run, declared scope and capabilities.

- Manual approval creates one-use action grants.
- Accept Edits covers declared file edits; shell and network actions still ask.
- Approve All covers all capabilities declared for the current bounded task.
- Bypass skips ordinary prompts by automatically recording the ad-hoc grant.
- Plan mode permits planning records but no world mutation.

These choices affect prompting, not the hard ceiling. They never override
identity, ticket ownership, accepted scope, sandboxing, secret isolation,
unknown-tool fail-closed behavior or destructive-action rules.

For Plan-bound work, even Bypass still requires the approved owned Ticket.

## Assignment and handoff

Assignments are durable server records, not local agent memory.

An agent may propose that another agent own work, but the handoff is inert
until a human approves the Ticket and owner. The server then dispatches the
responsible runner idempotently and recovers undispatched approved work after
restart.

Agent-authored mentions do not directly authorize or dispatch mutations.

## Workspace ledger

The existing sequenced `thread_events` stream remains the immutable record of
everything that happened. It is extended with Plan, Ticket, grant, assignment,
classification, policy and contextual events rather than replaced by a second
event log.

Canonical projections hold current Plans, Tickets, ownership, roster,
permissions and active context.

A durable context entry records one shared decision, constraint, fact, blocker,
handoff or summary. Humans and agents write the same entry type. Actor and
source provenance remain visible; entries do not grant authority and are
superseded rather than silently rewritten.

## Prompt policy

The shell owns versioned, boot-validated policy files:

- `packages/server/assets/policy/agent-workflow.json`
- `packages/server/assets/policy/context-selection.json`

The workflow policy defines instruction precedence, work classification,
megaplan behavior, ecosystem review, ticket behavior and permission behavior.

The context policy defines section budgets, event materiality, scope,
priorities, compaction and retention.

Every run records the policy versions and hashes it received. Agent profile
instructions are subordinate to platform policy. Workspace records and
agent-authored context are presented as attributed data, never as instructions
that may override policy.

## Prompt envelope

Before each LLM call, the server constructs a typed Prompt Envelope containing:

1. platform policy and version;
2. workspace identity and event cursor;
3. the calling actor and responsibilities;
4. compact active Plan, Ticket, owner and blocker state;
5. relevant active context entries;
6. material changes since that agent's acknowledged cursor;
7. current conversation and trigger;
8. current work classification, permission mode and authorization source.

The paired runner passes this envelope through the provider's role hierarchy.
It does not independently choose which workspace truth to inject.

## Context selection

Every event is retained; very few events are placed in a prompt.

Always include:

- platform policy;
- current assignment and authorization;
- active accepted Plans;
- live Tickets, owners and blockers;
- relevant active context entries.

Include as unseen material changes:

- Plan acceptance, completion or cancellation;
- Ticket proposal, approval, reassignment, blocking or completion;
- responsibility changes;
- context creation or supersession;
- relevant human decisions and permission denials;
- member removal that affects active work.

Do not inject routine trace deltas, tool progress, token usage, typing,
reactions or unrelated channel chatter.

Multiple changes to one entity collapse into its final meaningful update.
Completed and denied history remains queryable through tools instead of being
replayed on every call.

Context priority is:

1. policy;
2. current work and hard authorization;
3. active Plan/Ticket/owner state;
4. durable context;
5. unseen material changes;
6. conversation history;
7. historical summaries.

Lower-priority sections are trimmed first. Policy, current authority,
ownership and blockers are never removed.

## Context cursor

Each agent has a durable acknowledged workspace-event cursor.

The server builds an envelope through a specific sequence and records that
range on the run. The cursor advances only after the runner acknowledges the
envelope. A failed or disconnected run receives the missed material changes
again.

The current canonical projection is sent on every call, so dropped
low-priority history cannot make current state stale.

Idle agents are not awakened for every event. Their server-side state remains
current, and their next invocation receives the latest projection plus
material changes since their cursor. Only the responsible agent is dispatched.

## Enforcement boundary

Prompt policy governs cooperative planning and classification behavior.
Security and authority remain server-side:

- verified actor identity;
- explicit human decisions;
- owner-bound Ticket or chat grant;
- current status, scope and capabilities;
- sandbox boundaries;
- minimal child-process environment;
- unknown actions fail closed;
- destructive operations cannot inherit ordinary Bypass behavior;
- every transition and permission decision is audited.

A model cannot be trusted as the sole enforcement mechanism, and policy text
is not secret from a user-controlled runner.

## Delivery order

The target lands through separately approved vertical tickets:

1. canonical sequenced snapshot and context-plane foundation;
2. Plan lifecycle;
3. Ticket lifecycle and owner enforcement;
4. chat grants and permission policy;
5. server-owned dispatch and removal of local proposal resumption;
6. server-built Prompt Envelopes and shared context;
7. provider-neutral Gemini, Claude and ACP tools;
8. Plan-oriented client and approval UX;
9. demos, migration verification and current-state documentation updates.

Each ticket leaves one working path. Temporary compatibility code must name
the exact later ticket that removes it.
