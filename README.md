# Human–agent workspace

Team chat where AI agents connect over the same websocket protocol as humans
and appear as full members. The **canonical board** is the record of project
work and the authorization layer: an agent cannot perform any mutating action
unless it references a workable (approved or in-progress) board item whose
declared `scope_paths` cover the target path. Humans approve; agents propose.
Enforcement is server-side in the toolman, not by prompting (except the
optional `AGENT_PROVIDER=claude` mode — see `AGENTS/ARCHITECTURE.md`).

See `AGENTS/ARCHITECTURE.md` for the unit map and recorded design decisions.

## Running

```
npm install
npm run dev   # server ws+http on :3001, client on :5173, agent
```

Set `GEMINI_API_KEY` in `.env` for the agent (default provider), or set
`AGENT_PROVIDER=claude` to run it against a Claude subscription instead — see
`AGENTS/DEPLOY.md` for what that requires. Env overrides: `PORT`, `CORS_ORIGIN`,
`DATA_DIR` (server), `WS_URL` (agent), `VITE_WS_URL` (client).

In production the server serves the built client itself — one origin for
page, API, and websocket (`npm run build -w @workspace/client`, then the
server picks up `packages/client/dist` or `CLIENT_DIST`). See
`AGENTS/DEPLOY.md` for the container image, reverse-proxy/TLS, and Google
Sign-In runbook.

## Tests

```
npm test -w @workspace/server   # invariants T1-T12, pressure suite, hardening suite
npm test -w @workspace/shared   # wire-protocol validation
npm test -w @workspace/agent    # memory, pending work, tool executor
npm test -w @workspace/client   # vitest: hooks, formatting, components
```

The server suite covers the spec's invariant tests T1–T12 (including the
full-stack approval fan-out check), HTTP edge cases, approve/deny races,
sandbox traversal, lifecycle abuse, scope enforcement, session expiry, and
the Postgres chat store.

## Known limitations

- Sessions are in-memory (12h TTL, revoked on disconnect); a server restart
  logs everyone out.
- One workspace: a single `workspaces` row (named `test_space`) with
  membership plumbed through the data model, but no multi-tenancy in the
  transport.
- Scope enforcement is path-based. It bounds an item's footprint precisely,
  but the toolman does not judge whether the *content* written matches the
  item's intent — that remains the human reviewer's job.
