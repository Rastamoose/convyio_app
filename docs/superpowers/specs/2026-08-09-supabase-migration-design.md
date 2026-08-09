# Supabase Migration — Design

## Context

The app currently persists everything to a single SQLite file (`node:sqlite`,
no ORM, hand-written `SCHEMA`/`MIGRATIONS` strings in
`packages/server/src/chat/MessageStore.ts`), authenticates users with
hand-rolled Google ID token verification and optional scrypt-hashed
email/password (`packages/server/src/auth/Auth.ts`, `auth_sessions` table),
and stores uploaded file attachments as plain files on local disk
(`packages/server/src/chat/Attachments.ts`, `<DATA_DIR>/uploads`).

There is no real production data or users yet, so this migration does not
need to preserve any existing rows or files — it's a clean cutover, not a
data migration.

## Goals

- Move the database to Supabase-managed Postgres.
- Move auth (Google sign-in + email/password) to Supabase Auth.
- Move file attachment storage to Supabase Storage.
- Delete the code this replaces rather than keeping it as a fallback path.

## Non-goals

- No ORM (Prisma/Drizzle). ~10 tables, already hand-written SQL — an ORM adds
  new machinery for a problem that doesn't exist here.
- No framework rewrite. Stays plain Node + `ws`, no move to Next.js/Express.
- No data backfill/dump-restore tooling — there's nothing worth preserving.
- No dual-write or gradual-cutover mechanism — single cutover is fine given
  no production traffic.

## Design

### Database

Swap `node:sqlite`'s `DatabaseSync` for a plain Postgres client
(`postgres` npm package) pointed at the Supabase connection string.
Translate the existing SQLite `SCHEMA` string to Postgres syntax (main
changes: `INTEGER PRIMARY KEY AUTOINCREMENT` → `bigint generated always as
identity`, minor type adjustments). The in-code `MIGRATIONS` array
(applied-on-boot `ALTER TABLE` statements) is deleted; schema changes going
forward are plain `.sql` files managed via the Supabase CLI
(`supabase migration new`), checked into git.

Table shape (columns, FKs) stays the same as today — this is a storage-layer
swap, not a schema redesign, except where Auth/Storage changes below require
column changes (see those sections).

### Auth

Delete `googleIdToken.ts`, the scrypt password code in `Auth.ts`, and the
`auth_sessions` table entirely. Supabase Auth replaces all of it:

- Google sign-in becomes a Supabase Auth OAuth provider (configured in the
  Supabase dashboard), not custom ID-token verification.
- Email/password uses Supabase Auth's built-in support, not custom hashing.
- The client authenticates via `@supabase/supabase-js` and receives a JWT.
- The server verifies that JWT per request/WS-connection (using Supabase's
  JWT secret) instead of doing an `auth_sessions` table lookup.
- The `actors` table's link to a user changes from an app-generated id to
  the Supabase Auth user id (`auth.users.id`).

### Storage

Replace `Attachments.ts`'s `fs.writeFile`/local-disk read path with
`supabase.storage.from('attachments').upload(...)` /
`.createSignedUrl(...)`. The `attachments` table keeps its existing
metadata columns (name/mime/size/dims); the column that currently holds a
local file id instead holds the Supabase Storage object path.

### Rollout

1. Create a Supabase project, define the Postgres schema and storage bucket.
2. Wire up `@supabase/supabase-js` + `postgres` client, env vars
   (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   Postgres connection string).
3. Migrate the DB layer, then Auth, then Storage (in that order — DB is the
   dependency for the other two).
4. Delete the old SQLite/local-disk/custom-auth code once each piece is
   replaced and tested locally.
5. Update `docker-compose.yml`/`DEPLOY.md` (drop the `./data` volume
   requirement for DB/uploads; env vars replace it).

No feature-flagging or fallback path — single local test pass, then deploy.

## Open questions / risks

- Local dev workflow: run against a real (free-tier) Supabase project, or
  the Supabase CLI's local Docker stack? Recommend starting with a hosted
  free-tier project for simplicity (no newbie's-first-Docker-Postgres
  debugging); revisit local stack later if iteration speed becomes a
  problem.
- WebSocket auth: current connections presumably authenticate via the
  session cookie/token at connect time; this needs to be re-pointed at
  Supabase JWT verification — flagged here so the implementation plan
  covers it explicitly rather than discovering it mid-way.
