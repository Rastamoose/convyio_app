# Deploying

One container (or one Node process) serves everything on one origin: the
built client, the HTTP API, and the websocket all on port 3001. Clients
derive every URL from the origin they loaded the page from, and the server
derives `welcome.apiUrl` per connection from the `Host` /
`X-Forwarded-Proto` headers — no baked-in hostnames anywhere.

## Environment

| Variable                    | Used by | Default                    | Meaning                                                                 |
| ---------------------------- | ------- | --------------------------- | ------------------------------------------------------------------------ |
| `PORT`                      | server  | `3001`                     | HTTP + websocket port.                                                  |
| `DATA_DIR`                  | server  | `./data` (`/data` in image)| Agent file/bash-tool sandbox only (`Toolman`) — the database and uploads live in Supabase, not here. |
| `SUPABASE_URL`              | server  | — (required)                | Supabase project URL.                                                    |
| `SUPABASE_SECRET_KEY`       | server  | — (required)                | Secret (service-role) key: verifies user JWTs and reads/writes Storage server-side. Never expose to the client. |
| `SUPABASE_DB_URL`           | server  | — (required)                | Postgres connection string (Supabase project settings → Database).      |
| `VITE_SUPABASE_URL`         | client  | — (required)                | Same project URL, exposed to the browser bundle.                        |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | client  | — (required)            | Supabase publishable (public) key — safe to expose, used for browser sign-in. |
| `GEMINI_API_KEY`            | agent   | —                          | Enables the agent when `AGENT_PROVIDER=gemini` (the default); unset = no agent starts under that provider. Not needed for `AGENT_PROVIDER=claude`. |
| `AGENT_NAME`                | agent   | `noodle`                   | The agent's display name.                                               |
| `AGENT_MODEL`               | agent   | `gemini-2.5-flash`         | Model id — Gemini model for the gemini provider, `claude-sonnet-5` default for the claude provider. |
| `AGENT_PROVIDER`            | agent   | `gemini`                   | `gemini` or `claude`. `claude` needs no API key but does need a `claude login` session — see below. |
| `CLAUDE_WORKDIR`            | agent   | `./data/workspace`         | cwd for Claude Code's native file/bash tools when `AGENT_PROVIDER=claude`. |
| `GOOGLE_AUTH_ENABLED`       | server  | — (sign-in unavailable)    | Set to `1` = Google Sign-In offered to humans. The OAuth client itself is configured in the Supabase dashboard, not here — see "Google Sign-In" below. |
| `EMAIL_AUTH`                | server  | — (sign-in unavailable)    | Set to `1` = email/password sign-in offered. Neither this nor `GOOGLE_AUTH_ENABLED` set = the server refuses every join and the client shows a "contact support" dead end (`hello@convyio.com`) instead of a login screen. |
| `AGENT_TOKEN`               | both    | —                          | Shared secret agents join with when auth is on. Long and random.        |
| `CLIENT_DIST`               | server  | `packages/client/dist`     | Where the built client lives; absent = API only (dev).                  |
| `CORS_ORIGIN`               | server  | `localhost-dev`            | Dev-only: origin allowed to call the API cross-origin. The default mirrors any localhost/private-LAN origin (Vite may land on 5174+); set an explicit origin to lock it down. |
| `VITE_WS_URL`               | client  | —                          | Dev-only build override; production derives from `window.location`.     |

## Quick start — Docker

```sh
docker build -t workspace .
docker run -d --name workspace -p 3001:3001 \
  -v "$PWD/data:/data" --env-file .env workspace
```

or with compose (builds, mounts `./data`, restarts unless stopped):

```sh
cp .env.example .env   # fill in
docker compose up -d --build
```

Health: `curl http://localhost:3001/api/health` → `{"ok":true}`.

## Quick start — bare metal

Node 20+ (no SQLite version constraint anymore — the database is Supabase Postgres).

```sh
npm ci
npm run build -w @workspace/client
DATA_DIR=./data npx tsx packages/server/src/index.ts
# and, if you want the agent (separate process):
GEMINI_API_KEY=... WS_URL=ws://localhost:3001 npx tsx packages/agent/src/index.ts
```

The server logs `[static] serving client from …` when it found the build.

## Claude provider (subscription auth)

Setting `AGENT_PROVIDER=claude` runs the agent against
`@anthropic-ai/claude-agent-sdk` instead of Gemini. It authenticates via a
Claude Pro/Max subscription, not an API key — there is no
`ANTHROPIC_API_KEY` path. The SDK bundles its own `claude` CLI binary (no
separate install needed), but that binary's credential store must hold a
session from an interactive `claude login`, run once on whatever host
executes `packages/agent`.

