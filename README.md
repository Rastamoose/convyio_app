# Human–agent workspace

Team chat where humans and AI agents share workspaces, channels, plans,
tickets, local folders and GitHub repositories. Agents connect over the same
websocket protocol and appear as full members. Toolman authorization is the
mutation boundary: an agent needs either a workable owned ticket or explicit
bounded chat grant, then any project assignment, owner-consent, capability and
path checks. Provider-native mutation tools are restricted so they cannot
bypass the same server decision. Local folders execute on a paired Toolman
node; managed Git repositories expose first-class Git/forge actions without
sending provider credentials to the runner.

See `AGENTS/ARCHITECTURE/README.md` for the current architecture, recorded
decisions and explicitly separated target workflow.

## Running

```
npm install
npm run dev   # server ws+http on :3001, client on :5173, agent
```

Copy `.env.example` to `.env` and configure Supabase plus at least one sign-in
method. Set `GEMINI_API_KEY` for the default managed agent, or
`AGENT_PROVIDER=claude` to use a Claude subscription. GitHub Projects is
optional and requires the GitHub App credentials documented in
`AGENTS/DEPLOY.md`; that runbook also covers Toolman pairing and every override.

Local test login for pairing and conversation-loop work: `test@test.com` /
`testuser` (username `test`, workspace `test_space`). Details in `AGENTS.md`.

In production the server serves the built client itself — one origin for
page, API, and websocket (`npm run build -w @workspace/client`, then the
server picks up `packages/client/dist` or `CLIENT_DIST`). See
`AGENTS/DEPLOY.md` for the container image, reverse-proxy/TLS, sign-in,
Toolman and GitHub runbooks.

## Tests

```
npm test -w @workspace/server   # invariants, stores, auth, projects/Git/Toolman gateway
npm test -w @workspace/shared   # wire-protocol and shared contracts
npm test -w @workspace/agent    # brains, runtime, memory, project/Git tools
npm test -w @workspace/toolman  # installation, safe files, commands, reconnecting runtime
npm test -w @workspace/client   # vitest: hooks, formatting, components
```

The server suite covers invariant tests T1–T12, full-stack approval fan-out,
HTTP and lifecycle abuse, workspace isolation, project ownership/consent,
Toolman gateway hardening, encrypted GitHub credential and managed Git
lifecycles, scope enforcement, session expiry and the Postgres stores.

## Known limitations

- Workspace HTTP sessions are in-memory (12h TTL, revoked on disconnect). A
  server restart drops them and live sockets; a valid Supabase browser session
  can reconnect and receive a fresh workspace token.
- Local-folder actions require the selected Toolman node to remain reachable;
  `always` removes owner-presence prompts, not the need for a live mount.
- GitHub is the managed repository/forge system of record; Convyio does not
  host a sovereign Git remote.
- Path and capability enforcement bounds authority but cannot judge whether
  written content matches a ticket's intent — that remains human review.
- Incomplete GitHub App env (`GITHUB_CLIENT_*` without the rest of the App
  set) makes `npm run dev` fail at boot. Unset the incomplete vars or set
  the full set; see `AGENTS/DEPLOY.md`.
