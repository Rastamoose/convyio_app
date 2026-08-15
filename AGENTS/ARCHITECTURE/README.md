# Architecture

This directory is the canonical map of Convyio's architecture. Start here
before changing a package boundary, durable record, authorization rule,
agent workflow, or cross-package protocol.

## Status

The distinction between current and target architecture is mandatory:

- `CURRENT_*.md` describes behavior that exists in the code now.
- `DECISIONS.md` records why consequential choices were made, including
  decisions later superseded.
- `TARGET_WORKFLOW.md` describes the agreed planning, ticket, permission and
  shared-context direction. It is not evidence that those units exist yet.

Never use target architecture as authority for current behavior. Check the
current-state pages and then verify the implementation.

## System map

```text
browser client ── websocket + HTTP ──┐
                                     │
                                     ▼
                              Convyio shell
                       server, database, policy,
                       authorization and dispatch
                                     │
                                     │ websocket + HTTP
                                     ▼
                              paired agent runner
                                     │
                                     ▼
                               LLM provider

Convyio shell ── direct Postgres / Auth / Storage ── Supabase
```

Humans and agents are workspace actors represented by the same identity,
message, ownership and event records. Agents additionally have a paired runner
and controlled tools.

The shell brokers work to an authorized agent runner. Provider calls execute
in the runner using its owner's credentials; the shell does not host user
agents or receive provider credentials.

## Directory

| File | Read when |
| --- | --- |
| `CURRENT_UNITS.md` | Locating the current owner of behavior or changing package boundaries |
| `CURRENT_FLOWS.md` | Changing an end-to-end flow across processes or stores |
| `CURRENT_INVARIANTS.md` | Changing authorization, identity, persistence, events or client state |
| `DECISIONS.md` | A current choice looks surprising or is being reconsidered |
| `TARGET_WORKFLOW.md` | Working on the canonical board, agent planning, permissions, dispatch or shared context |

## Dependency direction

The repository has four npm workspaces:

```text
shared
├── server
├── client
└── agent
```

`shared` depends on nothing. `server`, `client`, and `agent` depend only on
`shared`. Client and agent communicate with the server over the shared
websocket protocol and HTTP API; they never import server implementation.

## Documentation rules

- Current-state pages are descriptive, not aspirational.
- Target pages must carry an explicit not-implemented warning.
- A change that makes a current-state page false includes its documentation
  update in the same change.
- Record durable relationships and decisions, not directory listings that can
  be discovered from the source tree.
- Documentation edits require the user's exact wording approval before they
  are written.

Related documents:

- `../AGENTS_PROGRAMMING_STANDARD.md` — acceptance criteria for code changes.
- `../DESIGN.md` — client visual language.
- `../DEPLOY.md` — deployment and environment configuration.