- **Bare metal**: run `claude login` once on the machine before starting the
  agent process.
- **Docker**: the container is otherwise stateless, so the CLI's credential
  directory needs its own mounted volume (the same pattern as `-v
  "$PWD/data:/data"` for `DATA_DIR`) so a login survives container restarts —
  not automated by the current Dockerfile/compose setup.

Claude's native tools are restricted to read-only operations. Mutations route
through the server's Toolman path and retain the same board authorization
boundary; see `ARCHITECTURE/CURRENT_INVARIANTS.md`.

## Reverse proxy + TLS

The websocket and the API share the port, so one proxy block covers both.
`X-Forwarded-Proto` matters: `welcome.apiUrl` is derived from it, so without
it clients behind TLS would be told to fetch over plain http.

Caddy (automatic TLS, websocket upgrade and X-Forwarded-Proto out of the box):

```
chat.example.com {
    reverse_proxy localhost:3001
}
```

nginx:

```nginx
location / {
    proxy_pass http://localhost:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Supabase setup

1. Create a project at [supabase.com](https://supabase.com) (the free tier is enough for this app's scale).
2. Apply the schema: `npx supabase link --project-ref <your-project-ref> && npx supabase db push` (or run every file in `supabase/migrations/` in filename order with `psql "$SUPABASE_DB_URL" -f <file>` — later migrations add `agent_invites`, enable deny-all RLS, and split out `workspaces`/`workspace_members`, so the init file alone is not enough), then create the private `attachments` Storage bucket — see `supabase/migrations/` and Task 1 of the migration plan for the exact commands.
3. Copy the project's URL and keys (Project Settings → API) into `.env`: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `VITE_SUPABASE_URL` (same as `SUPABASE_URL`), `VITE_SUPABASE_PUBLISHABLE_KEY` (same as `SUPABASE_PUBLISHABLE_KEY`); copy the Postgres connection string (Project Settings → Database → Connection string → URI) into `SUPABASE_DB_URL`.
4. In Authentication → Providers, enable Email (for `EMAIL_AUTH=1`) and/or Google (for `GOOGLE_AUTH_ENABLED=1` — see "Google Sign-In" below for the OAuth client setup Google itself requires).
5. **After pulling changes, re-apply migrations** (`npx supabase db push`). New migrations land with the code that needs them, so a database left behind is the usual cause of a local environment that worked yesterday and does not today. The server checks this at boot and refuses to start with the exact list of what is missing rather than failing later, feature by feature.
6. If email/password sign-in is enabled, decide whether Authentication → Settings → "Confirm email" should be on. With it on, the UI shows "Account created — check your email for a confirmation link" after signup, and the user signs in once confirmed. Leaving it off gives zero-friction signup (account + session immediately).

## Google Sign-In

1. Google Cloud Console → Credentials → Create OAuth client ID, type
   **Web application**.
2. **Authorized JavaScript origins**: your exact production origin
   (`https://chat.example.com`), plus `http://localhost:5173` for dev.
3. **Authorized redirect URIs**: `https://<your-project-ref>.supabase.co/auth/v1/callback`
   — unlike the old in-page Google button, sign-in now redirects through
   Supabase's own callback, so this one URI covers every environment (dev
   and production both redirect back through the same Supabase project).
4. In the Supabase dashboard, Authentication → Providers → Google: paste
   this OAuth client's Client ID and Client Secret, and enable the provider.
5. Set `GOOGLE_AUTH_ENABLED=1` on the server (this only controls whether the
   client shows the Google button — the provider itself is already enabled
   by step 4).
6. Set `AGENT_TOKEN` to a long random secret (`openssl rand -hex 32`) shared
   with the agent process — without it no agent can join an auth-enabled
   server. The container passes it to the agent automatically.

## Quick public URL for testing

```sh
cloudflared tunnel --url http://localhost:3001
```

Prints a `https://….trycloudflare.com` URL, no account needed. To test
Google login through it, add that printed https origin to the OAuth client's
authorized JavaScript origins.

## Data

- The database, auth, and uploaded files all live in Supabase — back up
  through Supabase's own dashboard/CLI (`supabase db dump`), not this
  container. `DATA_DIR` only holds the agent's file/bash-tool sandbox now.
- Uploads are unauthenticated capability URLs (the unguessable UUID is the
  secret, the Discord-CDN model — recorded in `ARCHITECTURE/DECISIONS.md`):
  the server proxies them from a private Supabase Storage bucket using the
  secret key, so the bucket itself is never exposed directly.
- Known gap: no rate limiting yet.
