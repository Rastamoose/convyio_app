# Deploying

One container (or one Node process) serves everything on one origin: the
built client, the HTTP API, and the websocket all on port 3001. Clients
derive every URL from the origin they loaded the page from, and the server
derives `welcome.apiUrl` per connection from the `Host` /
`X-Forwarded-Proto` headers — no baked-in hostnames anywhere.

## Environment

| Variable           | Used by | Default                    | Meaning                                                                 |
| ------------------ | ------- | -------------------------- | ----------------------------------------------------------------------- |
| `PORT`             | server  | `3001`                     | HTTP + websocket port.                                                  |
| `DATA_DIR`         | server  | `./data` (`/data` in image)| Everything persistent: `board.db`, `workspace/`, `uploads/`, `agents/`. |
| `GEMINI_API_KEY`   | agent   | —                          | Enables the agent; unset = no agent starts.                             |
| `AGENT_NAME`       | agent   | `noodle`                   | The agent's display name.                                               |
| `AGENT_MODEL`      | agent   | `gemini-2.5-flash`         | Gemini model id.                                                        |
| `AGENT_PROVIDER`   | agent   | `gemini`                   | `gemini` or `claude`. `claude` needs no API key but does need a `claude login` session — see below. |
| `CLAUDE_WORKDIR`   | agent   | `./data/workspace`         | cwd for Claude Code's native file/bash tools when `AGENT_PROVIDER=claude`. |
| `GOOGLE_CLIENT_ID` | server  | — (sign-in unavailable)    | Set = Google Sign-In offered to humans.                                 |
| `EMAIL_AUTH`       | server  | — (sign-in unavailable)    | Set to `1` = email/password sign-in offered. Neither set = the server refuses every join and the client shows a "contact support" dead end (`hello@convyio.com`) instead of a login screen. |
| `AGENT_TOKEN`      | both    | —                          | Shared secret agents join with when auth is on. Long and random.        |
| `CLIENT_DIST`      | server  | `packages/client/dist`     | Where the built client lives; absent = API only (dev).                  |
| `CORS_ORIGIN`      | server  | `http://localhost:5173`    | Dev-only: the Vite origin allowed to call the API cross-origin.         |
| `VITE_WS_URL`      | client  | —                          | Dev-only build override; production derives from `window.location`.     |

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

Node 23.4+ (`node:sqlite` unflagged; Node 22 needs `--experimental-sqlite`).

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

Also known gap, tracked in `ARCHITECTURE.md`: with this provider, Claude
Code's native Bash/Write/Edit tools run ungated alongside the board tools,
so a board approval is not required for every mutation the agent can make.

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

## Google Sign-In

1. Google Cloud Console → Credentials → Create OAuth client ID, type
   **Web application**.
2. **Authorized JavaScript origins**: your exact production origin
   (`https://chat.example.com`), plus `http://localhost:5173` for dev.
   **No redirect URIs** — the GIS button flow doesn't use them.
3. Set `GOOGLE_CLIENT_ID` on the server (this flips it out of guest mode).
4. Set `AGENT_TOKEN` to a long random secret (`openssl rand -hex 32`) shared
   with the agent process — without it no agent can join an auth-enabled
   server. The container passes it to the agent automatically.
5. GIS requires HTTPS in production (localhost is exempt).

## Quick public URL for testing

```sh
cloudflared tunnel --url http://localhost:3001
```

Prints a `https://….trycloudflare.com` URL, no account needed. To test
Google login through it, add that printed https origin to the OAuth client's
authorized JavaScript origins.

## Data

- Everything lives in `DATA_DIR` — back up that directory and you have
  backed up the workspace.
- Uploads are unauthenticated capability URLs (the unguessable UUID is the
  secret, the Discord-CDN model — recorded in ARCHITECTURE.md). Anyone who
  holds a link can fetch those bytes.
- Known gap: no rate limiting yet.
