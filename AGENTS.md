# Project notes

Monorepo (npm workspaces): `packages/shared` (types + wire protocol), `packages/server` (ws hub + HTTP board API, SQLite workspace store, toolman, demo orchestrator), `packages/client` (React/Vite/Tailwind v4), `packages/agent` (Gemini agent). See `ARCHITECTURE.md` for the unit map and recorded decisions.

## Commands
- Run everything: `npm run dev` (server ws+http on localhost:3001, client http://localhost:5173, agent)
- Typecheck: `npm run typecheck` (all packages) or `npx tsc --noEmit -p packages/<name>`
- Tests: `npm test` (all packages) — server suite holds invariants T1-T12 + pressure + hardening; client uses vitest, the rest node:test
- Client build: `npm run build -w @workspace/client`
- Env overrides: `PORT`, `CORS_ORIGIN`, `DATA_DIR`, `GOOGLE_CLIENT_ID`, `EMAIL_AUTH`, `AGENT_TOKEN`, `CLIENT_DIST` (server), `WS_URL`, `AGENT_TOKEN` (agent), `VITE_WS_URL` (client). Useful when something else holds 3001.
- One `.env` at the repo root (see `.env.example`) feeds `npm run dev` for all three processes: server/agent `config.ts` load it explicitly via `dotenv.config({ path: <repo root>/.env })` (npm workspaces run scripts with cwd = the package dir, so a bare `dotenv.config()` misses it), and `packages/client/vite.config.ts` sets `envDir` to the repo root so `VITE_*` vars resolve the same way. Docker Compose doesn't need any of this — it injects `.env` as real container env vars.
- Deploy: `DEPLOY.md` — one origin in production (server serves the built client), Dockerfile/compose at root.

## Architecture invariants
- One SQLite file (`data/board.db`: actors, messages, board_items, append-only board_events) is the workspace store. The board is a permission boundary: `authorizeMutation` in `packages/server/src/board/Toolman.ts` refuses any mutating agent action without a workable (approved/in_progress) board item whose `scope_paths` cover the target path. Tools not known read-only are treated as mutating (fail closed). Do not add agent write paths that bypass it.
- Agent proposals must declare `scopePaths` (400 SCOPE_REQUIRED otherwise); an entry ending in `/` grants a subtree, anything else exactly that file. Human items may omit scope (explicit unrestricted grant); humans can narrow/widen scope via PATCH.
- Item statuses: proposed → approved/denied; approved → in_progress → blocked/done; done → approved (reopen). Humans create (auto-approved) and approve/deny/edit/delete over the HTTP API (`/api/board/items`, plus `/api/actors` and `/api/board/items/:id/events`); agents only propose. I1/I2 assertions live in `BoardService` and are tested — never trust actor identity from a request body.
- Every board mutation writes exactly one `board_events` row in the same transaction and fans out a `{channel:"board", type:"item.*"}` envelope on the websocket.
- Auth: ws `join` upserts a persistent actor; the `welcome` frame carries a bearer token (12h TTL, revoked when a human's last connection closes) + apiUrl, plus the channel list. CORS is locked to `CORS_ORIGIN` (default the Vite dev URL).
- Sign-in: setting `GOOGLE_CLIENT_ID` and/or `EMAIL_AUTH=1` flips the server into auth mode — humans must present an `auth_sessions` token in the ws `join` (obtained via `/api/auth/google` + one-time username pick at `/api/auth/username`, or `/api/auth/email-signup` / `/api/auth/email-login`), agents must present `AGENT_TOKEN`; client-supplied names are ignored for humans (I1). Both unset = the guest-name flow, unchanged, for dev/tests/demo.
- Toolman file actions are sandboxed to `data/workspace/`.
- Agent presence semantics: green=working, orange=idle, red=blocked on a human, grey=offline. Agent restart recovery: pending proposal work is persisted (`data/agents/<name>/pending-work.json`) and swept against the board snapshot on rejoin.
- The client composes per-domain hooks under a `WorkspaceContext`; components take workspace data/actions from context and navigation callbacks as props. Board ops are optimistic with rollback; failures surface as toasts.
- Scripted demos: JSON scripts in `packages/server/assets/demo/scripts/` (schema in `src/demo/script.ts`), played by `DemoOrchestrator` through the real hub/board pipeline. There is no client-side demo fallback — demos need a running server and agent. Seed fixtures live in `assets/demo/seed/`.
