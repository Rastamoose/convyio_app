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
| `DATA_DIR`                  | server, agent | `./data` (`/data` in image)| Parent for workspace sandboxes, managed Git checkouts and hosted-agent state; the database and uploads live in Supabase. |
| `SUPABASE_URL`              | server  | — (required)                | Supabase project URL.                                                    |
| `SUPABASE_SECRET_KEY`       | server  | — (required)                | Secret (service-role) key: verifies user JWTs and reads/writes Storage server-side. Never expose to the client. |
| `SUPABASE_DB_URL`           | server  | — (required)                | Postgres connection string (Supabase project settings → Database).      |
| `GITHUB_APP_ID`             | server  | —                           | Numeric GitHub App id used as the issuer of short-lived App JWTs.        |
| `GITHUB_APP_SLUG`           | server  | —                           | Public GitHub App slug used to build the repository-selection installation URL. |
| `GITHUB_CLIENT_ID`          | server  | —                           | GitHub App client id used for one-use user authorization during installation. |
| `GITHUB_CLIENT_SECRET`      | server  | —                           | GitHub App client secret; server-only.                                   |
| `GITHUB_APP_PRIVATE_KEY`    | server  | —                           | Generated GitHub App PEM private key; signs App JWTs and never reaches clients/agents. |
| `GITHUB_REDIRECT_URI`       | server  | request-derived             | Optional fixed GitHub App callback; otherwise derives `/api/git/github/callback` from the shell origin. |
| `VITE_SUPABASE_URL`         | client  | — (required)                | Same project URL, exposed to the browser bundle.                        |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | client  | — (required)            | Supabase publishable (public) key — safe to expose, used for browser sign-in. |
| `GEMINI_API_KEY`            | agent   | —                          | Enables the agent when `AGENT_PROVIDER=gemini` (the default); unset = no agent starts under that provider. Not needed for `AGENT_PROVIDER=claude`. |
| `AGENT_NAME`                | agent   | `noodle`                   | The agent's display name.                                               |
| `AGENT_MODEL`               | agent   | `gemini-2.5-flash`         | Model id — Gemini model for the gemini provider, `claude-sonnet-5` default for the claude provider. |
| `AGENT_PROVIDER`            | agent   | `gemini`                   | `gemini` or `claude`. `claude` needs no API key but does need a `claude login` session — see below. |
| `CLAUDE_WORKDIR`            | agent   | `./data/workspace`         | cwd for Claude's restricted native read/search tools; mutations use server-authorized Toolman project tools. |
| `GOOGLE_AUTH_ENABLED`       | server  | — (sign-in unavailable)    | Set to `1` = Google Sign-In offered to humans. The OAuth client itself is configured in the Supabase dashboard, not here — see "Google Sign-In" below. |
| `EMAIL_AUTH`                | server  | — (sign-in unavailable)    | Set to `1` = email/password sign-in offered. Neither this nor `GOOGLE_AUTH_ENABLED` set = the server refuses every join and the client shows a "contact support" dead end (`hello@convyio.com`) instead of a login screen. |
| `AGENT_TOKEN`               | both    | —                          | Shared secret used by the shell and hosted noodle service. The values must match exactly; the shell authenticates the manifest and workspace joins. |
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

Local test login for pairing and conversation-loop work: `test@test.com` /
`testuser` (username `test`, workspace `test_space`). Details in `AGENTS.md`.
If only some GitHub App vars are set, the server refuses to start; unset
them all for a no-GitHub local stack, or set the full five together.

## Quick start — bare metal

Node 22+ (the server database is Supabase Postgres).

```sh
npm ci
npm run build -w @workspace/client
DATA_DIR=./data npx tsx packages/server/src/index.ts
# and, if you want the agent (separate process):
GEMINI_API_KEY=... WS_URL=ws://localhost:3001 npx tsx packages/agent/src/index.ts
```

The server logs `[static] serving client from …` when it found the build.

## Hosted noodle

Hosted noodle runs as a separate `@workspace/agent` process, never inside the shell. With `AGENT_TOKEN` set, the agent polls the shell's `/api/hosted-agent/workspaces` endpoint and maintains one Gemini connection per workspace where the managed noodle membership is enabled. `WS_URL` must name the shell's public websocket origin, and `AGENT_TOKEN` must exactly match the shell value. `DATA_DIR` stores isolated memory and conversation state under one subdirectory per workspace.

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

## Toolman local-folder node

`convyio-toolman` is built from this repository; it is not published to npm.
Build and link it once on the machine that owns the folder:

```sh
npm install
npm run build -w @workspace/toolman
npm link -w @workspace/toolman
```

In the workspace Resources view, choose **Share this folder**, name the device,
and copy the one-time pairing code. Then, from the folder to share:

```sh
convyio-toolman pair --server https://app.convyio.com --code <one-time-code>
convyio-toolman project add . --name <workspace-project-name>
convyio-toolman run
```

The installation token and local path mapping are private mode files under
`$XDG_CONFIG_HOME/convyio/toolman` (default `~/.config/convyio/toolman`). The
server receives only opaque node, project and mount ids. If several nodes are
paired, pass a node name or id to `project add --node`, `project remove --node`,
and `run`.

`run` stays in the foreground and must remain running, but reconnects after
server/network interruption with bounded backoff. Use a process supervisor for
an unattended device. `convyio-toolman status` asks the shell whether each
stored installation is `ready`, `offline`, `revoked`, or `unreachable`; stored
credentials alone do not mean the node is live. `status` and `run` also remove
local mappings for folders already removed on the server.

