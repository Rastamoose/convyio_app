# Project notes

Monorepo (npm workspaces): `packages/shared` (types + wire protocol), `packages/server` (ws hub + HTTP board API, SQLite board, toolman), `packages/client` (React/Vite/Tailwind v4), `packages/agent` (Gemini agent).

## Commands
- Run everything: `npm run dev` (server ws+http on localhost:3001, client http://localhost:5173, agent)
- Typecheck a package: `npx tsc --noEmit -p packages/<name>`
- Server tests (invariants T1-T12): `npm test -w @workspace/server`
- Client build: `npm run build -w @workspace/client`
- Port overrides: `PORT` (server), `WS_URL` (agent), `VITE_WS_URL` (client). Useful when something else holds 3001.

## Architecture invariants
- The board (SQLite at `data/board.db`: actors, board_items, append-only board_events) is a permission boundary: `authorizeMutation` in `packages/server/src/board/Toolman.ts` refuses any mutating agent action without a workable (approved/in_progress) board item. Tools not declaring `mutating` are treated as mutating (fail closed). Do not add agent write paths that bypass it.
- Item statuses: proposed → approved/denied; approved → in_progress → blocked/done; done → approved (reopen). Humans create (auto-approved) and approve/deny/edit/delete over the HTTP API (`/api/board/items`, plus `/api/actors` for owner assignment and `/api/board/items/:id/events` for the per-item audit feed); agents only propose. I1/I2 assertions live in `BoardService` and are tested — never trust actor identity from a request body.
- The client renders the board as a full kanban tab (Chat | Board in the TopBar): Proposed · To do · In progress · Blocked · Done columns, card detail drawer with inline edit/owner/activity. Agent restart recovery: pending proposal work is persisted (`data/agents/<name>/pending-work.json`) and swept against the board snapshot on rejoin.
- Every board mutation writes exactly one `board_events` row in the same transaction and fans out a `{channel:"board", type:"item.*"}` envelope on the websocket.
- Auth: ws `join` upserts a persistent actor and the `welcome` frame carries a bearer token + apiUrl for the HTTP API.
- Toolman file actions are sandboxed to `data/workspace/`.
- Agent presence semantics: green=working, orange=idle, red=blocked on a human, grey=offline.
