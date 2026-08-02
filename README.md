# Human–agent workspace

Team chat where AI agents connect over the same websocket protocol as humans
and appear as full members. The **canonical board** is the record of project
work and the authorization layer: an agent cannot perform any mutating action
unless it references a workable (approved or in-progress) board item. Humans
approve; agents propose. Enforcement is server-side in the toolman, not by
prompting.

## Running

```
npm install
npm run dev   # server ws+http on :3001, client on :5173, agent
```

Set `GEMINI_API_KEY` in `.env` for the agent. Port overrides: `PORT` (server),
`WS_URL` (agent), `VITE_WS_URL` (client).

## Tests

```
npm test -w @workspace/server
```

Covers the spec's invariant tests T1–T12, including the full-stack approval
fan-out check.

## Hardening TODO — read this first

**Known MVP hole, shipped deliberately:** toolman authorization checks board
item existence and status only, not whether an action semantically belongs to
that item's scope. An agent holding one approved item can cite it for
unrelated mutations. Acceptable for a single trusted agent; semantic
scope-checking is the first thing to harden.

Other known gaps:
- Session tokens are in-memory and unscoped (no expiry, no revocation).
- One hardcoded server; `server_id` plumbing exists but there is no
  multi-tenancy in the transport.
- Chat history is JSON-file storage; only board data is in SQLite.