If `run` reports a revoked credential, create a new Resources pairing with the
same device name and run its `pair` command. The server reactivates the same
node id and the CLI preserves its existing local mount paths; then start
`convyio-toolman run` again. `unpair` revokes the presented installation and
removes its local credential.

Resources stages two device-level actions. An active device exposes only
**Revoke**, which disconnects and invalidates the credential but preserves the
device, mounts and project identity for repair. After revocation, **Delete**
appears; the server refuses deletion before that point. Delete permanently
removes the server-side device, all remaining mounts and mount-bound
assignments while preserving execution history and local files. Both actions
require explicit confirmation.

Remove one shared folder without unpairing the device or deleting local files:

```sh
convyio-toolman project remove <name-or-id-or-path> [--node <name-or-id>]
```

The owner can perform the same operation with **Remove folder** in Resources.
Assignments bound to that mount are removed; a directory project is archived
only when its final mount is removed and reuses the same project id if shared
again later.

The project owner then selects agents and `ask` / `always` / `deny` in
Resources. `always` permits unattended folder consent while Toolman is live,
but conversation permission mode and ticket/chat-grant authorization still
apply. Only the owner can manage assignments or use the Resources file editor.

## GitHub repositories

Create a GitHub App with these production settings:

- **Name**: `Convyio` (or another globally unique display name)
- **Homepage URL**: `https://app.convyio.com`
- **Redirect URI**: `https://app.convyio.com/api/git/github/callback`
- **Allow wildcard matching**: off
- **Expire user authorization tokens**: on
- **Request user authorization (OAuth) during installation**: on
- **Device Flow**: off
- **Setup URL / Redirect on update**: unused/off
- **Webhook Active**: off; no webhook URL or secret
- **Repository permissions**: Contents read/write, Pull requests read/write,
  Issues read/write, Checks read-only, Commit statuses read-only, Workflows
  read/write, Metadata read-only (GitHub includes Metadata automatically)
- **Organization, account and enterprise permissions**: none
- **Subscribe to events**: none
- **Where can this GitHub App be installed?**: Any account

The installation URL lets each user or organization select the repositories
Convyio may access. Requesting user authorization during installation is
required: the callback exchanges its one-use code only to verify that the
returned installation belongs to that GitHub user, then discards the user
token. Runtime API and Git calls use one-hour installation tokens minted from
the App private key; no GitHub token is stored in Postgres.

After creating the App, copy its numeric App ID, public slug, client id and
client secret, then generate/download one private key. Configure the shell:

```sh
GITHUB_APP_ID=...
GITHUB_APP_SLUG=convyio
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
...
-----END RSA PRIVATE KEY-----"
GITHUB_REDIRECT_URI=https://app.convyio.com/api/git/github/callback
```

Railway supports a multiline private-key value; a value containing literal
`\n` sequences is normalized too. Partial configuration makes server boot fail.
For local development, add
`http://localhost:3001/api/git/github/callback` as another Redirect URI and set
`GITHUB_REDIRECT_URI` to it; the shell returns the browser to the accepted Vite
origin on 5173/5174.

Apply both Git migrations (normally `npx supabase db push`):

- `20260818150000_git_integration.sql`
- `20260819100000_github_app_installations.sql`

The second migration invalidates legacy broad OAuth mappings, adds durable
hashed/single-use installation state and stores only the installation id and
permissions. The runtime host also needs `git`; Docker installs it, while
bare-metal deployments must install it separately. Managed checkouts currently
live below `DATA_DIR/workspaces/<sha256(workspace-id)>/repositories/`, so preserve
that volume across restarts.

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
2. Apply the schema: `npx supabase link --project-ref <your-project-ref> && npx supabase db push` (or run every file in `supabase/migrations/` in filename order with `psql "$SUPABASE_DB_URL" -f <file>` — later migrations add agent/project/Git records, enable deny-all RLS, and split out `workspaces`/`workspace_members`, so the init file alone is not enough), then create the private `attachments` Storage bucket — see `supabase/migrations/` and Task 1 of the migration plan for the exact commands.
3. Copy the project's URL and keys (Project Settings → API) into `.env`: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `VITE_SUPABASE_URL` (same as `SUPABASE_URL`), `VITE_SUPABASE_PUBLISHABLE_KEY` (same as `SUPABASE_PUBLISHABLE_KEY`); copy the Postgres connection string (Project Settings → Database → Connection string → URI) into `SUPABASE_DB_URL`.
4. In Authentication → Providers, enable Email (for `EMAIL_AUTH=1`) and/or Google (for `GOOGLE_AUTH_ENABLED=1` — see "Google Sign-In" below for the OAuth client setup Google itself requires). Add `https://app.convyio.com/**` to Supabase Authentication → URL Configuration → Redirect URLs so `/invite/:token` survives Google OAuth, email confirmation and password recovery redirects.
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
authorized JavaScript origins. To test GitHub, add
`<printed-origin>/api/git/github/callback` as a GitHub App Redirect URI and set
`GITHUB_REDIRECT_URI` to the same value.

## Data

- The database, auth, and uploaded files all live in Supabase — back up
  through Supabase's own dashboard/CLI (`supabase db dump`), not this
  container. `DATA_DIR` holds isolated server-local Toolman sandboxes and
  managed Git checkouts under `workspaces/<sha256(workspace-id)>/`; local-folder
  mounts remain on their paired Toolman devices.
- Uploads are unauthenticated capability URLs (the unguessable UUID is the
  secret, the Discord-CDN model — recorded in `ARCHITECTURE/DECISIONS.md`):
  the server proxies them from a private Supabase Storage bucket using the
  secret key, so the bucket itself is never exposed directly.
- API and websocket abuse controls are in-memory and per shell process. They bound account, pairing, upload and message traffic but are not a distributed quota system.
