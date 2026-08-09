# Supabase Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SQLite + custom Google/scrypt auth + local-disk uploads with Supabase-managed Postgres, Supabase Auth, and Supabase Storage — a clean cutover, no data migration, per `docs/superpowers/specs/2026-08-09-supabase-migration-design.md`.

**Architecture:** Swap `node:sqlite`'s `DatabaseSync` for the `postgres` npm package (Postgres.js, tagged-template SQL, no ORM) pointed at Supabase Postgres. Every store method that touched SQLite synchronously becomes `async`; this ripples through `WorkspaceDb` → `MessageStore`/`BoardService`/`Channels`/`Attachments`/`Auth`/`Roster` → `hub.ts`/`board/api.ts`/`board/Toolman.ts`/`demo/DemoOrchestrator.ts`/`index.ts`. Google ID-token verification and scrypt password hashing are deleted; the client authenticates via `@supabase/supabase-js` (Google OAuth + email/password) and the server verifies the resulting JWT with a Supabase admin client. File uploads move from `<DATA_DIR>/uploads` to a Supabase Storage bucket, still proxied through the existing `/api/uploads/:id/:name` route.

**Tech Stack:** `postgres` (Postgres.js) for the DB client, `@supabase/supabase-js` for Auth + Storage (server admin client and browser client), Supabase CLI for schema migrations, Node's built-in `node:test` runner (server) and Vitest (client) — both unchanged.

## Global Constraints

- No ORM — hand-written SQL via `postgres`'s tagged templates, matching the existing hand-written-SQL style.
- No framework rewrite — stays plain Node + `ws`.
- No data backfill — there is no production data; this is a clean cutover.
- No dual-write/feature-flag/fallback path — single cutover, then delete the old code.
- Delete rather than keep as fallback: `packages/server/src/auth/googleIdToken.ts`, the scrypt code and `auth_sessions` table in `Auth.ts`/`db.ts`, the local-disk path in `Attachments.ts`, the in-code `SCHEMA`/`MIGRATIONS` strings in `db.ts`.
- Every method that currently does synchronous `this.store.db.prepare(...).all/get/run(...)` becomes `async`; each task below updates a callee and its direct callers together so the build is never left broken by more than one task.
- `Toolman`/`DemoOrchestrator`'s `workspaceDir` (agent file/bash-tool sandbox under `DATA_DIR`) is unrelated to this migration — leave `config.dataDir`'s use for that purpose alone.
- Supabase project is already provisioned: project_ref `nwyliqiqscuiyorbjzbw`; root `.env` already has `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
- Server tests run against the real Supabase Postgres instance via `SUPABASE_DB_URL` (no local Docker Postgres) — every test suite gets an isolated, throwaway Postgres **schema** (created and dropped per suite) as the Postgres analogue of today's SQLite `:memory:` isolation. See Task 3.

## File Structure

New files:
- `supabase/migrations/<timestamp>_init.sql` — the Postgres schema (source of truth for both the hosted DB and test-schema bootstrapping).
- `packages/server/test/pgSchema.ts` — creates/drops an isolated Postgres schema per test suite, applying every migration file into it.
- `packages/server/test/db.test.ts` — new unit tests for `WorkspaceDb` itself (nothing exercised this directly before; SQLite behavior was implicitly covered through the higher-level suites).
- `packages/client/src/lib/supabase.ts` — the browser `@supabase/supabase-js` client singleton.

Rewritten files (full-file rewrite, `node:sqlite`/scrypt/local-disk/old-auth code deleted):
- `packages/server/src/db.ts`
- `packages/server/src/chat/MessageStore.ts`
- `packages/server/src/chat/Channels.ts`
- `packages/server/src/chat/Attachments.ts`
- `packages/server/src/auth/Auth.ts`
- `packages/server/src/auth/joinPolicy.ts`
- `packages/server/src/roster.ts`
- `packages/server/src/config.ts`
- `packages/server/src/board/BoardService.ts`
- `packages/server/src/board/api.ts`
- `packages/server/src/index.ts`
- `packages/server/test/helpers.ts`
- `packages/client/src/components/LoginScreen.tsx`
- `packages/client/src/App.tsx`
- `packages/client/src/App.test.tsx`

Deleted files:
- `packages/server/src/auth/googleIdToken.ts`
- `packages/server/test/auth.test.ts`'s Google-JWT-signing unit tests (the `googleIdToken` describe block) — the rest of that file's login-flow tests are rewritten, not deleted.

Method-level edits (only the touched methods change, rest of the file untouched):
- `packages/server/src/board/Toolman.ts` (just `authorizeMutation` and its one call site)
- `packages/server/src/hub.ts` (every method that touches the store layer)
- `packages/server/src/demo/DemoOrchestrator.ts` (`start`, `post`, `approveProposal`, `cleanupDemoItems`)
- `packages/server/test/channels.test.ts`, `board.test.ts`, `hardening.test.ts`, `pressure.test.ts`, `messages.test.ts`, `pins.test.ts`, `attachments.test.ts` (add `await` at the now-async call sites; `auth.test.ts` is a full rewrite, listed above)

Explicitly **not** touched by any task, confirmed while reading the codebase: `packages/server/src/board/sessions.ts` (the short-lived WS-issued HTTP-session `Sessions` class is unrelated to Supabase Auth — it's an internal token minted after a join already succeeded), `packages/client/src/hooks/useApiSession.ts`/`useConnection.ts`/`ws.ts`/`hooks/WorkspaceContext.tsx` (none of them touch Supabase directly; `App.tsx` is the only client file that talks to `supabase`), `packages/server/src/board/Toolman.ts`'s `workspaceDir`/`packages/server/src/demo/DemoOrchestrator.ts`'s `workspaceDir`/`seedRoot` (the agent file/bash-tool sandbox, unrelated to this migration per Global Constraints).

Docs/deploy:
- `.env.example`, `docker-compose.yml`, `DEPLOY.md`, `ARCHITECTURE.md`, `scripts/reset-data.sh` (rewritten), `scripts/reset-data.mjs` (new), `packages/server/package.json`, `packages/client/package.json`.

---

### Task 1: Supabase schema migration

**Files:**
- Create: `supabase/migrations/20260809120000_init.sql`
- Create: `supabase/config.toml` (via `supabase init`)

**Interfaces:**
- Produces: the full Postgres schema every later task's SQL targets — table names, column names/types exactly as below. `board_events.id` and `messages.seq`/`channels.seq`/`message_reactions.seq` are the Postgres replacements for SQLite's implicit `rowid` tiebreaker (Postgres has no equivalent, so `MessageStore.ts`/`Channels.ts`'s `ORDER BY ... rowid` clauses become `ORDER BY ... seq`).

- [ ] **Step 1: Install and authenticate the Supabase CLI for this project**

```bash
cd /home/harris/Programming/convyio/app
npx supabase login   # opens a browser; only needed once per machine
npx supabase init    # creates supabase/config.toml, supabase/.gitignore
npx supabase link --project-ref nwyliqiqscuiyorbjzbw
```

Expected: `supabase link` prints `Finished supabase link.` If `login`/`link` cannot complete non-interactively in this environment, fall back to applying the migration directly with `psql "$SUPABASE_DB_URL" -f supabase/migrations/20260809120000_init.sql` in Step 3 — the migration file itself is identical either way.

- [ ] **Step 2: Write the migration file**

```sql
-- supabase/migrations/20260809120000_init.sql

create table meta (
  key   text primary key,
  value text not null
);

create table actors (
  id            text primary key,
  kind          text not null check (kind in ('human', 'agent')),
  display_name  text not null,
  server_id     text not null,
  email         text
);

create unique index idx_actors_email on actors (lower(email)) where email is not null;
create index idx_actors_server_kind_name on actors (server_id, kind, lower(display_name));

create table board_items (
  id               text primary key,
  server_id        text not null,
  ref              text not null,
  title            text not null,
  description      text,
  status           text not null check (status in
    ('proposed', 'denied', 'approved', 'in_progress', 'blocked', 'done')),
  origin           text not null check (origin in ('human', 'agent')),
  created_by       text not null references actors(id),
  approved_by      text references actors(id),
  owner            text references actors(id),
  proposal_why     text,
  proposal_effect  text,
  scope_paths      text,
  created_at       bigint not null,
  approved_at      bigint,
  started_at       bigint,
  completed_at     bigint,
  deleted_at       bigint,
  unique (server_id, ref)
);

create table board_events (
  id          bigint generated always as identity primary key,
  server_id   text not null,
  item_id     text not null references board_items(id),
  type        text not null,
  actor_id    text not null references actors(id),
  payload     text not null default '{}',
  created_at  bigint not null
);

create table ref_counters (
  server_id  text primary key,
  n          integer not null
);

create table channels (
  id          text primary key,
  name        text not null,
  created_by  text references actors(id),
  is_demo     boolean not null default false,
  archived_at bigint,
  pinned_at   bigint,
  created_at  bigint not null,
  seq         bigint generated always as identity
);

create unique index idx_channels_name_lower on channels (lower(name));

create table messages (
  id           text primary key,
  author_id    text not null,
  author_name  text not null,
  author_kind  text not null check (author_kind in ('human', 'agent')),
  content      text not null,
  channel      text not null default 'general',
  run_id       text,
  trace        text,
  attachments  text,
  pinned_at    bigint,
  pinned_by    text,
  edited_at    bigint,
  reply_to_id  text,
  created_at   bigint not null,
  seq          bigint generated always as identity
);

create table message_reactions (
  message_id  text not null,
  emoji       text not null,
  actor_id    text not null,
  actor_name  text not null,
  created_at  bigint not null,
  seq         bigint generated always as identity,
  primary key (message_id, emoji, actor_id)
);

create table attachments (
  id           text primary key,
  uploader_id  text not null references actors(id),
  message_id   text,
  name         text not null,
  mime         text not null,
  size         integer not null,
  width        integer,
  height       integer,
  created_at   bigint not null
);

create index idx_items_server_status on board_items (server_id, status);
create index idx_events_server_created on board_events (server_id, created_at);
create index idx_messages_channel_created on messages (channel, created_at);
```

Notes for the engineer:
- Every id/foreign-key column stays `text`, exactly like the SQLite original — deliberately **not** tightened to Postgres's native `uuid` type. Several of these columns receive arbitrary client-supplied strings that are not always valid UUIDs (e.g. `board_items` is looked up by either its id or its human-friendly `ref` such as `"task-14"` in one `OR`-ed query; WS message/reaction handlers pass a client-supplied `messageId` straight into a lookup). A `uuid`-typed column raises a hard Postgres error on a malformed value instead of just matching zero rows, which would turn "unknown id" (today a clean 404/`error` frame) into an unhandled exception. `text` preserves the original, safe "no match" behavior for garbage input.
- `messages.author_id`/`pinned_by`/`reply_to_id` are `text` for the same reason `id` columns are, plus: the code comment in `MessageStore.ts` explicitly notes `author_id` is a loose reference (no FK), and `pinned_by` stores a **display name**, not an id.
- `google_sub`/`password_hash` columns and the `auth_sessions` table from the old SQLite schema are gone entirely — Supabase Auth owns credentials now.
- `COLLATE NOCASE` becomes an explicit `lower()` functional unique index (`idx_actors_email`, `idx_channels_name_lower`), matching the pattern the app already uses in hand-written queries (`lower(display_name) = lower(?)`).

- [ ] **Step 3: Apply the migration to the hosted Supabase project**

```bash
npx supabase db push
# or, if link/push aren't available in this environment:
psql "$SUPABASE_DB_URL" -f supabase/migrations/20260809120000_init.sql
```

Expected: no errors. Verify with:

```bash
psql "$SUPABASE_DB_URL" -c "\dt public.*"
```

Expected output lists all 9 tables: `meta`, `actors`, `board_items`, `board_events`, `ref_counters`, `channels`, `messages`, `message_reactions`, `attachments`.

- [ ] **Step 4: Create the Storage bucket**

```bash
psql "$SUPABASE_DB_URL" -c "
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;
"
```

The bucket is private (`public = false`): Task 8 serves files through the existing `/api/uploads/:id/:name` proxy route using the service-role key, exactly like today's local-disk path is never exposed directly — no bucket-level RLS policy is needed since only the server's service-role client ever touches it.

- [ ] **Step 5: Commit**

```bash
git add supabase/
git commit -m "Add Supabase Postgres schema migration and attachments bucket"
```

### Task 2: Add dependencies

**Files:**
- Modify: `packages/server/package.json`
- Modify: `packages/client/package.json`

**Interfaces:**
- Produces: `postgres` and `@supabase/supabase-js` importable from server code; `@supabase/supabase-js` importable from client code.

- [ ] **Step 1: Add server dependencies**

```bash
cd /home/harris/Programming/convyio/app
npm install postgres@^3.4.9 @supabase/supabase-js@^2.112.2 -w @workspace/server
```

- [ ] **Step 2: Add client dependency**

```bash
npm install @supabase/supabase-js@^2.112.2 -w @workspace/client
```

- [ ] **Step 3: Verify both packages resolve**

```bash
node -e "require.resolve('postgres', { paths: ['packages/server/node_modules'] })"
npm run typecheck
```

Expected: the `require.resolve` prints a path with no error; `typecheck` still fails at this point only with pre-existing errors (none expected yet, since no source files changed) — if it fails, stop and investigate before continuing.

- [ ] **Step 4: Commit**

```bash
git add packages/server/package.json packages/server/package-lock.json packages/client/package.json packages/client/package-lock.json package-lock.json
git commit -m "Add postgres and @supabase/supabase-js dependencies"
```

### Task 3: Rewrite `db.ts` to async Postgres, add test-schema isolation

**Files:**
- Modify (full rewrite): `packages/server/src/db.ts`
- Create: `packages/server/test/pgSchema.ts`
- Create: `packages/server/test/db.test.ts`

**Interfaces:**
- Consumes: `SUPABASE_DB_URL` env var (already in root `.env`); the migration file(s) under `supabase/migrations/` from Task 1.
- Produces (replaces the old sync `WorkspaceDb` API — every later task's caller code targets this exactly):
  - `export type Sql = ReturnType<typeof postgres>`
  - `class WorkspaceDb { readonly sql: Sql; readonly serverId: string; static async create(connectionString: string, searchPath?: string): Promise<WorkspaceDb>; async transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>; async nextRef(sql: Sql, serverId: string): Promise<string>; async upsertActor(kind: ParticipantKind, displayName: string): Promise<Actor>; async findActorByName(kind: ParticipantKind, displayName: string): Promise<Actor | null>; async createHuman(id: string, displayName: string, email: string | null): Promise<Actor>; async getActor(id: string): Promise<Actor | null>; async listActors(kind?: ParticipantKind): Promise<Actor[]>; async close(): Promise<void>; }`
  - Removed entirely (no longer exist anywhere): `findActorByGoogleSub`, `createGoogleHuman`, `findActorByEmail`, `getPasswordHash`, `createEmailHuman`, `applyMigrations`, the `db` property, `SCHEMA`, `MIGRATIONS`.
  - `test/pgSchema.ts` produces: `export async function createTestDb(): Promise<{ db: WorkspaceDb; drop: () => Promise<void> }>` — the Postgres analogue of `new WorkspaceDb(":memory:")`.

- [ ] **Step 1: Write `db.ts`**

```ts
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Actor, ParticipantKind } from "@workspace/shared";

/**
 * postgres.js's tagged-template client/transaction type, derived via
 * ReturnType so this file never has to guess which type name postgres.js
 * exports under which version. A transaction callback's `sql` is
 * structurally compatible with this type (it is a strict superset).
 */
export type Sql = ReturnType<typeof postgres>;

/**
 * Workspace persistence: Supabase-managed Postgres holding actors, chat
 * messages, and the board. board_events is append-only — it is both the
 * audit trail and the realtime feed, so rows are never updated or deleted.
 * Per-server refs come from ref_counters so concurrent creates still
 * allocate unique sequential refs inside their transactions.
 *
 * Schema lives in supabase/migrations/*.sql, applied via the Supabase CLI
 * (or test/pgSchema.ts for tests) — this class only connects and queries,
 * it never creates tables.
 */
export class WorkspaceDb {
  readonly sql: Sql;
  readonly serverId: string;

  private constructor(sql: Sql, serverId: string) {
    this.sql = sql;
    this.serverId = serverId;
  }

  /**
   * Connect and resolve this deployment's server_id. `searchPath` lets
   * tests point every query at an isolated, throwaway schema instead of
   * `public` (see test/pgSchema.ts) without touching production data.
   */
  static async create(connectionString: string, searchPath = "public"): Promise<WorkspaceDb> {
    const sql = postgres(connectionString, {
      connection: { search_path: searchPath },
      // int8/bigint (created_at, board_events.id, the *.seq columns) parses
      // as a string in postgres.js by default, to avoid precision loss
      // above 2^53. Every bigint column here is a millisecond epoch or a
      // small auto-increment counter, always within Number's safe range,
      // so parse it as a number to match the app's existing (SQLite
      // integer-derived) `number` typing throughout the codebase.
      types: {
        bigint: {
          to: 20,
          from: [20],
          serialize: (x: number) => String(x),
          parse: (x: string) => Number(x),
        },
      },
    });
    const serverId = await ensureServer(sql);
    return new WorkspaceDb(sql, serverId);
  }

  /**
   * Run fn inside a transaction; rolls back on throw. Every query inside fn
   * must use the `sql` it is given, not `this.sql` — postgres.js scopes
   * transactional queries to that callback's own client.
   */
  async transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
    return this.sql.begin((tx) => fn(tx as unknown as Sql)) as Promise<T>;
  }

  /** Allocate the next per-server ref inside the caller's transaction. */
  async nextRef(sql: Sql, serverId: string): Promise<string> {
    await sql`
      INSERT INTO ref_counters (server_id, n) VALUES (${serverId}, 0)
      ON CONFLICT (server_id) DO NOTHING
    `;
    const [row] = await sql<{ n: number }[]>`
      UPDATE ref_counters SET n = n + 1 WHERE server_id = ${serverId} RETURNING n
    `;
    return `task-${row.n}`;
  }

  /** Find or create a persistent actor identity for a joining participant. */
  async upsertActor(kind: ParticipantKind, displayName: string): Promise<Actor> {
    const existing = await this.findActorByName(kind, displayName);
    if (existing) return existing;
    const actor: Actor = { id: randomUUID(), kind, displayName, serverId: this.serverId };
    await this.sql`
      INSERT INTO actors (id, kind, display_name, server_id)
      VALUES (${actor.id}, ${actor.kind}, ${actor.displayName}, ${actor.serverId})
    `;
    return actor;
  }

  /** Case-insensitive display-name lookup, matching upsertActor's dedupe rule. */
  async findActorByName(kind: ParticipantKind, displayName: string): Promise<Actor | null> {
    const rows = await this.sql<ActorRow[]>`
      SELECT * FROM actors
      WHERE server_id = ${this.serverId} AND kind = ${kind} AND lower(display_name) = lower(${displayName})
    `;
    return rows[0] ? toActor(rows[0]) : null;
  }

  /**
   * Create the persistent human for a Supabase-authenticated signup. `id`
   * is the Supabase Auth user id (auth.users.id) — the two systems share
   * one identity from here on, no local mapping table needed. Caller must
   * have checked name availability; the id primary key and email unique
   * index are the last line of defense against duplicates.
   */
  async createHuman(id: string, displayName: string, email: string | null): Promise<Actor> {
    const actor: Actor = { id, kind: "human", displayName, serverId: this.serverId };
    await this.sql`
      INSERT INTO actors (id, kind, display_name, server_id, email)
      VALUES (${actor.id}, ${actor.kind}, ${actor.displayName}, ${actor.serverId}, ${email})
    `;
    return actor;
  }

  async getActor(id: string): Promise<Actor | null> {
    const rows = await this.sql<ActorRow[]>`SELECT * FROM actors WHERE id = ${id}`;
    return rows[0] ? toActor(rows[0]) : null;
  }

  async listActors(kind?: ParticipantKind): Promise<Actor[]> {
    const rows = kind
      ? await this.sql<ActorRow[]>`SELECT * FROM actors WHERE server_id = ${this.serverId} AND kind = ${kind}`
      : await this.sql<ActorRow[]>`SELECT * FROM actors WHERE server_id = ${this.serverId}`;
    return rows.map(toActor);
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}

async function ensureServer(sql: Sql): Promise<string> {
  const rows = await sql<{ value: string }[]>`SELECT value FROM meta WHERE key = 'server_id'`;
  if (rows[0]) return rows[0].value;
  const id = randomUUID();
  await sql`INSERT INTO meta (key, value) VALUES ('server_id', ${id})`;
  return id;
}

interface ActorRow {
  id: string;
  kind: ParticipantKind;
  display_name: string;
  server_id: string;
}

function toActor(row: ActorRow): Actor {
  return { id: row.id, kind: row.kind, displayName: row.display_name, serverId: row.server_id };
}
```

- [ ] **Step 2: Write `test/pgSchema.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import postgres from "postgres";
import { WorkspaceDb } from "../src/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../supabase/migrations");

/**
 * Creates a throwaway Postgres schema, applies every migration file into
 * it, and returns a WorkspaceDb scoped to it — the Postgres analogue of
 * SQLite's `:memory:` database. Each test suite gets total isolation from
 * every other suite and from `public`, and `drop()` leaves nothing behind.
 */
export async function createTestDb(): Promise<{ db: WorkspaceDb; drop: () => Promise<void> }> {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL is not set — tests need a real Postgres connection");
  const schema = `test_${randomUUID().replaceAll("-", "_")}`;

  const bootstrap = postgres(url, { max: 1 });
  await bootstrap.unsafe(`CREATE SCHEMA "${schema}"`);
  await bootstrap.end();

  const migrator = postgres(url, { connection: { search_path: schema }, max: 1 });
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    await migrator.unsafe(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8"));
  }
  await migrator.end();

  const db = await WorkspaceDb.create(url, schema);

  return {
    db,
    drop: async () => {
      await db.close();
      const cleanup = postgres(url, { max: 1 });
      await cleanup.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await cleanup.end();
    },
  };
}
```

- [ ] **Step 3: Write the failing test `test/db.test.ts`**

```ts
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { WorkspaceDb } from "../src/db";
import { createTestDb } from "./pgSchema";

describe("WorkspaceDb", () => {
  let db: WorkspaceDb;
  let drop: () => Promise<void>;

  before(async () => {
    ({ db, drop } = await createTestDb());
  });
  after(() => drop());

  test("upsertActor creates once, reuses on repeat calls with the same name", async () => {
    const first = await db.upsertActor("human", "Dana");
    const second = await db.upsertActor("human", "dana");
    assert.equal(second.id, first.id);
    assert.equal(first.serverId, db.serverId);
  });

  test("findActorByName is case-insensitive and null when absent", async () => {
    await db.upsertActor("agent", "Noodle");
    const found = await db.findActorByName("agent", "NOODLE");
    assert.ok(found);
    assert.equal(found!.displayName, "Noodle");
    assert.equal(await db.findActorByName("agent", "nope"), null);
  });

  test("createHuman uses the given id and stores email", async () => {
    const actor = await db.createHuman("11111111-1111-1111-1111-111111111111", "Harris", "h@example.com");
    assert.equal(actor.id, "11111111-1111-1111-1111-111111111111");
    const fetched = await db.getActor(actor.id);
    assert.equal(fetched?.displayName, "Harris");
  });

  test("nextRef allocates sequential per-server refs inside a transaction", async () => {
    const refs = await db.transaction(async (sql) => {
      const a = await db.nextRef(sql, db.serverId);
      const b = await db.nextRef(sql, db.serverId);
      return [a, b];
    });
    assert.notEqual(refs[0], refs[1]);
    assert.match(refs[0], /^task-\d+$/);
  });

  test("transaction rolls back on throw", async () => {
    const before = await db.listActors("human");
    await assert.rejects(
      db.transaction(async (sql) => {
        await sql`INSERT INTO actors (id, kind, display_name, server_id) VALUES (gen_random_uuid(), 'human', 'Rollback Me', ${db.serverId})`;
        throw new Error("boom");
      }),
      /boom/,
    );
    const after = await db.listActors("human");
    assert.equal(after.length, before.length);
  });
});
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /home/harris/Programming/convyio/app/packages/server
npx tsx --test test/db.test.ts
```

(Running `npx tsx --test test/db.test.ts` directly, rather than `npm test`, matters here and in every "run just this file" step below: `packages/server`'s `test` script is `tsx --test test/*.test.ts` — the shell already expands that glob to every test file before `npm test -- test/db.test.ts` could append a single-file filter, so `npm test -- <file>` runs the *entire* suite, not just that file. Since most other test files still call the pre-migration sync store API until later tasks land, running the whole suite this early would fail for reasons unrelated to this step.)

Expected: all 5 tests pass. If `SUPABASE_DB_URL` is missing/unreachable, the suite throws immediately with the explicit error from Step 2's `createTestDb` — fix connectivity before continuing (this task cannot proceed without a live Supabase Postgres connection).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/db.ts packages/server/test/pgSchema.ts packages/server/test/db.test.ts
git commit -m "Rewrite WorkspaceDb as an async Postgres client"
```

Note: the rest of the server (BoardService, MessageStore, Channels, Attachments, Auth, Roster, hub.ts, api.ts, index.ts) still references the old sync `db.db.prepare(...)` API at this point and will fail `npm run typecheck` for the server package until Tasks 4–15 land — this is expected and is resolved layer-by-layer, not file-by-file, because the change is a genuine cross-cutting async conversion (see Global Constraints). Do not attempt to make the whole monorepo typecheck between Task 3 and Task 15.

### Task 4: Rewrite `MessageStore.ts` to async Postgres

**Files:**
- Modify (full rewrite): `packages/server/src/chat/MessageStore.ts`
- Modify: `packages/server/test/messages.test.ts`, `packages/server/test/pins.test.ts` (await every now-async call)

**Interfaces:**
- Consumes: `WorkspaceDb` from Task 3 (`db.sql`, `db.transaction`).
- Produces: every `MessageStore` method becomes `async` and returns a `Promise` of its old return type; signatures otherwise unchanged (`list(): Promise<ChatMessage[]>`, `recentByChannel(channelNames, limit): Promise<ChatMessage[]>`, `olderPage(channel, before, limit): Promise<ChatMessage[]>`, `get(id): Promise<ChatMessage | null>`, `append(message): Promise<void>`, `edit(id, content): Promise<ChatMessage | null>`, `delete(id): Promise<void>`, `addReaction(...): Promise<"added"|"noop"|"capped">`, `removeReaction(...): Promise<boolean>`, `setPinned(id, pinnedBy): Promise<ChatMessage | null>`, `clear(channel?): Promise<void>`). `importLegacyJson` is deleted — it imported the pre-SQLite on-disk JSON history file, which cannot exist for a Supabase-backed deployment; its call site in `index.ts` is removed in Task 14.

- [ ] **Step 1: Rewrite `MessageStore.ts`**

```ts
import type { Attachment, ChatMessage, MessageReaction, TraceChunk } from "@workspace/shared";
import type { WorkspaceDb } from "../db";

/** Discord's cap: a message holds at most this many distinct reaction emoji. */
export const MAX_REACTION_EMOJI = 20;

/**
 * Welcome-frame history cap (newest messages kept per channel) and the
 * default page size for GET /api/messages; MAX_HISTORY_LIMIT is the hard
 * ceiling a caller-supplied `limit` clamps to.
 */
export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 100;

/** Chat history persistence. Exists so the hub never touches SQL. */
export class MessageStore {
  constructor(private store: WorkspaceDb) {}

  /** Unbounded: every message, every channel. Kept for callers (admin/debug)
   *  that genuinely want the whole table; the welcome frame uses
   *  recentByChannel() instead so history stays bounded. */
  async list(): Promise<ChatMessage[]> {
    const rows = await this.store.sql<MessageRow[]>`
      SELECT * FROM messages ORDER BY created_at ASC, seq ASC
    `;
    const reactions = await this.reactionsByMessage();
    return rows.map((row) => toMessage(row, reactions.get(row.id)));
  }

  /**
   * The newest `limit` messages in each of `channelNames`, each block
   * ascending — this is what ships in welcome.history. Clients filter
   * history per channel client-side, so a flat "last N overall" would
   * starve quiet channels; a per-channel cap keeps every channel populated.
   * Channel counts are small, so a query per channel beats a window
   * function. Reactions are hydrated in one batch query, not per-message.
   */
  async recentByChannel(channelNames: string[], limit: number): Promise<ChatMessage[]> {
    const rows = (
      await Promise.all(channelNames.map((channel) => this.newestSlice(channel, limit)))
    ).flat();
    const reactions = await this.reactionsForIds(rows.map((row) => row.id));
    return rows.map((row) => toMessage(row, reactions.get(row.id)));
  }

  /**
   * The `limit` messages in `channel` immediately older than `before`,
   * ascending (same order as list()/recentByChannel). Used by
   * GET /api/messages to page further back than the welcome cap.
   */
  async olderPage(channel: string, before: number, limit: number): Promise<ChatMessage[]> {
    const rows = await this.newestSlice(channel, limit, before);
    const reactions = await this.reactionsForIds(rows.map((row) => row.id));
    return rows.map((row) => toMessage(row, reactions.get(row.id)));
  }

  /**
   * The newest `limit` rows of `channel` older than `before` (or newest
   * overall when `before` is omitted), ascending.
   *
   * Tie-breaker: `before` is a bare created_at millisecond value with no
   * sequence attached, so when several messages share a millisecond a
   * LIMIT cut can land in the middle of that group. Splitting it would
   * mean a later call with `before` set to this page's oldest timestamp
   * either re-delivers part of the group (using <=) or drops the rest of
   * it (using <). Instead, a boundary tie is never split: if the LIMIT-th
   * row shares its created_at with rows just past the cut, those extra
   * rows come along too (the page can run slightly over `limit`). Every
   * row sharing a given created_at then always lands fully in one page, so
   * a strict `<` on the next call's `before` cleanly excludes the whole
   * tied group instead of re-slicing it — no drop, no duplicate. `seq`
   * (an identity column) plays the role SQLite's implicit `rowid` played:
   * a stable, insertion-order tiebreaker Postgres has no equivalent of.
   */
  private async newestSlice(channel: string, limit: number, before?: number): Promise<MessageRow[]> {
    const capped =
      before === undefined
        ? await this.store.sql<MessageRow[]>`
            SELECT * FROM messages WHERE channel = ${channel}
            ORDER BY created_at DESC, seq DESC LIMIT ${limit}
          `
        : await this.store.sql<MessageRow[]>`
            SELECT * FROM messages WHERE channel = ${channel} AND created_at < ${before}
            ORDER BY created_at DESC, seq DESC LIMIT ${limit}
          `;
    if (capped.length === 0 || capped.length < limit) return capped.reverse();

    // The LIMIT may have cut mid-tie; top up with the rest of that group.
    const boundary = capped[capped.length - 1].created_at;
    const tied = await this.store.sql<MessageRow[]>`
      SELECT * FROM messages WHERE channel = ${channel} AND created_at = ${boundary} ORDER BY seq DESC
    `;
    const withoutBoundary = capped.filter((row) => row.created_at !== boundary);
    return [...withoutBoundary, ...tied].reverse();
  }

  /** Single-message read, reactions included; null result = unknown id. */
  async get(id: string): Promise<ChatMessage | null> {
    const rows = await this.store.sql<MessageRow[]>`SELECT * FROM messages WHERE id = ${id}`;
    return rows[0] ? toMessage(rows[0], await this.reactionsFor(id)) : null;
  }

  async append(message: ChatMessage): Promise<void> {
    await this.store.sql`
      INSERT INTO messages
        (id, author_id, author_name, author_kind, content, channel, run_id, trace, attachments, reply_to_id, created_at)
      VALUES (
        ${message.id}, ${message.authorId}, ${message.authorName}, ${message.authorKind},
        ${message.content}, ${message.channel ?? "general"}, ${message.runId ?? null},
        ${message.trace ? JSON.stringify(message.trace) : null},
        ${message.attachments ? JSON.stringify(message.attachments) : null},
        ${message.replyToId ?? null}, ${message.timestamp}
      )
    `;
  }

  /** Replace content and stamp edited_at; null result = unknown id. The
   *  author-only rule lives in the hub, which resolves the message first. */
  async edit(id: string, content: string): Promise<ChatMessage | null> {
    const rows = await this.store.sql<MessageRow[]>`
      UPDATE messages SET content = ${content}, edited_at = ${Date.now()} WHERE id = ${id} RETURNING *
    `;
    return rows[0] ? toMessage(rows[0], await this.reactionsFor(id)) : null;
  }

  /** Hard delete: the row and its reactions go together. */
  async delete(id: string): Promise<void> {
    await this.store.transaction(async (sql) => {
      await sql`DELETE FROM message_reactions WHERE message_id = ${id}`;
      await sql`DELETE FROM messages WHERE id = ${id}`;
    });
  }

  /** Idempotent reaction add. "capped" = this would be a new emoji on a
   *  message already carrying MAX_REACTION_EMOJI distinct ones. */
  async addReaction(
    messageId: string,
    emoji: string,
    actor: { id: string; name: string },
  ): Promise<"added" | "noop" | "capped"> {
    const [emojiPresent] = await this.store.sql`
      SELECT 1 FROM message_reactions WHERE message_id = ${messageId} AND emoji = ${emoji} LIMIT 1
    `;
    if (!emojiPresent) {
      const [{ n }] = await this.store.sql<{ n: number }[]>`
        SELECT COUNT(DISTINCT emoji)::int AS n FROM message_reactions WHERE message_id = ${messageId}
      `;
      if (n >= MAX_REACTION_EMOJI) return "capped";
    }
    const result = await this.store.sql`
      INSERT INTO message_reactions (message_id, emoji, actor_id, actor_name, created_at)
      VALUES (${messageId}, ${emoji}, ${actor.id}, ${actor.name}, ${Date.now()})
      ON CONFLICT (message_id, emoji, actor_id) DO NOTHING
    `;
    return result.count > 0 ? "added" : "noop";
  }

  /** Idempotent removal; false = there was nothing to remove. */
  async removeReaction(messageId: string, emoji: string, actorId: string): Promise<boolean> {
    const result = await this.store.sql`
      DELETE FROM message_reactions WHERE message_id = ${messageId} AND emoji = ${emoji} AND actor_id = ${actorId}
    `;
    return result.count > 0;
  }

  private async reactionsFor(messageId: string): Promise<MessageReaction[] | undefined> {
    const rows = await this.store.sql<ReactionRow[]>`
      SELECT * FROM message_reactions WHERE message_id = ${messageId} ORDER BY created_at ASC, seq ASC
    `;
    return rows.length > 0 ? groupReactions(rows) : undefined;
  }

  /** All reactions grouped per message: one query, so list() never goes N+1. */
  private async reactionsByMessage(): Promise<Map<string, MessageReaction[]>> {
    const rows = await this.store.sql<ReactionRow[]>`
      SELECT * FROM message_reactions ORDER BY created_at ASC, seq ASC
    `;
    return groupByMessage(rows);
  }

  /** Reactions for exactly these messages, one query — what recentByChannel
   *  and olderPage use so a bounded read never goes N+1 either. */
  private async reactionsForIds(ids: string[]): Promise<Map<string, MessageReaction[]>> {
    if (ids.length === 0) return new Map();
    const rows = await this.store.sql<ReactionRow[]>`
      SELECT * FROM message_reactions WHERE message_id IN ${this.store.sql(ids)}
      ORDER BY created_at ASC, seq ASC
    `;
    return groupByMessage(rows);
  }

  /** Pin (recording the pinner's display name) or unpin (null); null result = unknown id. */
  async setPinned(id: string, pinnedBy: string | null): Promise<ChatMessage | null> {
    const rows = await this.store.sql<MessageRow[]>`
      UPDATE messages SET pinned_at = ${pinnedBy ? Date.now() : null}, pinned_by = ${pinnedBy}
      WHERE id = ${id} RETURNING *
    `;
    return rows[0] ? toMessage(rows[0], await this.reactionsFor(id)) : null;
  }

  /** Delete all messages, or only those in the given channel. Reactions go with them. */
  async clear(channel?: string): Promise<void> {
    await this.store.transaction(async (sql) => {
      if (channel) {
        await sql`
          DELETE FROM message_reactions
          WHERE message_id IN (SELECT id FROM messages WHERE channel = ${channel})
        `;
        await sql`DELETE FROM messages WHERE channel = ${channel}`;
      } else {
        await sql`DELETE FROM message_reactions`;
        await sql`DELETE FROM messages`;
      }
    });
  }
}

interface MessageRow {
  id: string;
  author_id: string;
  author_name: string;
  author_kind: ChatMessage["authorKind"];
  content: string;
  channel: string;
  run_id: string | null;
  trace: string | null;
  attachments: string | null;
  pinned_at: number | null;
  pinned_by: string | null;
  edited_at: number | null;
  reply_to_id: string | null;
  created_at: number;
}

interface ReactionRow {
  message_id: string;
  emoji: string;
  actor_id: string;
  actor_name: string;
  created_at: number;
}

/** Reaction rows (any mix of messages) → per-message, per-emoji groups. */
function groupByMessage(rows: ReactionRow[]): Map<string, MessageReaction[]> {
  const byMessage = new Map<string, ReactionRow[]>();
  for (const row of rows) {
    const bucket = byMessage.get(row.message_id);
    if (bucket) bucket.push(row);
    else byMessage.set(row.message_id, [row]);
  }
  return new Map([...byMessage].map(([id, bucket]) => [id, groupReactions(bucket)]));
}

/** Rows (already in reaction order) → per-emoji groups in first-reaction order. */
function groupReactions(rows: ReactionRow[]): MessageReaction[] {
  const groups: MessageReaction[] = [];
  for (const row of rows) {
    let group = groups.find((g) => g.emoji === row.emoji);
    if (!group) groups.push((group = { emoji: row.emoji, actors: [] }));
    group.actors.push({ id: row.actor_id, name: row.actor_name });
  }
  return groups;
}

function toMessage(row: MessageRow, reactions?: MessageReaction[]): ChatMessage {
  const message: ChatMessage = {
    id: row.id,
    authorId: row.author_id,
    authorName: row.author_name,
    authorKind: row.author_kind,
    content: row.content,
    timestamp: row.created_at,
    channel: row.channel,
  };
  if (row.run_id) message.runId = row.run_id;
  if (row.trace) message.trace = JSON.parse(row.trace) as TraceChunk[];
  if (row.attachments) message.attachments = JSON.parse(row.attachments) as Attachment[];
  if (row.pinned_at) {
    message.pinnedAt = row.pinned_at;
    if (row.pinned_by) message.pinnedBy = row.pinned_by;
  }
  if (row.edited_at) message.editedAt = row.edited_at;
  if (row.reply_to_id) message.replyToId = row.reply_to_id;
  if (reactions?.length) message.reactions = reactions;
  return message;
}
```

Note: `recentByChannel`'s original SQLite version ran each channel's slice sequentially (`channelNames.flatMap(...)`); the rewrite issues them concurrently via `Promise.all` since Postgres.js connections support pipelined concurrent queries and there is no shared mutable cursor state to serialize against (unlike `DatabaseSync`, which was single-threaded and synchronous by nature). Order within the flattened result no longer matters because `recentByChannel`'s caller only cares about `row.id` grouping via `reactionsForIds`, not array order across channels.

- [ ] **Step 2: Update `test/messages.test.ts` and `test/pins.test.ts`**

Every call like `store.messages.append(...)`, `env.messages.get(...)`, `store.messages.edit(...)`, etc. needs an `await` added, and every `test(...)` callback that now awaits must itself be `async`. Apply this mechanically across both files — for example:

```ts
// before
test("edits update content and set editedAt", () => {
  const msg = env.messages.get(id)!;
  ...
});

// after
test("edits update content and set editedAt", async () => {
  const msg = await env.messages.get(id);
  ...
});
```

Grep for the exact call sites and fix each one:

```bash
cd /home/harris/Programming/convyio/app
grep -n "\.messages\.\(list\|recentByChannel\|olderPage\|get\|append\|edit\|delete\|addReaction\|removeReaction\|setPinned\|clear\)(" packages/server/test/messages.test.ts packages/server/test/pins.test.ts
```

Add `await` at every reported line and make its enclosing `test(...)`/`describe(...)` callback `async` if it is not already (most already are, since they call `env.api(...)` which is already async).

- [ ] **Step 3: Run the server test suite for these two files**

```bash
cd /home/harris/Programming/convyio/app/packages/server
npx tsx --test test/messages.test.ts test/pins.test.ts
```

Expected: fails at this point with type errors from `test/helpers.ts` still constructing `WorkspaceDb` the old (sync, SQLite) way — this is expected; Task 12 fixes `helpers.ts`. Do not chase this failure yet; it is resolved when Task 12 lands. Re-run this exact command again after Task 12 and confirm it then passes.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/chat/MessageStore.ts packages/server/test/messages.test.ts packages/server/test/pins.test.ts
git commit -m "Rewrite MessageStore to async Postgres queries"
```

### Task 5: Rewrite `Channels.ts` to async Postgres

**Files:**
- Modify (full rewrite): `packages/server/src/chat/Channels.ts`
- Modify: `packages/server/test/channels.test.ts` (await every now-async call)

**Interfaces:**
- Produces: every method becomes `async` (`seed`, `list`, `listArchived`, `pinned`, `exists`, `create`, `rename`, `setArchived`, `setPinned`, `remove`), same parameter/return shapes wrapped in `Promise`. The `onCreated`/`onRenamed`/`onArchived`/`onPinned`/`onDeleted` hooks stay synchronous callbacks (`hub.ts`'s broadcast methods are not async) invoked after each method's own awaits settle.

- [ ] **Step 1: Rewrite `Channels.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { Actor } from "@workspace/shared";
import { ApiError } from "../board/BoardService";
import type { WorkspaceDb } from "../db";

const NAME_PATTERN = /^[a-z0-9-]{1,32}$/;
const MAX_CHANNELS = 100;

/**
 * Owns the set of chat channels: seeds defaults, validates names, records
 * new ones. Names are unique case-insensitively (idx_channels_name_lower),
 * so `exists` and the duplicate check agree with the constraint.
 */
export class Channels {
  /** Fan-out hooks; the composition root wires them to hub broadcasts. */
  onCreated: ((name: string) => void) | null = null;
  onRenamed: ((oldName: string, newName: string) => void) | null = null;
  onArchived: ((name: string, archived: boolean) => void) | null = null;
  onPinned: ((name: string, pinned: boolean) => void) | null = null;
  onDeleted: ((name: string) => void) | null = null;

  constructor(private store: WorkspaceDb) {}

  /** Idempotent boot seeding; NULL created_by marks system channels. */
  async seed(defaults: { name: string; isDemo: boolean }[]): Promise<void> {
    for (const { name, isDemo } of defaults) {
      await this.store.sql`
        INSERT INTO channels (id, name, created_by, is_demo, created_at)
        VALUES (${randomUUID()}, ${name}, NULL, ${isDemo}, ${Date.now()})
        ON CONFLICT (lower(name)) DO NOTHING
      `;
    }
  }

  /** Active (unarchived) channel names: pinned first (by pin order), then
   *  general, then creation order. */
  async list(): Promise<string[]> {
    const rows = await this.store.sql<{ name: string }[]>`
      SELECT name FROM channels WHERE archived_at IS NULL
      ORDER BY pinned_at IS NULL ASC, pinned_at ASC,
               name = 'general' DESC, created_at ASC, seq ASC
    `;
    return rows.map((row) => row.name);
  }

  /** Archived channel names, most recently archived first. */
  async listArchived(): Promise<string[]> {
    const rows = await this.store.sql<{ name: string }[]>`
      SELECT name FROM channels WHERE archived_at IS NOT NULL ORDER BY archived_at DESC
    `;
    return rows.map((row) => row.name);
  }

  /** Pinned (and active) channel names, in pin order. */
  async pinned(): Promise<string[]> {
    const rows = await this.store.sql<{ name: string }[]>`
      SELECT name FROM channels WHERE pinned_at IS NOT NULL AND archived_at IS NULL ORDER BY pinned_at ASC
    `;
    return rows.map((row) => row.name);
  }

  async exists(name: string): Promise<boolean> {
    const rows = await this.store.sql`SELECT 1 FROM channels WHERE name = ${name}`;
    return rows.length > 0;
  }

  /** Normalize and validate a requested name, record it, and fan out. */
  async create(actor: Actor, rawName: string): Promise<string> {
    this.requireHuman(actor);
    const name = this.normalize(rawName);
    if (await this.exists(name)) {
      throw new ApiError(409, "CHANNEL_EXISTS", `channel ${name} already exists`);
    }
    const [{ c }] = await this.store.sql<{ c: number }[]>`SELECT count(*)::int AS c FROM channels`;
    if (c >= MAX_CHANNELS) {
      throw new ApiError(409, "CHANNEL_LIMIT", `channel cap of ${MAX_CHANNELS} reached`);
    }
    await this.store.sql`
      INSERT INTO channels (id, name, created_by, is_demo, created_at)
      VALUES (${randomUUID()}, ${name}, ${actor.id}, false, ${Date.now()})
    `;
    this.onCreated?.(name);
    return name;
  }

  /** Rename a channel; messages keep pointing at it under the new name.
   *  "general" is the default channel messages fall back to and stays fixed. */
  async rename(actor: Actor, name: string, rawNewName: string): Promise<string> {
    this.requireHuman(actor);
    await this.requireMutable(name);
    const newName = this.normalize(rawNewName);
    if (newName !== name && (await this.exists(newName))) {
      throw new ApiError(409, "CHANNEL_EXISTS", `channel ${newName} already exists`);
    }
    await this.store.transaction(async (sql) => {
      await sql`UPDATE channels SET name = ${newName} WHERE name = ${name}`;
      await sql`UPDATE messages SET channel = ${newName} WHERE channel = ${name}`;
    });
    this.onRenamed?.(name, newName);
    return newName;
  }

  async setArchived(actor: Actor, name: string, archived: boolean): Promise<void> {
    this.requireHuman(actor);
    await this.requireMutable(name);
    await this.store.sql`
      UPDATE channels SET archived_at = ${archived ? Date.now() : null} WHERE name = ${name}
    `;
    this.onArchived?.(name, archived);
  }

  async setPinned(actor: Actor, name: string, pinned: boolean): Promise<void> {
    this.requireHuman(actor);
    if (!(await this.exists(name))) {
      throw new ApiError(404, "NOT_FOUND", `no such channel: ${name}`);
    }
    await this.store.sql`
      UPDATE channels SET pinned_at = ${pinned ? Date.now() : null} WHERE name = ${name}
    `;
    this.onPinned?.(name, pinned);
  }

  /** Drop the channel and its messages; "general" cannot be removed. */
  async remove(actor: Actor, name: string): Promise<void> {
    this.requireHuman(actor);
    await this.requireMutable(name);
    await this.store.sql`DELETE FROM channels WHERE name = ${name}`;
    this.onDeleted?.(name);
  }

  private requireHuman(actor: Actor): void {
    if (actor.kind !== "human") {
      throw new ApiError(403, "FORBIDDEN", "only humans can manage channels");
    }
  }

  /** Exists and isn't the fixed default channel every message falls back to. */
  private async requireMutable(name: string): Promise<void> {
    if (!(await this.exists(name))) {
      throw new ApiError(404, "NOT_FOUND", `no such channel: ${name}`);
    }
    if (name === "general") {
      throw new ApiError(400, "CHANNEL_FIXED", "the general channel cannot be changed");
    }
  }

  private normalize(rawName: string): string {
    const name = rawName.trim().toLowerCase().replace(/\s+/g, "-");
    if (!NAME_PATTERN.test(name)) {
      throw new ApiError(
        400,
        "BAD_CHANNEL_NAME",
        "channel names are 1-32 characters of a-z, 0-9, and -",
      );
    }
    return name;
  }
}
```

- [ ] **Step 2: Update `test/channels.test.ts`**

```bash
cd /home/harris/Programming/convyio/app
grep -n "\.channels\.\(seed\|list\|listArchived\|pinned\|exists\|create\|rename\|setArchived\|setPinned\|remove\)(" packages/server/test/channels.test.ts
```

Add `await` at every reported call site and make the enclosing callback `async`, same mechanical pattern as Task 4 Step 2.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/chat/Channels.ts packages/server/test/channels.test.ts
git commit -m "Rewrite Channels to async Postgres queries"
```

Note: like Task 4, running the full test file here will still fail until `test/helpers.ts` is rewritten in Task 12 — expected, do not chase it yet.

### Task 6: Rewrite `BoardService.ts` to async Postgres (transaction threading)

**Files:**
- Modify (full rewrite): `packages/server/src/board/BoardService.ts`
- Modify: `packages/server/test/board.test.ts`, `packages/server/test/hardening.test.ts` (await every now-async call; `authorizeMutation` calls specifically — see Task 7)

**Interfaces:**
- Consumes: `WorkspaceDb.transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>` and `WorkspaceDb.nextRef(sql, serverId)` from Task 3.
- Produces: every public `BoardService` method becomes `async` (`list`, `find`, `findAnywhere`, `events`, `create`, `approve`, `deny`, `start`, `complete`, `block`, `unblock`, `edit`, `softDelete`, `reopen`), same parameter/return shapes wrapped in `Promise`. `onEvent` stays a synchronous callback, invoked (not awaited) after each mutating method's transaction commits — `hub.ts`'s `broadcastBoardEvent` is itself synchronous, so this needs no change.
- Key internal change other tasks must know about: `mutate()`'s `apply` callback now takes the transaction's `sql` and is itself `async`: `apply: (sql: Sql) => Promise<string>`. Every one of `create`/`approve`/`deny`/`start`/`complete`/`block`/`unblock`/`edit`/`softDelete`/`reopen` passes such a callback.

- [ ] **Step 1: Rewrite `BoardService.ts`**

```ts
import { randomUUID } from "node:crypto";
import type {
  Actor,
  BoardEventEnvelope,
  BoardEventPayload,
  BoardEventType,
  BoardItem,
  BoardItemEvent,
  ItemStatus,
} from "@workspace/shared";
import type { Sql, WorkspaceDb } from "../db";
import { validateScopePaths } from "./scope";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const selectItem = (sql: Sql) => sql`
  SELECT i.*, c.display_name AS created_by_name, a.display_name AS approved_by_name,
         o.display_name AS owner_name
  FROM board_items i
  JOIN actors c ON c.id = i.created_by
  LEFT JOIN actors a ON a.id = i.approved_by
  LEFT JOIN actors o ON o.id = i.owner
`;

/**
 * All board state changes flow through here. Each transition mutates
 * board_items and appends exactly one board_events row in the same
 * transaction (I5), then hands the envelope to the fan-out hook.
 */
export class BoardService {
  /** Realtime fan-out hook; invoked after the transaction commits. */
  onEvent: ((envelope: BoardEventEnvelope) => void) | null = null;

  constructor(private store: WorkspaceDb) {}

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  async list(
    serverId: string,
    opts: { status?: ItemStatus; includeDeleted?: boolean } = {},
  ): Promise<BoardItem[]> {
    const sql = this.store.sql;
    const statusFilter = opts.status
      ? sql`AND i.status = ${opts.status}`
      // Default view excludes denied alongside deleted.
      : opts.includeDeleted
        ? sql``
        : sql`AND i.status != 'denied'`;
    const deletedFilter = opts.includeDeleted ? sql`` : sql`AND i.deleted_at IS NULL`;
    const rows = await sql<ItemRow[]>`
      ${selectItem(sql)}
      WHERE i.server_id = ${serverId} ${statusFilter} ${deletedFilter}
      ORDER BY i.created_at DESC
    `;
    return rows.map(toItem);
  }

  /** Look up by uuid or ref within a server. Includes deleted rows. */
  async find(serverId: string, idOrRef: string): Promise<BoardItem | null> {
    const sql = this.store.sql;
    const rows = await sql<ItemRow[]>`
      ${selectItem(sql)} WHERE i.server_id = ${serverId} AND (i.id = ${idOrRef} OR i.ref = ${idOrRef})
    `;
    return rows[0] ? toItem(rows[0]) : null;
  }

  /** Cross-server lookup used by authz to distinguish WRONG_SERVER. */
  async findAnywhere(idOrRef: string): Promise<BoardItem | null> {
    const sql = this.store.sql;
    const rows = await sql<ItemRow[]>`${selectItem(sql)} WHERE i.id = ${idOrRef} OR i.ref = ${idOrRef}`;
    return rows[0] ? toItem(rows[0]) : null;
  }

  /** An item's audit trail, oldest first (the events table is append-only). */
  async events(serverId: string, idOrRef: string): Promise<BoardItemEvent[]> {
    const item = await this.find(serverId, idOrRef);
    if (!item) throw new ApiError(404, "ITEM_NOT_FOUND", `no board item ${idOrRef}`);
    const rows = await this.store.sql<
      {
        id: number;
        type: BoardItemEvent["type"];
        actor_id: string;
        payload: string;
        created_at: number;
        actor_name: string;
        actor_kind: BoardItemEvent["actorKind"];
      }[]
    >`
      SELECT e.id, e.type, e.actor_id, e.payload, e.created_at,
             a.display_name AS actor_name, a.kind AS actor_kind
      FROM board_events e JOIN actors a ON a.id = e.actor_id
      WHERE e.item_id = ${item.id} ORDER BY e.id ASC
    `;
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      actorId: r.actor_id,
      actorName: r.actor_name,
      actorKind: r.actor_kind,
      payload: JSON.parse(r.payload) as BoardEventPayload,
      createdAt: r.created_at,
    }));
  }

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  /** Human create (approved by construction) or agent proposal (I2). */
  async create(
    actor: Actor,
    input: {
      title: string;
      description?: string;
      why?: string;
      effect?: string;
      scopePaths?: string[];
    },
  ): Promise<BoardItem> {
    const human = actor.kind === "human";
    if (!human && (!input.why || !input.effect)) {
      throw new ApiError(400, "PROPOSAL_FIELDS_REQUIRED", "agent proposals require why and effect");
    }
    // Agent proposals must name the paths they intend to touch, so approval
    // grants a bounded scope instead of unrestricted workspace access.
    if (!human && (!input.scopePaths || input.scopePaths.length === 0)) {
      throw new ApiError(400, "SCOPE_REQUIRED", "agent proposals require non-empty scope_paths");
    }
    const scopePaths = this.normalizedScope(input.scopePaths);
    const now = Date.now();
    const id = randomUUID();
    return this.mutate(actor, human ? "item.created" : "item.proposed", async (sql) => {
      const ref = await this.store.nextRef(sql, actor.serverId);
      await sql`
        INSERT INTO board_items
          (id, server_id, ref, title, description, status, origin, created_by,
           approved_by, owner, proposal_why, proposal_effect, scope_paths,
           created_at, approved_at)
        VALUES (
          ${id}, ${actor.serverId}, ${ref}, ${input.title}, ${input.description ?? null},
          ${human ? "approved" : "proposed"}, ${actor.kind}, ${actor.id},
          ${human ? actor.id : null}, ${null},
          ${human ? null : input.why!}, ${human ? null : input.effect!},
          ${scopePaths ? JSON.stringify(scopePaths) : null},
          ${now}, ${human ? now : null}
        )
      `;
      return id;
    });
  }

  async approve(actor: Actor, idOrRef: string): Promise<BoardItem> {
    this.assertHuman(actor, "AGENT_CANNOT_APPROVE");
    const item = await this.mustFind(actor.serverId, idOrRef);
    this.assertStatus(item, ["proposed"]);
    return this.mutate(actor, "item.approved", async (sql) => {
      await sql`
        UPDATE board_items SET status = 'approved', approved_by = ${actor.id}, approved_at = ${Date.now()}
        WHERE id = ${item.id}
      `;
      return item.id;
    });
  }

  async deny(actor: Actor, idOrRef: string, reason?: string): Promise<BoardItem> {
    this.assertHuman(actor, "AGENT_CANNOT_APPROVE");
    const item = await this.mustFind(actor.serverId, idOrRef);
    this.assertStatus(item, ["proposed"]);
    return this.mutate(
      actor,
      "item.denied",
      async (sql) => {
        await sql`UPDATE board_items SET status = 'denied' WHERE id = ${item.id}`;
        return item.id;
      },
      reason ? { reason } : {},
    );
  }

  async start(actor: Actor, idOrRef: string): Promise<BoardItem> {
    const item = await this.mustFind(actor.serverId, idOrRef);
    this.assertStatus(item, ["approved"]);
    return this.mutate(actor, "item.started", async (sql) => {
      await sql`
        UPDATE board_items SET status = 'in_progress', started_at = ${Date.now()},
          owner = COALESCE(owner, ${actor.id}) WHERE id = ${item.id}
      `;
      return item.id;
    });
  }

  async complete(actor: Actor, idOrRef: string): Promise<BoardItem> {
    const item = await this.mustFind(actor.serverId, idOrRef);
    this.assertStatus(item, ["in_progress", "blocked"]);
    return this.mutate(actor, "item.completed", async (sql) => {
      await sql`UPDATE board_items SET status = 'done', completed_at = ${Date.now()} WHERE id = ${item.id}`;
      return item.id;
    });
  }

  async block(actor: Actor, idOrRef: string, reason: string): Promise<BoardItem> {
    const item = await this.mustFind(actor.serverId, idOrRef);
    this.assertStatus(item, ["in_progress"]);
    return this.mutate(
      actor,
      "item.blocked",
      async (sql) => {
        await sql`UPDATE board_items SET status = 'blocked' WHERE id = ${item.id}`;
        return item.id;
      },
      { reason },
    );
  }

  async unblock(actor: Actor, idOrRef: string): Promise<BoardItem> {
    const item = await this.mustFind(actor.serverId, idOrRef);
    this.assertStatus(item, ["blocked"]);
    return this.mutate(actor, "item.unblocked", async (sql) => {
      await sql`UPDATE board_items SET status = 'in_progress' WHERE id = ${item.id}`;
      return item.id;
    });
  }

  async edit(
    actor: Actor,
    idOrRef: string,
    fields: {
      title?: string;
      description?: string | null;
      owner?: string | null;
      scopePaths?: string[] | null;
    },
  ): Promise<BoardItem> {
    this.assertHuman(actor, "HUMAN_ONLY");
    const item = await this.mustFind(actor.serverId, idOrRef);
    if (fields.owner != null) {
      const owner = await this.store.getActor(fields.owner);
      if (!owner || owner.serverId !== actor.serverId) {
        throw new ApiError(400, "OWNER_NOT_FOUND", "owner must be an actor on this server");
      }
    }
    const scopePaths =
      fields.scopePaths === undefined
        ? undefined
        : (this.normalizedScope(fields.scopePaths ?? undefined) ?? null);
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of ["title", "description", "owner"] as const) {
      if (fields[key] !== undefined && fields[key] !== item[key]) {
        changed[key] = { from: item[key], to: fields[key] };
      }
    }
    if (scopePaths !== undefined && JSON.stringify(scopePaths) !== JSON.stringify(item.scopePaths)) {
      changed.scopePaths = { from: item.scopePaths, to: scopePaths };
    }
    if (Object.keys(changed).length === 0) return item;
    return this.mutate(
      actor,
      "item.edited",
      async (sql) => {
        await sql`
          UPDATE board_items SET
            title = ${fields.title !== undefined ? fields.title : item.title},
            description = ${fields.description !== undefined ? fields.description : item.description},
            owner = ${fields.owner !== undefined ? fields.owner : item.owner},
            scope_paths = ${
              scopePaths !== undefined
                ? scopePaths && JSON.stringify(scopePaths)
                : item.scopePaths && JSON.stringify(item.scopePaths)
            }
          WHERE id = ${item.id}
        `;
        return item.id;
      },
      { changed },
    );
  }

  /** Soft delete. Halts in-progress work: authz fails afterwards (I4). */
  async softDelete(actor: Actor, idOrRef: string): Promise<BoardItem> {
    this.assertHuman(actor, "HUMAN_ONLY");
    const item = await this.mustFind(actor.serverId, idOrRef);
    if (item.deletedAt) throw new ApiError(409, "ALREADY_DELETED", `${item.ref} is already deleted`);
    return this.mutate(actor, "item.deleted", async (sql) => {
      await sql`UPDATE board_items SET deleted_at = ${Date.now()} WHERE id = ${item.id}`;
      return item.id;
    });
  }

  async reopen(actor: Actor, idOrRef: string): Promise<BoardItem> {
    this.assertHuman(actor, "HUMAN_ONLY");
    const item = await this.mustFind(actor.serverId, idOrRef);
    this.assertStatus(item, ["done"]);
    return this.mutate(actor, "item.reopened", async (sql) => {
      await sql`UPDATE board_items SET status = 'approved', completed_at = NULL WHERE id = ${item.id}`;
      return item.id;
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Run a mutation and its audit row in one transaction (I5), then fan out
   * the envelope after commit. `apply` receives the transaction's own `sql`
   * — every query inside it (including a nested `nextRef` call) must use
   * that `sql`, not `this.store.sql`, to stay inside the same transaction.
   */
  private async mutate(
    actor: Actor,
    type: BoardEventType,
    apply: (sql: Sql) => Promise<string>,
    payload: BoardEventPayload = {},
  ): Promise<BoardItem> {
    const itemId = await this.store.transaction(async (sql) => {
      const id = await apply(sql);
      await sql`
        INSERT INTO board_events (server_id, item_id, type, actor_id, payload, created_at)
        VALUES (${actor.serverId}, ${id}, ${type}, ${actor.id}, ${JSON.stringify(payload)}, ${Date.now()})
      `;
      return id;
    });
    const item = (await this.find(actor.serverId, itemId))!;
    this.onEvent?.({
      channel: "board",
      type,
      server_id: actor.serverId,
      actor: { id: actor.id, kind: actor.kind, display_name: actor.displayName },
      item,
      payload,
      ts: new Date().toISOString(),
    });
    return item;
  }

  /** Validate + normalize scope entries, or undefined when none given. */
  private normalizedScope(entries: string[] | undefined): string[] | undefined {
    if (entries === undefined) return undefined;
    const result = validateScopePaths(entries);
    if ("error" in result) throw new ApiError(400, "BAD_SCOPE", result.error);
    return result.paths;
  }

  private async mustFind(serverId: string, idOrRef: string): Promise<BoardItem> {
    const item = await this.find(serverId, idOrRef);
    if (!item) throw new ApiError(404, "ITEM_NOT_FOUND", `no board item ${idOrRef}`);
    if (item.deletedAt) throw new ApiError(409, "ITEM_DELETED", `${item.ref} is deleted`);
    return item;
  }

  /** I1: approval authority is asserted against the connection identity. */
  private assertHuman(actor: Actor, code: string): void {
    if (actor.kind !== "human") {
      throw new ApiError(403, code, "humans only");
    }
  }

  private assertStatus(item: BoardItem, allowed: ItemStatus[]): void {
    if (!allowed.includes(item.status)) {
      throw new ApiError(
        409,
        "INVALID_TRANSITION",
        `${item.ref} is ${item.status}; expected ${allowed.join(" or ")}`,
      );
    }
  }
}

interface ItemRow {
  id: string;
  server_id: string;
  ref: string;
  title: string;
  description: string | null;
  status: ItemStatus;
  origin: "human" | "agent";
  created_by: string;
  approved_by: string | null;
  owner: string | null;
  proposal_why: string | null;
  proposal_effect: string | null;
  scope_paths: string | null;
  created_at: number;
  approved_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  deleted_at: number | null;
  created_by_name: string;
  approved_by_name: string | null;
  owner_name: string | null;
}

function toItem(row: ItemRow): BoardItem {
  return {
    id: row.id,
    serverId: row.server_id,
    ref: row.ref,
    title: row.title,
    description: row.description,
    status: row.status,
    origin: row.origin,
    createdBy: row.created_by,
    approvedBy: row.approved_by,
    owner: row.owner,
    proposalWhy: row.proposal_why,
    proposalEffect: row.proposal_effect,
    scopePaths: row.scope_paths ? (JSON.parse(row.scope_paths) as string[]) : null,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    deletedAt: row.deleted_at,
    createdByName: row.created_by_name,
    approvedByName: row.approved_by_name ?? undefined,
    ownerName: row.owner_name ?? undefined,
  };
}
```

Note on `selectItem(sql)` embedded inside another `sql\`...\`` template (e.g. in `list()`/`find()`/`findAnywhere()`): postgres.js supports composing a query from nested `sql\`...\`` fragments — a fragment built from the same `Sql` instance can be interpolated into another template from that instance and is spliced in as raw SQL, not bound as a parameter value (unlike interpolating a plain string or number, which is always parameter-bound). This is what makes the conditional `statusFilter`/`deletedFilter` fragments in `list()` safe and correct.

- [ ] **Step 2: Update `test/board.test.ts` and `test/hardening.test.ts`**

```bash
cd /home/harris/Programming/convyio/app
grep -n "env\.service\.\(list\|find\|findAnywhere\|events\|create\|approve\|deny\|start\|complete\|block\|unblock\|edit\|softDelete\|reopen\)(" packages/server/test/board.test.ts packages/server/test/hardening.test.ts
```

Add `await` at every reported call site and make the enclosing callback `async`. `authorizeMutation(...)` calls in these same files are handled in Task 7 (it also becomes async, since it calls `board.findAnywhere`).

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/board/BoardService.ts packages/server/test/board.test.ts packages/server/test/hardening.test.ts
git commit -m "Rewrite BoardService to async Postgres with transaction-scoped sql threading"
```

### Task 7: Make `Toolman.authorizeMutation` async

**Files:**
- Modify: `packages/server/src/board/Toolman.ts:36-89` (the `authorizeMutation` function signature and its one `board.findAnywhere` call) and `:111` (its call site in `execute`)
- Modify: `packages/server/test/hardening.test.ts`, `packages/server/test/board.test.ts` (every `authorizeMutation(...)` call site, ~9 total across both files)

**Interfaces:**
- Consumes: `BoardService.findAnywhere(idOrRef): Promise<BoardItem | null>` from Task 6.
- Produces: `export async function authorizeMutation(actor: Actor, boardItemRef: string | null, action: { name: string; path?: string }, board: BoardService): Promise<AuthzResult>` — same parameters and resolved type, now wrapped in a `Promise`. `isMutating` is unaffected (pure, no board access).

- [ ] **Step 1: Change the signature and the one async call inside it**

In `packages/server/src/board/Toolman.ts`, change:

```ts
export function authorizeMutation(
  actor: Actor,
  boardItemRef: string | null,
  action: { name: string; path?: string },
  board: BoardService,
): AuthzResult {
```

to:

```ts
export async function authorizeMutation(
  actor: Actor,
  boardItemRef: string | null,
  action: { name: string; path?: string },
  board: BoardService,
): Promise<AuthzResult> {
```

and change:

```ts
  const item = board.findAnywhere(boardItemRef);
```

to:

```ts
  const item = await board.findAnywhere(boardItemRef);
```

Nothing else in the function body changes — every other line is pure logic over already-resolved values.

- [ ] **Step 2: Await it at its one call site inside `execute`**

In the same file, change:

```ts
    const authz = authorizeMutation(
      actor,
      boardItemRef,
      { name: action.kind, path: "path" in action ? action.path : undefined },
      this.board,
    );
```

to:

```ts
    const authz = await authorizeMutation(
      actor,
      boardItemRef,
      { name: action.kind, path: "path" in action ? action.path : undefined },
      this.board,
    );
```

(`execute` is already `async` and already `await`s other things, so no further signature change is needed there.)

- [ ] **Step 3: Update every test call site**

```bash
cd /home/harris/Programming/convyio/app
grep -n "authorizeMutation(" packages/server/test/hardening.test.ts packages/server/test/board.test.ts
```

For each reported line, prefix the call with `await` and ensure its enclosing `test(...)` callback is `async`. Every one of these currently reads `const authz = authorizeMutation(...)`; change to `const authz = await authorizeMutation(...)`.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/board/Toolman.ts packages/server/test/hardening.test.ts packages/server/test/board.test.ts
git commit -m "Make authorizeMutation async to match BoardService.findAnywhere"
```

### Task 8: Rewrite `Attachments.ts` to use Supabase Storage

**Files:**
- Modify (full rewrite): `packages/server/src/chat/Attachments.ts`
- Modify: `packages/server/test/attachments.test.ts`

**Interfaces:**
- Consumes: a Supabase admin `SupabaseClient` (service-role key, created in Task 14's `index.ts` wiring and Task 12's test helpers) and the `attachments` Storage bucket from Task 1 Step 4.
- Produces: `class Attachments { constructor(store: WorkspaceDb, supabase: SupabaseClient); async save(uploader: Actor, meta: {...}, bytes: Buffer): Promise<Attachment>; async get(id: string): Promise<{ attachment: Attachment; blob: Blob } | null>; async bind(messageId: string, ids: string[], senderId: string): Promise<Attachment[]>; async sweepOrphans(olderThanMs?: number): Promise<void>; }`. `get()`'s return shape changes from `{ attachment, filePath: string }` to `{ attachment, blob: Blob }` — Task 10 updates `board/api.ts`'s `serveUpload` to stream from the `Blob` instead of `fs.createReadStream`.

- [ ] **Step 1: Rewrite `Attachments.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Actor, Attachment } from "@workspace/shared";
import { ApiError } from "../board/BoardService";
import type { WorkspaceDb } from "../db";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Unbound uploads older than this are dead: the send they belonged to never happened. */
const ORPHAN_TTL_MS = 60 * 60 * 1000;

const BUCKET = "attachments";

/**
 * Owns uploaded files: stores bytes in the Supabase "attachments" bucket,
 * records metadata, binds them to messages, serves them back. Objects are
 * keyed by <id> with no extension — the mime type lives in the attachments
 * table, and the id is the capability that grants access to the file (the
 * bucket is private; only this server's service-role client can read it).
 */
export class Attachments {
  constructor(
    private store: WorkspaceDb,
    private supabase: SupabaseClient,
  ) {}

  async save(
    uploader: Actor,
    meta: { name: string; mime: string; width?: number; height?: number },
    bytes: Buffer,
  ): Promise<Attachment> {
    // Lazy orphan sweep on the write path keeps the store bounded without timers.
    await this.sweepOrphans();
    if (bytes.length === 0) {
      throw new ApiError(400, "EMPTY_FILE", "attachment has no bytes");
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new ApiError(413, "TOO_LARGE", "attachment exceeds 10 MiB");
    }
    const id = randomUUID();
    const name = sanitizeName(meta.name);
    const isImage = meta.mime.startsWith("image/");
    const width = isImage ? (meta.width ?? null) : null;
    const height = isImage ? (meta.height ?? null) : null;
    const { error } = await this.supabase.storage.from(BUCKET).upload(id, bytes, {
      contentType: meta.mime,
    });
    if (error) throw new ApiError(500, "UPLOAD_FAILED", `could not store the file: ${error.message}`);
    await this.store.sql`
      INSERT INTO attachments
        (id, uploader_id, message_id, name, mime, size, width, height, created_at)
      VALUES (${id}, ${uploader.id}, NULL, ${name}, ${meta.mime}, ${bytes.length}, ${width}, ${height}, ${Date.now()})
    `;
    return toAttachment({ id, name, mime: meta.mime, size: bytes.length, width, height });
  }

  async get(id: string): Promise<{ attachment: Attachment; blob: Blob } | null> {
    const rows = await this.store.sql<AttachmentRow[]>`SELECT * FROM attachments WHERE id = ${id}`;
    const row = rows[0];
    if (!row) return null;
    const { data, error } = await this.supabase.storage.from(BUCKET).download(row.id);
    if (error || !data) return null;
    return { attachment: toAttachment(row), blob: data };
  }

  /**
   * Attach uploads to a message being sent. Every id must be an unbound
   * upload belonging to the sender, or the whole bind rolls back. Returns
   * the attachments in the given order.
   */
  async bind(messageId: string, ids: string[], senderId: string): Promise<Attachment[]> {
    return this.store.transaction((sql) =>
      Promise.all(
        ids.map(async (id) => {
          const rows = await sql<AttachmentRow[]>`SELECT * FROM attachments WHERE id = ${id}`;
          const row = rows[0];
          if (!row || row.message_id !== null || row.uploader_id !== senderId) {
            throw new ApiError(400, "BAD_ATTACHMENT", `attachment ${id} is not an unbound upload of yours`);
          }
          await sql`UPDATE attachments SET message_id = ${messageId} WHERE id = ${id}`;
          return toAttachment(row);
        }),
      ),
    );
  }

  /** Delete rows and objects for unbound uploads older than the cutoff. */
  async sweepOrphans(olderThanMs = ORPHAN_TTL_MS): Promise<void> {
    const rows = await this.store.sql<{ id: string }[]>`
      DELETE FROM attachments WHERE message_id IS NULL AND created_at < ${Date.now() - olderThanMs}
      RETURNING id
    `;
    if (rows.length === 0) return;
    await this.supabase.storage.from(BUCKET).remove(rows.map((r) => r.id));
  }
}

/**
 * Keep a readable basename: strip directories and control chars, cap length.
 * Double quotes go too so the name can sit unescaped in a Content-Disposition
 * header.
 */
function sanitizeName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, "").trim().slice(0, 128);
  return cleaned || "file";
}

interface AttachmentRow {
  id: string;
  uploader_id: string;
  message_id: string | null;
  name: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  created_at: number;
}

function toAttachment(
  row: Pick<AttachmentRow, "id" | "name" | "mime" | "size" | "width" | "height">,
): Attachment {
  const attachment: Attachment = {
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    url: `/api/uploads/${row.id}/${encodeURIComponent(row.name)}`,
  };
  if (row.width !== null) attachment.width = row.width;
  if (row.height !== null) attachment.height = row.height;
  return attachment;
}
```

Note: `sweepOrphans` deliberately does not fail the caller if the Storage `remove` call errors (e.g. an object already gone) — `save()`'s upload path only needs the DB rows swept so the bounded-store guarantee holds; a stray Storage object left behind after a failed remove is a cheap, self-correcting leak (the next sweep with a matching id list would simply no-op on it) and not worth threading error handling for.

- [ ] **Step 2: Update `test/attachments.test.ts`**

The test file currently constructs `new Attachments(db, uploadsDir)` where `uploadsDir` is a temp directory — this construction now happens inside `test/helpers.ts` (Task 12), which is imported by this test file via `createEnv()`. Update every direct call site of `env.attachments.save(...)`, `env.attachments.get(...)`, `env.attachments.bind(...)`, `env.attachments.sweepOrphans(...)` to `await` them, and make enclosing callbacks `async`:

```bash
cd /home/harris/Programming/convyio/app
grep -n "\.attachments\.\(save\|get\|bind\|sweepOrphans\)(" packages/server/test/attachments.test.ts
```

Also update any assertion that reads `result.filePath` (the old shape) to read `result.blob` instead — search for `filePath` in this file and adjust: a test that previously did `fs.readFileSync(found.filePath)` to verify saved bytes now does `Buffer.from(await found.blob.arrayBuffer())`.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/chat/Attachments.ts packages/server/test/attachments.test.ts
git commit -m "Rewrite Attachments to use Supabase Storage instead of local disk"
```

Note: like earlier tasks, `npm test` for this file will not pass until `test/helpers.ts` is rewritten in Task 12 to construct the Supabase admin client and pass it here instead of a temp directory — expected, do not chase it yet.

### Task 9: Rewrite `roster.ts` to async

**Files:**
- Modify (full rewrite): `packages/server/src/roster.ts`

**Interfaces:**
- Consumes: `WorkspaceDb.upsertActor(kind, displayName): Promise<Actor>` and `WorkspaceDb.listActors(kind?): Promise<Actor[]>` from Task 3.
- Produces: `class Roster { constructor(db: WorkspaceDb); static async create(db: WorkspaceDb): Promise<Roster>; join(kind, name): Promise<Participant>; get(kind, name): Participant | undefined; list(): Participant[]; onlineAgentName(): string | null; setOnline(id, online): void; removeHuman(id): void; }`. The constructor can no longer synchronously seed agent actors from `db.listActors("agent")` (that call is now async), so boot-time seeding moves to a new `static async create(db)` factory — every construction site (`index.ts`, `test/helpers.ts`) changes from `new Roster(db)` to `await Roster.create(db)`. `get`/`list`/`onlineAgentName`/`setOnline`/`removeHuman` stay synchronous — they only touch the in-memory `known` map built at construction/join time, never the DB directly.

- [ ] **Step 1: Rewrite `roster.ts`**

```ts
import type { Participant, ParticipantKind } from "@workspace/shared";
import type { WorkspaceDb } from "./db";

/**
 * The participant roster: persistent identity plus live presence, keyed by
 * kind:name so a rejoin reclaims the same identity. Exists so the hub only
 * routes frames and never decides who is in the room.
 */
export class Roster {
  private known = new Map<string, Participant>();

  private constructor(private db: WorkspaceDb) {}

  /**
   * Async factory: agents are permanent members of the server, not
   * ephemeral connections, so every agent actor must be loaded into the
   * roster before the server accepts connections (grey/offline until its
   * process connects). Humans stay presence-only by design.
   */
  static async create(db: WorkspaceDb): Promise<Roster> {
    const roster = new Roster(db);
    for (const actor of await db.listActors("agent")) {
      roster.known.set(rosterKey("agent", actor.displayName), {
        id: actor.id,
        name: actor.displayName,
        kind: "agent",
        status: "",
        runState: "idle",
        online: false,
      });
    }
    return roster;
  }

  /**
   * Find-or-create the participant for a joining connection. Participant
   * identity is the persistent actor identity, so board attribution and
   * presence agree on ids.
   */
  async join(kind: ParticipantKind, name: string): Promise<Participant> {
    const key = rosterKey(kind, name);
    let participant = this.known.get(key);
    if (!participant) {
      const actor = await this.db.upsertActor(kind, name);
      participant = {
        id: actor.id,
        name: actor.displayName,
        kind,
        status: "",
        runState: "idle",
        online: true,
      };
      this.known.set(key, participant);
    }
    participant.online = true;
    participant.runState = "idle";
    return participant;
  }

  get(kind: ParticipantKind, name: string): Participant | undefined {
    return this.known.get(rosterKey(kind, name));
  }

  list(): Participant[] {
    return [...this.known.values()];
  }

  onlineAgentName(): string | null {
    for (const p of this.known.values()) {
      if (p.kind === "agent" && p.online) return p.name;
    }
    return null;
  }

  setOnline(id: string, online: boolean): void {
    for (const p of this.known.values()) {
      if (p.id === id) p.online = online;
    }
  }

  /** Humans exist only while a tab is open; dropping one logs it out. */
  removeHuman(id: string): void {
    for (const [key, p] of this.known) {
      if (p.id === id && p.kind === "human") this.known.delete(key);
    }
  }
}

function rosterKey(kind: ParticipantKind, name: string): string {
  return `${kind}:${name.toLowerCase()}`;
}
```

- [ ] **Step 2: Commit**

```bash
cd /home/harris/Programming/convyio/app
git add packages/server/src/roster.ts
git commit -m "Rewrite Roster to async Postgres-backed actor lookups"
```

Note: `index.ts` (`new Roster(db)`) and `test/helpers.ts` (`new Roster(db)`) both break at this point — fixed in Task 14 and Task 12 respectively. Expected, matching the layered-rollout note in Task 3.

### Task 10: Replace `Auth.ts`/`googleIdToken.ts` with Supabase Auth verification

**Files:**
- Delete: `packages/server/src/auth/googleIdToken.ts`
- Modify (full rewrite): `packages/server/src/auth/Auth.ts`
- Modify (full rewrite): `packages/server/src/auth/joinPolicy.ts`
- Modify: `packages/server/test/auth.test.ts` (delete the `googleIdToken verifier` describe block; rewrite the `Auth`-level tests against the new API — see Step 3)

**Interfaces:**
- Consumes: `@supabase/supabase-js`'s `SupabaseClient` (constructed with the **service-role** key, so `auth.getUser(jwt)` can verify any user's token, not just a session it created itself), `WorkspaceDb.getActor`/`findActorByName`/`createHuman` from Task 3.
- Produces:
  - `class Auth { constructor(store: WorkspaceDb, supabase: SupabaseClient); async resolveSession(jwt: string): Promise<Actor | null>; async session(jwt: string): Promise<{ status: "ok"; username: string } | { status: "needs_username" }>; async claimUsername(jwt: string, username: string): Promise<{ username: string }>; }`
  - `createJoinGate(auth: Auth, agentToken: string | null): (join: JoinEvent) => Promise<JoinDecision>` — now returns a function whose result is a `Promise`, not a bare `JoinDecision`. This is the seam that forces `hub.ts`'s `HubOptions.authorizeJoin` and `handleJoin` to become async in Task 11.
  - Deleted entirely: `LoginResult`, `PendingSignup`, `hashPassword`/`verifyPassword`/`DUMMY_HASH`, `loginWithGoogle`/`completeSignup`/`signupWithEmail`/`loginWithEmail`/`revoke`/`issueSession`/`sweepSessions`/`sweepSignups`, `GoogleIdentity`/`Jwks`/`JwksFetcher`/`createGoogleIdTokenVerifier`/`fetchGoogleJwks`. There is no more server-issued login session token, no scrypt hashing, no in-memory pending-signup map — the Supabase access token itself is always the credential, re-verified on every use, so there is nothing left to expire or sweep on the server side.

- [ ] **Step 1: Delete `googleIdToken.ts`**

```bash
cd /home/harris/Programming/convyio/app
git rm packages/server/src/auth/googleIdToken.ts
```

- [ ] **Step 2: Rewrite `Auth.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Actor } from "@workspace/shared";
import { ApiError } from "../board/BoardService";
import type { WorkspaceDb } from "../db";

// 1-32 chars of letters/digits/spaces/-/_; applied after trim, so a name
// can never be only whitespace.
const USERNAME_PATTERN = /^[A-Za-z0-9 _-]{1,32}$/;

export type SessionResult = { status: "ok"; username: string } | { status: "needs_username" };

/**
 * Auth owns the bridge from a verified Supabase session to a workspace
 * actor. It never issues or stores credentials itself — Supabase Auth does
 * that entirely (Google OAuth and email/password both happen client-side
 * via @supabase/supabase-js) — it only maps a verified Supabase user id
 * onto an `actors` row, creating one the first time a user picks a
 * username. Every method re-verifies the JWT itself with the Supabase
 * admin client, so a caller can never spoof a user id.
 */
export class Auth {
  constructor(
    private store: WorkspaceDb,
    private supabase: SupabaseClient,
  ) {}

  /** Verify a Supabase access token and resolve it to a bound actor, or
   *  null if the token is invalid/expired or has no actor yet. Used by the
   *  WS join gate (joinPolicy.ts). */
  async resolveSession(jwt: string): Promise<Actor | null> {
    const user = await this.verify(jwt);
    if (!user) return null;
    return this.store.getActor(user.id);
  }

  /** Same verification, framed as ok/needs_username for the HTTP front
   *  door (GET /api/auth/session) so the client knows whether to show the
   *  username step after a fresh Supabase sign-in. */
  async session(jwt: string): Promise<SessionResult> {
    const user = await this.verify(jwt);
    if (!user) throw new ApiError(401, "BAD_CREDENTIAL", "sign-in could not be verified");
    const actor = await this.store.getActor(user.id);
    return actor ? { status: "ok", username: actor.displayName } : { status: "needs_username" };
  }

  /** Bind a username to the Supabase-verified caller, creating the actor.
   *  Idempotent: a second call with an already-bound token just returns
   *  the existing username (covers two tabs finishing signup at once). */
  async claimUsername(jwt: string, username: string): Promise<{ username: string }> {
    const user = await this.verify(jwt);
    if (!user) throw new ApiError(401, "BAD_CREDENTIAL", "sign-in could not be verified");
    const already = await this.store.getActor(user.id);
    if (already) return { username: already.displayName };
    const name = username.trim();
    if (!USERNAME_PATTERN.test(name)) {
      throw new ApiError(
        400,
        "BAD_USERNAME",
        "usernames are 1-32 characters of letters, digits, spaces, - and _",
      );
    }
    // Also refuse names matching an agent, so nobody can pose as the bot.
    if ((await this.store.findActorByName("human", name)) || (await this.store.findActorByName("agent", name))) {
      throw new ApiError(409, "USERNAME_TAKEN", `the name ${name} is taken`);
    }
    const actor = await this.store.createHuman(user.id, name, user.email);
    return { username: actor.displayName };
  }

  private async verify(jwt: string): Promise<{ id: string; email: string | null } | null> {
    const { data, error } = await this.supabase.auth.getUser(jwt);
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? null };
  }
}
```

- [ ] **Step 3: Rewrite `joinPolicy.ts`**

```ts
import { createHash, timingSafeEqual } from "node:crypto";
import type { JoinEvent } from "@workspace/shared";
import type { JoinDecision } from "../hub";
import type { Auth } from "./Auth";

/**
 * The auth-mode join gate. It exists so the Hub never knows whether
 * identity comes from a Supabase-backed session or the agent's shared
 * secret, and Auth never knows websockets exist. Humans must present a
 * Supabase access token that resolves to a bound actor — the stored
 * actor's name wins over anything in the frame (I1). Agents must present
 * the configured shared secret; with none configured, no agent joins.
 * Verifying a Supabase token is a network call, so this returns a Promise
 * — every caller (Hub.handleJoin) awaits it.
 */
export function createJoinGate(
  auth: Auth,
  agentToken: string | null,
): (join: JoinEvent) => Promise<JoinDecision> {
  return async (join) => {
    if (join.kind === "agent") {
      const authorized =
        agentToken !== null && join.authToken !== undefined && secretsEqual(join.authToken, agentToken);
      return authorized && join.name !== undefined ? { ok: true, name: join.name } : { ok: false };
    }
    const actor = join.authToken ? await auth.resolveSession(join.authToken) : null;
    return actor ? { ok: true, name: actor.displayName } : { ok: false };
  };
}

/** Hash both sides so comparison time leaks neither content nor length. */
function secretsEqual(presented: string, expected: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(presented).digest(),
    createHash("sha256").update(expected).digest(),
  );
}
```

- [ ] **Step 4: Replace the entire contents of `test/auth.test.ts`**

The old file has three parts: (1) a `describe("googleIdToken verifier", ...)` block testing the deleted RS256/JWKS code, (2) `describe("Auth", ...)`/`describe("Auth: email/password", ...)` blocks driving the old `Auth` class directly, (3) a `describe("ws join gating with auth enabled", ...)` block driving login through `createWsEnv({ auth: { verifier } } )`. Part (1) is deleted outright (dead code, nothing left to test). Parts (2) and (3) both depend on the old `Auth`/`createWsEnv` APIs this task and Task 12 replace — replace the **whole file** with just the part (2) equivalent below; part (3)'s replacement needs `createWsEnv`'s new (Task 12) `WsAuthOptions` shape and is added back in Task 12 Step 3, appended to this same file. Overwrite `test/auth.test.ts` with exactly this content for now:

```ts
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Auth } from "../src/auth/Auth";
import { ApiError } from "../src/board/BoardService";
import { createTestDb } from "./pgSchema";
import type { WorkspaceDb } from "../src/db";

/** A fake Supabase admin client: getUser(jwt) resolves via a fixed lookup
 *  table the test controls, so these tests never touch the network. */
function fakeSupabase(users: Record<string, { id: string; email: string | null }>): SupabaseClient {
  return {
    auth: {
      getUser: async (jwt: string) => {
        const user = users[jwt];
        return user ? { data: { user }, error: null } : { data: { user: null }, error: new Error("invalid") };
      },
    },
  } as unknown as SupabaseClient;
}

describe("Auth", () => {
  let db: WorkspaceDb;
  let drop: () => Promise<void>;

  before(async () => {
    ({ db, drop } = await createTestDb());
  });
  after(() => drop());

  test("session() reports needs_username for a verified token with no bound actor", async () => {
    const auth = new Auth(db, fakeSupabase({ "tok-1": { id: "user-1", email: "a@example.com" } }));
    assert.deepEqual(await auth.session("tok-1"), { status: "needs_username" });
  });

  test("session() throws BAD_CREDENTIAL for an unverifiable token", async () => {
    const auth = new Auth(db, fakeSupabase({}));
    await assert.rejects(auth.session("bad-tok"), (err) => err instanceof ApiError && err.code === "BAD_CREDENTIAL");
  });

  test("claimUsername() creates the actor with the Supabase user id and rejects a repeat with a different name", async () => {
    const auth = new Auth(db, fakeSupabase({ "tok-2": { id: "user-2", email: "b@example.com" } }));
    const result = await auth.claimUsername("tok-2", "Dana");
    assert.equal(result.username, "Dana");
    const actor = await db.getActor("user-2");
    assert.equal(actor?.displayName, "Dana");
    // Idempotent: a second claim with the same token returns the bound name.
    const again = await auth.claimUsername("tok-2", "SomeoneElse");
    assert.equal(again.username, "Dana");
  });

  test("claimUsername() rejects a name already taken", async () => {
    const auth = new Auth(
      db,
      fakeSupabase({
        "tok-3": { id: "user-3", email: null },
        "tok-4": { id: "user-4", email: null },
      }),
    );
    await auth.claimUsername("tok-3", "Taken");
    await assert.rejects(auth.claimUsername("tok-4", "Taken"), (err) => err instanceof ApiError && err.code === "USERNAME_TAKEN");
  });

  test("resolveSession() returns the bound actor for a claimed token, null otherwise", async () => {
    const auth = new Auth(db, fakeSupabase({ "tok-5": { id: "user-5", email: null } }));
    assert.equal(await auth.resolveSession("tok-5"), null);
    await auth.claimUsername("tok-5", "Erin");
    const actor = await auth.resolveSession("tok-5");
    assert.equal(actor?.displayName, "Erin");
  });
});
```

- [ ] **Step 5: Run the rewritten suite**

```bash
cd /home/harris/Programming/convyio/app/packages/server
npx tsx --test test/auth.test.ts
```

Expected: passes (this file, as of this task, only contains the `describe("Auth", ...)` block above — it does not yet import `./helpers`/`createWsEnv`, so it does not depend on Task 11/12's not-yet-landed changes; Task 12 Step 3 appends the ws-join-gating block and its `./helpers` import).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/auth packages/server/test/auth.test.ts
git commit -m "Replace Google ID-token/scrypt auth with Supabase Auth verification"
```

### Task 11: Make `hub.ts` async throughout

**Files:**
- Modify: `packages/server/src/hub.ts` (every method listed below)

**Interfaces:**
- Consumes: the now-async `MessageStore`/`Channels`/`Roster`/`Attachments` (Tasks 4/5/8/9) and `createJoinGate`'s now-`Promise`-returning result (Task 10).
- Produces: `HubOptions.authorizeJoin?: (join: JoinEvent) => Promise<JoinDecision>`; `postMessage`, `clearChannel`, `handleJoin`, `handlePin`, `authoredMessage`, `handleMessageEdit`, `handleMessageDelete`, `handleMessageReact`, `handleInterrupt`, `agentOnly` all become `async`/return `Promise`. `handleStatusUpdate`, `handleTraceStart`, `handleTraceChunk`, `handleRunEnd`, `onDisconnect`, `broadcast*` stay synchronous — they only touch in-memory state (`traceBuffers`, `participant`, the WebSocket connections themselves) or the fully-synchronous `Sessions`/`Roster.get/list/setOnline/removeHuman`.

This task is one cohesive change to a single file — apply every diff below before running tests, since `dispatch()` calls almost every other method and the file will not compile with only some of them converted.

- [ ] **Step 1: `HubOptions.authorizeJoin`'s type**

Change:
```ts
  authorizeJoin?: (join: JoinEvent) => JoinDecision;
```
to:
```ts
  authorizeJoin?: (join: JoinEvent) => Promise<JoinDecision>;
```

- [ ] **Step 2: `postMessage`**

Change:
```ts
  postMessage(
    author: Participant,
    content: string,
    channel: string,
    extras: {
      id?: string;
      trace?: TraceChunk[];
      runId?: string;
      attachments?: Attachment[];
      replyToId?: string;
      /** Echoed top-level on the resulting broadcast; never part of the message. */
      nonce?: string;
    } = {},
  ): void {
    const { id = randomUUID(), nonce, ...rest } = extras;
    const message: ChatMessage = {
      id,
      authorId: author.id,
      authorName: author.name,
      authorKind: author.kind,
      content,
      timestamp: Date.now(),
      channel,
      ...rest,
    };
    this.messages.append(message);
    this.broadcast(
      nonce === undefined ? { type: "message", message } : { type: "message", message, nonce },
    );
    this.onMessagePosted?.(message);
  }
```
to:
```ts
  async postMessage(
    author: Participant,
    content: string,
    channel: string,
    extras: {
      id?: string;
      trace?: TraceChunk[];
      runId?: string;
      attachments?: Attachment[];
      replyToId?: string;
      /** Echoed top-level on the resulting broadcast; never part of the message. */
      nonce?: string;
    } = {},
  ): Promise<void> {
    const { id = randomUUID(), nonce, ...rest } = extras;
    const message: ChatMessage = {
      id,
      authorId: author.id,
      authorName: author.name,
      authorKind: author.kind,
      content,
      timestamp: Date.now(),
      channel,
      ...rest,
    };
    await this.messages.append(message);
    this.broadcast(
      nonce === undefined ? { type: "message", message } : { type: "message", message, nonce },
    );
    this.onMessagePosted?.(message);
  }
```

- [ ] **Step 3: `clearChannel`**

Change:
```ts
  clearChannel(channel?: string): void {
    this.messages.clear(channel);
    this.broadcast(channel ? { type: "clear", channel } : { type: "clear" });
  }
```
to:
```ts
  async clearChannel(channel?: string): Promise<void> {
    await this.messages.clear(channel);
    this.broadcast(channel ? { type: "clear", channel } : { type: "clear" });
  }
```

- [ ] **Step 4: `dispatch`'s join branch and every other branch that now calls an async handler**

Change:
```ts
  private async dispatch(conn: Connection, event: ClientEvent): Promise<void> {
    if (event.type === "join") {
      this.handleJoin(conn, event);
      return;
    }
    const participant = conn.participant;
    if (!participant) {
      this.send(conn, { type: "error", error: "join first" });
      return;
    }
    switch (event.type) {
      case "message": {
        const channel = event.channel ?? "general";
        if (!this.channels.exists(channel)) {
          this.send(conn, { type: "error", error: `unknown channel: ${channel}` });
          break;
        }
        // Replies point at real messages only; clients resolve them from history.
        if (event.replyToId && !this.messages.get(event.replyToId)) {
          this.send(conn, { type: "error", error: `unknown message: ${event.replyToId}` });
          break;
        }
        // The message id is allocated before posting so uploads can be bound
        // to it; a failed bind drops the whole message.
        const messageId = randomUUID();
        let attachments: Attachment[] | undefined;
        if (event.attachmentIds?.length) {
          try {
            attachments = this.attachments.bind(messageId, event.attachmentIds, participant.id);
          } catch (err) {
            if (!(err instanceof ApiError)) throw err;
            this.send(conn, { type: "error", error: err.message });
            break;
          }
        }
        this.postMessage(participant, event.content, channel, {
          id: messageId,
          attachments,
          replyToId: event.replyToId,
          nonce: event.nonce,
        });
        break;
      }
      case "demo_start":
        this.onDemoStart?.(event.channel);
        break;
      case "clear":
        this.clearChannel();
        break;
      case "pin":
        this.handlePin(conn, event);
        break;
      case "message_edit":
        this.handleMessageEdit(conn, event);
        break;
      case "message_delete":
        this.handleMessageDelete(conn, event);
        break;
      case "message_react":
        this.handleMessageReact(conn, event);
        break;
      case "typing":
        // Ephemeral relay: nothing persists, and the sender knows they type.
        this.broadcastExcept(conn, {
          type: "typing",
          actorId: participant.id,
          name: participant.name,
          channel: event.channel,
          timestamp: Date.now(),
        });
        break;
      case "interrupt":
        this.handleInterrupt(conn, event.target, event.content);
        break;
      case "status_set":
        participant.status = event.status;
        this.broadcastPresence();
        break;
      case "status_update":
        this.agentOnly(conn, () => this.handleStatusUpdate(participant, event));
        break;
      case "trace_start":
        this.agentOnly(conn, () => this.handleTraceStart(participant, event.runId));
        break;
      case "trace_chunk":
        this.agentOnly(conn, () => this.handleTraceChunk(event.runId, event.chunk));
        break;
      case "summary":
        this.agentOnly(conn, () => this.handleSummary(participant, event));
        break;
      case "run_end":
        this.agentOnly(conn, () => this.handleRunEnd(event));
        break;
      case "action_request":
        await this.handleActionRequest(conn, event);
        break;
    }
  }
```
to:
```ts
  private async dispatch(conn: Connection, event: ClientEvent): Promise<void> {
    if (event.type === "join") {
      await this.handleJoin(conn, event);
      return;
    }
    const participant = conn.participant;
    if (!participant) {
      this.send(conn, { type: "error", error: "join first" });
      return;
    }
    switch (event.type) {
      case "message": {
        const channel = event.channel ?? "general";
        if (!(await this.channels.exists(channel))) {
          this.send(conn, { type: "error", error: `unknown channel: ${channel}` });
          break;
        }
        // Replies point at real messages only; clients resolve them from history.
        if (event.replyToId && !(await this.messages.get(event.replyToId))) {
          this.send(conn, { type: "error", error: `unknown message: ${event.replyToId}` });
          break;
        }
        // The message id is allocated before posting so uploads can be bound
        // to it; a failed bind drops the whole message.
        const messageId = randomUUID();
        let attachments: Attachment[] | undefined;
        if (event.attachmentIds?.length) {
          try {
            attachments = await this.attachments.bind(messageId, event.attachmentIds, participant.id);
          } catch (err) {
            if (!(err instanceof ApiError)) throw err;
            this.send(conn, { type: "error", error: err.message });
            break;
          }
        }
        await this.postMessage(participant, event.content, channel, {
          id: messageId,
          attachments,
          replyToId: event.replyToId,
          nonce: event.nonce,
        });
        break;
      }
      case "demo_start":
        this.onDemoStart?.(event.channel);
        break;
      case "clear":
        await this.clearChannel();
        break;
      case "pin":
        await this.handlePin(conn, event);
        break;
      case "message_edit":
        await this.handleMessageEdit(conn, event);
        break;
      case "message_delete":
        await this.handleMessageDelete(conn, event);
        break;
      case "message_react":
        await this.handleMessageReact(conn, event);
        break;
      case "typing":
        // Ephemeral relay: nothing persists, and the sender knows they type.
        this.broadcastExcept(conn, {
          type: "typing",
          actorId: participant.id,
          name: participant.name,
          channel: event.channel,
          timestamp: Date.now(),
        });
        break;
      case "interrupt":
        await this.handleInterrupt(conn, event.target, event.content);
        break;
      case "status_set":
        participant.status = event.status;
        this.broadcastPresence();
        break;
      case "status_update":
        await this.agentOnly(conn, () => this.handleStatusUpdate(participant, event));
        break;
      case "trace_start":
        await this.agentOnly(conn, () => this.handleTraceStart(participant, event.runId));
        break;
      case "trace_chunk":
        await this.agentOnly(conn, () => this.handleTraceChunk(event.runId, event.chunk));
        break;
      case "summary":
        await this.agentOnly(conn, () => this.handleSummary(participant, event));
        break;
      case "run_end":
        await this.agentOnly(conn, () => this.handleRunEnd(event));
        break;
      case "action_request":
        await this.handleActionRequest(conn, event);
        break;
    }
  }
```

- [ ] **Step 5: `handleJoin`**

Change:
```ts
  private handleJoin(conn: Connection, join: JoinEvent): void {
    // In guest mode the schema guarantees a name (joins carry name or
    // authToken; a token-only join can stand only where a gate resolves it).
    const decision: JoinDecision = this.options.authorizeJoin
      ? this.options.authorizeJoin(join)
      : join.name !== undefined
        ? { ok: true, name: join.name }
        : { ok: false };
    if (!decision.ok) {
      this.send(conn, { type: "error", error: "unauthenticated" });
      conn.socket.close();
      return;
    }
    const { kind } = join;
    const participant = this.roster.join(kind, decision.name);

    // Agents are singletons: a new connection for the same agent identity
    // displaces any previous one so duplicates can never double-reply.
    if (kind === "agent") {
      for (const other of this.connections) {
        if (other !== conn && other.participant?.id === participant.id) {
          this.send(other, { type: "error", error: "displaced by newer agent connection" });
          other.socket.close();
        }
      }
    }
    conn.participant = participant;

    // Bounded per channel (not "last N overall"): clients filter history by
    // channel client-side, so a flat cap would leave quiet channels empty.
    // Older messages page in via GET /api/messages.
    this.send(conn, {
      type: "welcome",
      self: participant,
      history: this.messages.recentByChannel(this.channels.list(), DEFAULT_HISTORY_LIMIT),
      participants: this.roster.list(),
      channels: this.channels.list(),
      archivedChannels: this.channels.listArchived(),
      pinnedChannels: this.channels.pinned(),
      demoChannels: this.options.demoChannels,
      token: this.sessions.issue(participant.id),
      apiUrl: conn.apiUrl,
    });
    this.broadcastPresence();
  }
```
to:
```ts
  private async handleJoin(conn: Connection, join: JoinEvent): Promise<void> {
    // In guest mode the schema guarantees a name (joins carry name or
    // authToken; a token-only join can stand only where a gate resolves it).
    const decision: JoinDecision = this.options.authorizeJoin
      ? await this.options.authorizeJoin(join)
      : join.name !== undefined
        ? { ok: true, name: join.name }
        : { ok: false };
    if (!decision.ok) {
      this.send(conn, { type: "error", error: "unauthenticated" });
      conn.socket.close();
      return;
    }
    const { kind } = join;
    const participant = await this.roster.join(kind, decision.name);

    // Agents are singletons: a new connection for the same agent identity
    // displaces any previous one so duplicates can never double-reply.
    if (kind === "agent") {
      for (const other of this.connections) {
        if (other !== conn && other.participant?.id === participant.id) {
          this.send(other, { type: "error", error: "displaced by newer agent connection" });
          other.socket.close();
        }
      }
    }
    conn.participant = participant;

    // Bounded per channel (not "last N overall"): clients filter history by
    // channel client-side, so a flat cap would leave quiet channels empty.
    // Older messages page in via GET /api/messages.
    const channelList = await this.channels.list();
    const [history, archivedChannels, pinnedChannels] = await Promise.all([
      this.messages.recentByChannel(channelList, DEFAULT_HISTORY_LIMIT),
      this.channels.listArchived(),
      this.channels.pinned(),
    ]);
    this.send(conn, {
      type: "welcome",
      self: participant,
      history,
      participants: this.roster.list(),
      channels: channelList,
      archivedChannels,
      pinnedChannels,
      demoChannels: this.options.demoChannels,
      token: this.sessions.issue(participant.id),
      apiUrl: conn.apiUrl,
    });
    this.broadcastPresence();
  }
```

- [ ] **Step 6: `handlePin`**

Change:
```ts
  private handlePin(conn: Connection, event: PinEvent): void {
    const participant = conn.participant!;
    if (participant.kind !== "human") {
      this.send(conn, { type: "error", error: "human-only event" });
      return;
    }
    const message = this.messages.setPinned(
      event.messageId,
      event.pinned ? participant.name : null,
    );
    if (!message) {
      this.send(conn, { type: "error", error: `unknown message: ${event.messageId}` });
      return;
    }
    this.broadcast({ type: "message_updated", message });
  }
```
to:
```ts
  private async handlePin(conn: Connection, event: PinEvent): Promise<void> {
    const participant = conn.participant!;
    if (participant.kind !== "human") {
      this.send(conn, { type: "error", error: "human-only event" });
      return;
    }
    const message = await this.messages.setPinned(
      event.messageId,
      event.pinned ? participant.name : null,
    );
    if (!message) {
      this.send(conn, { type: "error", error: `unknown message: ${event.messageId}` });
      return;
    }
    this.broadcast({ type: "message_updated", message });
  }
```

- [ ] **Step 7: `authoredMessage`, `handleMessageEdit`, `handleMessageDelete`**

Change:
```ts
  /** Resolve a message the connection's participant authored, or send the
   *  refusal. Identity comes from the connection, never the frame. */
  private authoredMessage(conn: Connection, messageId: string): ChatMessage | null {
    const message = this.messages.get(messageId);
    if (!message) {
      this.send(conn, { type: "error", error: `unknown message: ${messageId}` });
      return null;
    }
    if (message.authorId !== conn.participant!.id) {
      this.send(conn, { type: "error", error: "not the message author" });
      return null;
    }
    return message;
  }

  private handleMessageEdit(conn: Connection, event: MessageEditEvent): void {
    if (!this.authoredMessage(conn, event.messageId)) return;
    const message = this.messages.edit(event.messageId, event.content)!;
    this.broadcast({ type: "message_updated", message });
  }

  private handleMessageDelete(conn: Connection, event: MessageDeleteEvent): void {
    const message = this.authoredMessage(conn, event.messageId);
    if (!message) return;
    this.messages.delete(event.messageId);
    this.broadcast({
      type: "message_deleted",
      messageId: event.messageId,
      channel: message.channel ?? "general",
    });
  }
```
to:
```ts
  /** Resolve a message the connection's participant authored, or send the
   *  refusal. Identity comes from the connection, never the frame. */
  private async authoredMessage(conn: Connection, messageId: string): Promise<ChatMessage | null> {
    const message = await this.messages.get(messageId);
    if (!message) {
      this.send(conn, { type: "error", error: `unknown message: ${messageId}` });
      return null;
    }
    if (message.authorId !== conn.participant!.id) {
      this.send(conn, { type: "error", error: "not the message author" });
      return null;
    }
    return message;
  }

  private async handleMessageEdit(conn: Connection, event: MessageEditEvent): Promise<void> {
    if (!(await this.authoredMessage(conn, event.messageId))) return;
    const message = (await this.messages.edit(event.messageId, event.content))!;
    this.broadcast({ type: "message_updated", message });
  }

  private async handleMessageDelete(conn: Connection, event: MessageDeleteEvent): Promise<void> {
    const message = await this.authoredMessage(conn, event.messageId);
    if (!message) return;
    await this.messages.delete(event.messageId);
    this.broadcast({
      type: "message_deleted",
      messageId: event.messageId,
      channel: message.channel ?? "general",
    });
  }
```

- [ ] **Step 8: `handleMessageReact`**

Change:
```ts
  /** Reactions are idempotent; only an actual change is worth a broadcast. */
  private handleMessageReact(conn: Connection, event: MessageReactEvent): void {
    const participant = conn.participant!;
    if (!this.messages.get(event.messageId)) {
      this.send(conn, { type: "error", error: `unknown message: ${event.messageId}` });
      return;
    }
    let changed: boolean;
    if (event.op === "add") {
      const outcome = this.messages.addReaction(event.messageId, event.emoji, {
        id: participant.id,
        name: participant.name,
      });
      if (outcome === "capped") {
        this.send(conn, { type: "error", error: "reaction limit reached" });
        return;
      }
      changed = outcome === "added";
    } else {
      changed = this.messages.removeReaction(event.messageId, event.emoji, participant.id);
    }
    if (!changed) return;
    this.broadcast({ type: "message_updated", message: this.messages.get(event.messageId)! });
  }
```
to:
```ts
  /** Reactions are idempotent; only an actual change is worth a broadcast. */
  private async handleMessageReact(conn: Connection, event: MessageReactEvent): Promise<void> {
    const participant = conn.participant!;
    if (!(await this.messages.get(event.messageId))) {
      this.send(conn, { type: "error", error: `unknown message: ${event.messageId}` });
      return;
    }
    let changed: boolean;
    if (event.op === "add") {
      const outcome = await this.messages.addReaction(event.messageId, event.emoji, {
        id: participant.id,
        name: participant.name,
      });
      if (outcome === "capped") {
        this.send(conn, { type: "error", error: "reaction limit reached" });
        return;
      }
      changed = outcome === "added";
    } else {
      changed = await this.messages.removeReaction(event.messageId, event.emoji, participant.id);
    }
    if (!changed) return;
    this.broadcast({ type: "message_updated", message: (await this.messages.get(event.messageId))! });
  }
```

- [ ] **Step 9: `handleInterrupt`, `agentOnly`, `handleSummary`**

Change:
```ts
  private handleInterrupt(conn: Connection, target: string, content: string): void {
    const participant = conn.participant!;
    const targetParticipant = this.roster.get("agent", target);
    if (!targetParticipant) {
      this.send(conn, { type: "error", error: `unknown agent: ${target}` });
      return;
    }

    this.postMessage(participant, `/interrupt @${target} ${content}`, "general");
    const targetConn = [...this.connections].find(
      (c) => c.participant?.id === targetParticipant.id,
    );
    if (targetConn) {
      this.send(targetConn, {
        type: "interrupt",
        authorName: participant.name,
        content,
      });
    }
  }
```
to:
```ts
  private async handleInterrupt(conn: Connection, target: string, content: string): Promise<void> {
    const participant = conn.participant!;
    const targetParticipant = this.roster.get("agent", target);
    if (!targetParticipant) {
      this.send(conn, { type: "error", error: `unknown agent: ${target}` });
      return;
    }

    await this.postMessage(participant, `/interrupt @${target} ${content}`, "general");
    const targetConn = [...this.connections].find(
      (c) => c.participant?.id === targetParticipant.id,
    );
    if (targetConn) {
      this.send(targetConn, {
        type: "interrupt",
        authorName: participant.name,
        content,
      });
    }
  }
```

Change:
```ts
  private handleSummary(participant: Participant, event: SummaryEvent): void {
    const trace = this.traceBuffers.get(event.runId) ?? [];
    this.traceBuffers.delete(event.runId);
    this.postMessage(participant, event.content, event.channel ?? "general", {
      trace: trace.length > 0 ? trace : undefined,
      runId: event.runId,
    });
  }
```
to:
```ts
  private async handleSummary(participant: Participant, event: SummaryEvent): Promise<void> {
    const trace = this.traceBuffers.get(event.runId) ?? [];
    this.traceBuffers.delete(event.runId);
    await this.postMessage(participant, event.content, event.channel ?? "general", {
      trace: trace.length > 0 ? trace : undefined,
      runId: event.runId,
    });
  }
```

Change:
```ts
  private agentOnly(conn: Connection, handle: () => void): void {
    if (conn.participant?.kind !== "agent") {
      this.send(conn, { type: "error", error: "agent-only event" });
      return;
    }
    handle();
  }
```
to:
```ts
  private async agentOnly(conn: Connection, handle: () => void | Promise<void>): Promise<void> {
    if (conn.participant?.kind !== "agent") {
      this.send(conn, { type: "error", error: "agent-only event" });
      return;
    }
    await handle();
  }
```

`handleStatusUpdate`, `handleTraceStart`, `handleTraceChunk`, `handleRunEnd`, `onDisconnect`, `broadcast`, `broadcastExcept`, `send`, and every `broadcast*` public method are unchanged — none of them touch `messages`/`channels`/`attachments`/`roster.join`.

- [ ] **Step 10: Typecheck just this file's syntax by building the server package**

```bash
cd /home/harris/Programming/convyio/app
npx tsc --noEmit -p packages/server
```

Expected: errors remain, but only from `index.ts`, `demo/DemoOrchestrator.ts`, `board/api.ts`, and `test/*` — files not yet updated (Tasks 12–14). Confirm no errors are reported inside `src/hub.ts` itself; if there are, they indicate a missed `await` in the diffs above.

- [ ] **Step 11: Commit**

```bash
git add packages/server/src/hub.ts
git commit -m "Make Hub async throughout to match the async store layer"
```

### Task 12: Rewrite `test/helpers.ts` and restore the ws-join-gating tests

**Files:**
- Modify (full rewrite): `packages/server/test/helpers.ts`
- Modify: `packages/server/test/auth.test.ts` (append the ws-join-gating block)
- Modify: `packages/server/test/channels.test.ts`, `board.test.ts`, `hardening.test.ts`, `pressure.test.ts` (fix their direct `new WorkspaceDb(":memory:")` call sites)

**Interfaces:**
- Consumes: `createTestDb` (Task 3), `Roster.create` (Task 9), `Auth`/`createJoinGate` (Task 10), async `BoardService`/`MessageStore`/`Channels`/`Attachments` (Tasks 4–8).
- Produces: `Env.actor(kind, name): Promise<{ actor: Actor; token: string }>`; `Env.close(): Promise<void>`; `WsEnv.close(): Promise<void>`; `WsAuthOptions { users: Record<string, { id: string; email: string | null }>; agentToken?: string }` (replaces the old `{ verifier, agentToken? }` shape). `Env`/`WsEnv` no longer expose `uploadsDir` (no local disk involved anymore).

- [ ] **Step 1: Rewrite `test/helpers.ts`**

```ts
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { WebSocket } from "ws";
import type { Actor, BoardEventEnvelope } from "@workspace/shared";
import type { WorkspaceDb } from "../src/db";
import { Attachments } from "../src/chat/Attachments";
import { Channels } from "../src/chat/Channels";
import { MessageStore } from "../src/chat/MessageStore";
import { Roster } from "../src/roster";
import { Auth } from "../src/auth/Auth";
import { createJoinGate } from "../src/auth/joinPolicy";
import { BoardService } from "../src/board/BoardService";
import { Sessions } from "../src/board/sessions";
import { Toolman } from "../src/board/Toolman";
import { createApiHandler } from "../src/board/api";
import { Hub } from "../src/hub";
import { createTestDb } from "./pgSchema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

/** A fake Supabase admin client: getUser(jwt) resolves via a fixed lookup
 *  table the test controls, so ws-level auth tests never touch the network. */
export function fakeSupabase(users: Record<string, { id: string; email: string | null }>): SupabaseClient {
  return {
    auth: {
      getUser: async (jwt: string) => {
        const user = users[jwt];
        return user ? { data: { user }, error: null } : { data: { user: null }, error: new Error("invalid") };
      },
    },
  } as unknown as SupabaseClient;
}

/** The real Supabase admin client (service-role key), for Attachments —
 *  Storage has no useful in-memory fake, so tests exercise the real bucket. */
function supabaseAdmin(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are not set");
  return createClient(url, key);
}

export interface Env {
  db: WorkspaceDb;
  service: BoardService;
  sessions: Sessions;
  channels: Channels;
  messages: MessageStore;
  attachments: Attachments;
  baseUrl: string;
  envelopes: BoardEventEnvelope[];
  actor(kind: "human" | "agent", name: string): Promise<{ actor: Actor; token: string }>;
  api(
    method: string,
    path: string,
    token: string,
    body?: unknown,
    raw?: string,
  ): Promise<{ status: number; body: any }>;
  close(): Promise<void>;
}

/** An isolated Postgres schema + board + HTTP API on an ephemeral port, shared by every suite. */
export async function createEnv(): Promise<Env> {
  const { db, drop } = await createTestDb();
  const service = new BoardService(db);
  const sessions = new Sessions();
  const channels = new Channels(db);
  await channels.seed([{ name: "general", isDemo: false }]);
  const envelopes: BoardEventEnvelope[] = [];
  service.onEvent = (e) => envelopes.push(e);
  const attachments = new Attachments(db, supabaseAdmin());
  const messages = new MessageStore(db);
  const handler = createApiHandler(db, service, sessions, messages, channels, attachments, "*");
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://localhost:${port}`;
  return {
    db,
    service,
    sessions,
    channels,
    messages,
    attachments,
    baseUrl,
    envelopes,
    async actor(kind, name) {
      const actor = await db.upsertActor(kind, name);
      return { actor, token: sessions.issue(actor.id) };
    },
    async api(method, urlPath, token, body, raw) {
      const res = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      });
      return { status: res.status, body: await res.json() };
    },
    async close() {
      server.close();
      await drop();
    },
  };
}

/** A valid agent proposal body; scope covers everything tests write. */
export const PROPOSAL = {
  title: "Migrate auth",
  why: "sessions are safer",
  effect: "auth uses sessions",
  scopePaths: ["out.md", "deep/"],
};

export interface WsClient {
  ws: WebSocket;
  token: string;
  welcome: any;
  /** Resolves with the first seen event matching pred, past or future. */
  next(pred: (event: any) => boolean, ms?: number): Promise<any>;
}

/** A join attempt's outcome: exactly one of welcome/refusal, never both. */
export interface JoinOutcome {
  welcome: any | null;
  error: string | null;
  closed: boolean;
}

export interface WsEnv {
  db: WorkspaceDb;
  messages: MessageStore;
  channels: Channels;
  attachments: Attachments;
  hub: Hub;
  /** Set when the env was created with auth enabled. */
  auth: Auth | null;
  baseUrl: string;
  connect(name: string, kind: "human" | "agent"): Promise<WsClient>;
  /** Send an arbitrary join frame; resolves on welcome or on socket close. */
  join(frame: Record<string, unknown>): Promise<JoinOutcome>;
  close(): Promise<void>;
}

export interface WsAuthOptions {
  /** Fake Supabase getUser(jwt) lookup table — see fakeSupabase() above. */
  users: Record<string, { id: string; email: string | null }>;
  agentToken?: string;
}

/** The full hub + HTTP stack on an ephemeral port, for websocket suites. */
export async function createWsEnv(options: { auth?: WsAuthOptions } = {}): Promise<WsEnv> {
  const { db, drop } = await createTestDb();
  const service = new BoardService(db);
  const sessions = new Sessions();
  const auth = options.auth ? new Auth(db, fakeSupabase(options.auth.users)) : null;
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-test-"));
  const toolman = new Toolman(service, workspaceDir);
  await toolman.init();
  const channels = new Channels(db);
  await channels.seed([{ name: "general", isDemo: false }]);
  const messages = new MessageStore(db);
  const attachments = new Attachments(db, supabaseAdmin());
  const handler = createApiHandler(db, service, sessions, messages, channels, attachments, "*");
  const server = http.createServer((req, res) => void handler(req, res));
  const roster = await Roster.create(db);
  const hub = new Hub(server, roster, messages, channels, attachments, sessions, toolman, {
    serverId: db.serverId,
    demoChannels: [],
    authorizeJoin: auth ? createJoinGate(auth, options.auth?.agentToken ?? null) : undefined,
  });
  channels.onCreated = (name) => hub.broadcastChannelCreated(name);
  channels.onRenamed = (oldName, newName) => hub.broadcastChannelRenamed(oldName, newName);
  channels.onArchived = (name, archived) => hub.broadcastChannelArchived(name, archived);
  channels.onPinned = (name, pinned) => hub.broadcastChannelPinned(name, pinned);
  channels.onDeleted = (name) => hub.broadcastChannelDeleted(name);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const clients: WebSocket[] = [];

  return {
    db,
    messages,
    channels,
    attachments,
    hub,
    auth,
    baseUrl: `http://localhost:${port}`,
    join(frame) {
      return new Promise<JoinOutcome>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}`);
        clients.push(ws);
        let error: string | null = null;
        let settled = false;
        ws.on("message", (raw) => {
          const ev = JSON.parse(raw.toString());
          if (ev.type === "error") error = ev.error;
          if (ev.type === "welcome" && !settled) {
            settled = true;
            resolve({ welcome: ev, error, closed: false });
          }
        });
        ws.on("close", () => {
          if (!settled) {
            settled = true;
            resolve({ welcome: null, error, closed: true });
          }
        });
        ws.on("open", () => ws.send(JSON.stringify(frame)));
      });
    },
    connect(name, kind) {
      return new Promise<WsClient>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}`);
        clients.push(ws);
        const seen: any[] = [];
        const waiters: { pred: (e: any) => boolean; resolve: (e: any) => void }[] = [];
        ws.on("message", (raw) => {
          const ev = JSON.parse(raw.toString());
          seen.push(ev);
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].pred(ev)) waiters.splice(i, 1)[0].resolve(ev);
          }
          if (ev.type === "welcome") {
            resolve({
              ws,
              token: ev.token,
              welcome: ev,
              next: (pred, ms = 1000) =>
                new Promise((res, rej) => {
                  const already = seen.find(pred);
                  if (already) return res(already);
                  const t = setTimeout(() => rej(new Error("timeout")), ms);
                  waiters.push({ pred, resolve: (e) => { clearTimeout(t); res(e); } });
                }),
            });
          }
        });
        ws.on("open", () => ws.send(JSON.stringify({ type: "join", name, kind })));
      });
    },
    async close() {
      for (const ws of clients) ws.terminate();
      server.close();
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      await drop();
    },
  };
}
```

- [ ] **Step 2: Fix the remaining direct `new WorkspaceDb(":memory:")` call sites**

```bash
cd /home/harris/Programming/convyio/app
grep -rn "new WorkspaceDb" packages/server/test
```

This reports call sites in `channels.test.ts`, `board.test.ts`, `hardening.test.ts` (three), and `pressure.test.ts` — each constructs its own throwaway `WorkspaceDb` for a one-off test rather than using `createEnv`/`createWsEnv`. For each, replace:

```ts
const db = new WorkspaceDb(":memory:");
```

(and its matching `after(() => db.close())`/inline cleanup) with:

```ts
const { db, drop } = await createTestDb();
```

(with `after(() => drop())`), importing `createTestDb` from `./pgSchema` instead of importing `WorkspaceDb` from `../src/db` (drop the now-unused `WorkspaceDb` import if nothing else in the file needs the type). Since `createTestDb` is `async`, the enclosing `describe`/`test`/setup callback must itself be `async` if it is not already — check each site individually; all of these files already use `async` callbacks elsewhere so this is typically already true.

- [ ] **Step 3: Append the ws-join-gating tests back to `test/auth.test.ts`**

Add this to the end of `test/auth.test.ts` (after the `describe("Auth", ...)` block from Task 10 Step 4), with an added import line `import { createWsEnv, fakeSupabase } from "./helpers";` at the top of the file:

```ts
// ---------------------------------------------------------------------------
// Websocket join gating (auth-enabled hub; guest mode is covered by the
// untouched existing suites)
// ---------------------------------------------------------------------------

describe("ws join gating with auth enabled", async () => {
  const env = await createWsEnv({
    auth: { users: { "tok-dana": { id: "user-dana", email: "dana@example.com" } }, agentToken: "secret123" },
  });
  after(() => env.close());

  const signIn = async (): Promise<string> => {
    const session = await env.auth!.session("tok-dana");
    if (session.status === "ok") return "tok-dana";
    await env.auth!.claimUsername("tok-dana", "dana");
    return "tok-dana";
  };

  test("humans without a token, or with a dead one, are refused and closed", async () => {
    const bare = await env.join({ type: "join", name: "mallory", kind: "human" });
    assert.equal(bare.welcome, null);
    assert.equal(bare.error, "unauthenticated");
    assert.equal(bare.closed, true);

    const dead = await env.join({ type: "join", kind: "human", authToken: "not-a-session" });
    assert.equal(dead.welcome, null);
    assert.equal(dead.error, "unauthenticated");
  });

  test("a live session joins as its own username, whatever the frame claims", async () => {
    const authToken = await signIn();
    const outcome = await env.join({
      type: "join",
      kind: "human",
      name: "impostor",
      authToken,
    });
    assert.ok(outcome.welcome, "expected a welcome");
    assert.equal(outcome.welcome.self.name, "dana");
    assert.equal(outcome.welcome.self.id, (await env.db.getActor("user-dana"))!.id);
  });

  test("agents need the exact shared secret", async () => {
    const missing = await env.join({ type: "join", name: "noodle", kind: "agent" });
    assert.equal(missing.welcome, null);
    assert.equal(missing.error, "unauthenticated");

    const wrong = await env.join({
      type: "join",
      name: "noodle",
      kind: "agent",
      authToken: "secret124",
    });
    assert.equal(wrong.welcome, null);

    const right = await env.join({
      type: "join",
      name: "noodle",
      kind: "agent",
      authToken: "secret123",
    });
    assert.ok(right.welcome, "expected a welcome");
    assert.equal(right.welcome.self.name, "noodle");
    assert.equal(right.welcome.self.kind, "agent");
  });
});
```

- [ ] **Step 4: Run the full server test suite**

```bash
cd /home/harris/Programming/convyio/app
npm test -w @workspace/server
```

Expected: every file compiles and every test that does not depend on `board/api.ts`'s new HTTP auth routes (Task 14) passes. Failures at this point should only come from `test/attachments.test.ts` and `test/channels.test.ts`/`board.test.ts`/etc. HTTP-route-level assertions that exercise `/api/auth/*` endpoints not yet rewritten, plus `index.ts`/`DemoOrchestrator.ts` (Tasks 13/15, not yet done) failing `npm run typecheck` — not this test run, since `npm test` for the server package only compiles the files each test file imports transitively, and neither `index.ts` nor `DemoOrchestrator.ts` is imported by any test file. If anything else fails, fix it before continuing — this is the checkpoint where every store-layer file (Tasks 3–10) must be fully consistent with each other.

- [ ] **Step 5: Commit**

```bash
git add packages/server/test
git commit -m "Rewrite test helpers for async Postgres and Supabase-JWT-stubbed auth"
```

### Task 13: Rewrite `board/api.ts` — async routes, new Supabase auth endpoints, Storage-backed upload serving

**Files:**
- Modify (full rewrite): `packages/server/src/board/api.ts`
- Modify: `packages/server/test/attachments.test.ts`, `channels.test.ts`, `board.test.ts`, `hardening.test.ts`, `pressure.test.ts`, `staticSite.test.ts` (only where they assert against the deleted `/api/auth/google|username|email-login|email-signup|logout` routes or `/api/auth/config`'s old `googleClientId` field — see Step 3)

**Interfaces:**
- Consumes: `Auth.session(jwt)`/`Auth.claimUsername(jwt, username)` (Task 10), `Attachments.get(id): Promise<{ attachment, blob: Blob } | null>` (Task 8), every other now-async store method.
- Produces:
  - `export interface AuthGate { googleAuthEnabled: boolean; emailAuthEnabled: boolean; auth: Auth; }` — `googleClientId: string | null` is gone; the client no longer needs a Google client id (Supabase's dashboard owns that), only a yes/no flag for whether to show the button.
  - New routes: `GET /api/auth/session` (Bearer Supabase JWT → `{status:"ok",username} | {status:"needs_username"}`), `POST /api/auth/username` (Bearer Supabase JWT + `{username}` body → `{username}`).
  - Deleted routes: `POST /api/auth/google`, the old body-based `POST /api/auth/username` (`{signupToken, username}`), `POST /api/auth/email-login`, `POST /api/auth/email-signup`, `POST /api/auth/logout` — all client-side via `@supabase/supabase-js` now (Task 16).
  - `createApiHandler(db, service, sessions, messages, channels, attachments, corsOrigin, authGate)`'s exported signature is unchanged; every call it makes into the store layer is now `await`ed.

- [ ] **Step 1: Rewrite `board/api.ts`**

```ts
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Actor, ItemStatus } from "@workspace/shared";
import { ApiError, type BoardService } from "./BoardService";
import type { Sessions } from "./sessions";
import type { Auth } from "../auth/Auth";
import { MAX_ATTACHMENT_BYTES, type Attachments } from "../chat/Attachments";
import type { Channels } from "../chat/Channels";
import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT, type MessageStore } from "../chat/MessageStore";
import type { WorkspaceDb } from "../db";

const scopePathsSchema = z.array(z.string().min(1).max(500)).max(50);

const createBodySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  why: z.string().max(1000).optional(),
  effect: z.string().max(1000).optional(),
  scopePaths: scopePathsSchema.optional(),
  // I2: any supplied status is ignored; parsed here only so it is dropped.
  status: z.unknown().optional(),
});

const channelBodySchema = z.object({ name: z.string().min(1).max(64) });
const channelPatchBodySchema = z.object({
  name: z.string().min(1).max(64).optional(),
  archived: z.boolean().optional(),
  pinned: z.boolean().optional(),
});

// Bounds only; the real username rules (and their error codes) live in Auth.
const usernameBodySchema = z.object({ username: z.string().max(200) });

const denyBodySchema = z.object({ reason: z.string().max(1000).optional() });
const blockBodySchema = z.object({ reason: z.string().min(1).max(1000) });
const patchBodySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  owner: z.string().nullable().optional(),
  scopePaths: scopePathsSchema.nullable().optional(),
});

const statusValues: ItemStatus[] = ["proposed", "denied", "approved", "in_progress", "blocked", "done"];

/** Present iff Google and/or email sign-in is configured. */
export interface AuthGate {
  googleAuthEnabled: boolean;
  emailAuthEnabled: boolean;
  auth: Auth;
}

export function createApiHandler(
  db: WorkspaceDb,
  service: BoardService,
  sessions: Sessions,
  messages: MessageStore,
  channels: Channels,
  attachments: Attachments,
  corsOrigin: string,
  authGate: AuthGate | null = null,
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return false;

    res.setHeader("Access-Control-Allow-Origin", corsOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, PATCH, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, X-File-Name, X-Image-Width, X-Image-Height",
    );
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return true;
    }

    try {
      const method = req.method ?? "GET";
      const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
      // Fetching an upload is deliberately unauthenticated: the unguessable
      // UUID in the path is the capability (the Discord-CDN model), and <img>
      // tags cannot send Authorization headers. Everything else stays gated.
      if (parts[1] === "health" && parts.length === 2 && method === "GET") {
        // Liveness for deploy platforms and container healthchecks; no auth.
        json(res, 200, { ok: true });
      } else if (parts[1] === "auth") {
        // Login endpoints are how a token is obtained, so they cannot demand one.
        await routeAuth(req, res, parts, authGate);
      } else if (parts[1] === "uploads" && parts.length === 4 && (method === "GET" || method === "HEAD")) {
        await serveUpload(res, attachments, parts[2], method === "HEAD");
      } else {
        const actor = await authenticate(req, db, sessions);
        await route(req, res, parts, url, actor, service, db, messages, channels, attachments);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        json(res, err.status, { error: err.code, message: err.message });
      } else if (err instanceof z.ZodError) {
        json(res, 400, { error: "VALIDATION", message: err.issues.map((i) => i.message).join("; ") });
      } else {
        console.error("[api] internal error:", err);
        json(res, 500, { error: "INTERNAL", message: "internal error" });
      }
    }
    return true;
  };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[], // ["api", "board", "items", ...]
  url: URL,
  actor: Actor,
  service: BoardService,
  db: WorkspaceDb,
  messages: MessageStore,
  channels: Channels,
  attachments: Attachments,
): Promise<void> {
  const method = req.method ?? "GET";

  // GET /api/actors — the member roster, for owner assignment and display.
  if (parts[1] === "actors" && parts.length === 2 && method === "GET") {
    return json(res, 200, { actors: await db.listActors() });
  }

  // POST /api/channels — any signed-in human can add a channel.
  if (parts[1] === "channels" && parts.length === 2 && method === "POST") {
    const body = channelBodySchema.parse(await readBody(req));
    return json(res, 201, { channel: { name: await channels.create(actor, body.name) } });
  }

  // PATCH /api/channels/:name — rename and/or archive/pin, one field per call.
  if (parts[1] === "channels" && parts.length === 3 && method === "PATCH") {
    const name = decodeURIComponent(parts[2]);
    const body = channelPatchBodySchema.parse(await readBody(req));
    let current = name;
    if (body.name !== undefined) current = await channels.rename(actor, current, body.name);
    if (body.archived !== undefined) await channels.setArchived(actor, current, body.archived);
    if (body.pinned !== undefined) await channels.setPinned(actor, current, body.pinned);
    return json(res, 200, { channel: { name: current } });
  }

  // DELETE /api/channels/:name — also drops its message history.
  if (parts[1] === "channels" && parts.length === 3 && method === "DELETE") {
    const name = decodeURIComponent(parts[2]);
    await messages.clear(name);
    await channels.remove(actor, name);
    return json(res, 200, { ok: true });
  }

  // GET /api/messages?channel=&before=&limit= — an older page of chat
  // history than what the welcome frame's per-channel cap carried.
  if (parts[1] === "messages" && parts.length === 2 && method === "GET") {
    const channel = url.searchParams.get("channel");
    if (!channel) throw new ApiError(400, "BAD_CHANNEL", "channel is required");
    // Number(null) is 0, not NaN, so a missing `before` must be checked
    // before the numeric coercion or it would silently pass as "before 0".
    const beforeRaw = url.searchParams.get("before");
    const before = beforeRaw === null ? NaN : Number(beforeRaw);
    if (!Number.isFinite(before)) {
      throw new ApiError(400, "BAD_BEFORE", "before must be a numeric timestamp");
    }
    return json(res, 200, { messages: await messages.olderPage(channel, before, historyLimit(url)) });
  }

  // POST /api/uploads — raw binary body; metadata rides in headers because
  // multipart would mean a whole parser for no extra capability.
  if (parts[1] === "uploads" && parts.length === 2 && method === "POST") {
    const bytes = await readRawBody(req, MAX_ATTACHMENT_BYTES);
    return json(res, 201, { attachment: await attachments.save(actor, uploadMeta(req), bytes) });
  }

  if (parts[1] !== "board" || parts[2] !== "items") {
    throw new ApiError(404, "NOT_FOUND", "no such route");
  }

  // GET /api/board/items
  if (parts.length === 3 && method === "GET") {
    const status = url.searchParams.get("status");
    if (status && !statusValues.includes(status as ItemStatus)) {
      throw new ApiError(400, "BAD_STATUS", `status must be one of ${statusValues.join(", ")}`);
    }
    const items = await service.list(actor.serverId, {
      status: (status as ItemStatus) ?? undefined,
      includeDeleted: url.searchParams.get("include_deleted") === "true",
    });
    return json(res, 200, { items });
  }

  // POST /api/board/items
  if (parts.length === 3 && method === "POST") {
    const body = createBodySchema.parse(await readBody(req));
    const item = await service.create(actor, body);
    return json(res, 201, { item });
  }

  const id = parts[3];
  if (!id) throw new ApiError(404, "NOT_FOUND", "no such route");

  // PATCH / DELETE /api/board/items/:id
  if (parts.length === 4) {
    if (method === "PATCH") {
      const body = patchBodySchema.parse(await readBody(req));
      return json(res, 200, { item: await service.edit(actor, id, body) });
    }
    if (method === "DELETE") {
      return json(res, 200, { item: await service.softDelete(actor, id) });
    }
    throw new ApiError(405, "METHOD_NOT_ALLOWED", `${method} not allowed`);
  }

  // GET /api/board/items/:id/events — the item's audit trail.
  if (parts.length === 5 && parts[4] === "events" && method === "GET") {
    return json(res, 200, { events: await service.events(actor.serverId, id) });
  }

  // POST /api/board/items/:id/<action>
  if (parts.length === 5 && method === "POST") {
    switch (parts[4]) {
      case "approve":
        return json(res, 200, { item: await service.approve(actor, id) });
      case "deny": {
        const body = denyBodySchema.parse(await readBody(req));
        return json(res, 200, { item: await service.deny(actor, id, body.reason) });
      }
      case "start":
        return json(res, 200, { item: await service.start(actor, id) });
      case "complete":
        return json(res, 200, { item: await service.complete(actor, id) });
      case "block": {
        const body = blockBodySchema.parse(await readBody(req));
        return json(res, 200, { item: await service.block(actor, id, body.reason) });
      }
      case "unblock":
        return json(res, 200, { item: await service.unblock(actor, id) });
      case "reopen":
        return json(res, 200, { item: await service.reopen(actor, id) });
    }
  }

  throw new ApiError(404, "NOT_FOUND", "no such route");
}

/**
 * /api/auth/*: the pre-token surface. `config` tells clients which modes the
 * server runs in. `session`/`username` both take the Supabase access token
 * as a Bearer header — there is no other credential left on the server side,
 * Supabase Auth issued it already — and re-verify it against Supabase on
 * every call, same as the WS join gate (joinPolicy.ts) does.
 */
async function routeAuth(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[], // ["api", "auth", ...]
  authGate: AuthGate | null,
): Promise<void> {
  const method = req.method ?? "GET";
  if (parts.length !== 3) throw new ApiError(404, "NOT_FOUND", "no such route");

  if (parts[2] === "config" && method === "GET") {
    return json(res, 200, {
      googleAuthEnabled: authGate?.googleAuthEnabled ?? false,
      emailAuthEnabled: authGate?.emailAuthEnabled ?? false,
    });
  }
  if (!authGate) {
    throw new ApiError(409, "AUTH_DISABLED", "this server runs in guest mode");
  }

  if (parts[2] === "session" && method === "GET") {
    const jwt = bearerToken(req);
    if (!jwt) throw new ApiError(401, "UNAUTHENTICATED", "missing bearer token");
    return json(res, 200, await authGate.auth.session(jwt));
  }
  if (parts[2] === "username" && method === "POST") {
    const jwt = bearerToken(req);
    if (!jwt) throw new ApiError(401, "UNAUTHENTICATED", "missing bearer token");
    const body = usernameBodySchema.parse(await readBody(req));
    return json(res, 200, await authGate.auth.claimUsername(jwt, body.username));
  }
  throw new ApiError(404, "NOT_FOUND", "no such route");
}

async function authenticate(req: IncomingMessage, db: WorkspaceDb, sessions: Sessions): Promise<Actor> {
  const token = bearerToken(req);
  const actorId = token ? sessions.resolve(token) : null;
  const actor = actorId ? await db.getActor(actorId) : null;
  if (!actor) throw new ApiError(401, "UNAUTHENTICATED", "missing or invalid token");
  return actor;
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

/** GET/HEAD /api/uploads/:id/:name — the :name segment is URL aesthetics only. */
async function serveUpload(
  res: ServerResponse,
  attachments: Attachments,
  id: string,
  headOnly: boolean,
): Promise<void> {
  const found = await attachments.get(id);
  if (!found) throw new ApiError(404, "NOT_FOUND", "no such upload");
  const { attachment, blob } = found;
  res.writeHead(200, {
    "Content-Type": attachment.mime,
    "Content-Length": attachment.size,
    "Content-Disposition": `inline; filename="${attachment.name}"`,
    // The bytes at an id never change, so clients may cache forever.
    "Cache-Control": "private, max-age=31536000, immutable",
  });
  if (headOnly) return void res.end();
  // blob.stream() is a web ReadableStream; Readable.fromWeb bridges it to
  // the Node stream `res` needs to be piped into.
  const stream = Readable.fromWeb(blob.stream() as Parameters<typeof Readable.fromWeb>[0]);
  // Headers are already sent; a missing/unreadable object can only abort.
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

/** Upload metadata rides in headers; the body is the file bytes verbatim. */
function uploadMeta(req: IncomingMessage): { name: string; mime: string; width?: number; height?: number } {
  const contentType = req.headers["content-type"]?.split(";")[0].trim();
  const encodedName = req.headers["x-file-name"];
  let name = "file";
  if (typeof encodedName === "string" && encodedName) {
    try {
      name = decodeURIComponent(encodedName);
    } catch {
      throw new ApiError(400, "BAD_FILE_NAME", "x-file-name must be URI-encoded");
    }
  }
  return {
    name,
    mime: contentType || "application/octet-stream",
    width: intHeader(req, "x-image-width"),
    height: intHeader(req, "x-image-height"),
  };
}

/** Clamp ?limit= to [1, MAX_HISTORY_LIMIT]; missing or non-numeric falls
 *  back to the default rather than rejecting outright. */
function historyLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  const n = raw === null ? DEFAULT_HISTORY_LIMIT : Number(raw);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_HISTORY_LIMIT;
  return Math.min(n, MAX_HISTORY_LIMIT);
}

function intHeader(req: IncomingMessage, header: string): number | undefined {
  const raw = req.headers[header];
  if (typeof raw !== "string") return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Stream-read a request body, rejecting as soon as the cap is crossed. */
async function readRawBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > cap) throw new ApiError(413, "TOO_LARGE", "body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const raw = (await readRawBody(req, 256 * 1024)).toString("utf-8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, "BAD_JSON", "malformed JSON body");
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
```

- [ ] **Step 2: Typecheck the server package**

```bash
cd /home/harris/Programming/convyio/app
npx tsc --noEmit -p packages/server
```

Expected: remaining errors are confined to `src/index.ts` and `src/demo/DemoOrchestrator.ts` (Tasks 14/15) — if `board/api.ts` itself reports an error, fix it before continuing.

- [ ] **Step 3: Fix test assertions against the deleted/renamed auth routes**

```bash
cd /home/harris/Programming/convyio/app
grep -rln "googleClientId\|/api/auth/google\|/api/auth/email-login\|/api/auth/email-signup\|/api/auth/logout" packages/server/test
```

For each reported file, update or delete the affected assertion:
- Any `{ googleClientId: ... }` read from `GET /api/auth/config`'s response becomes `{ googleAuthEnabled: ... }`.
- Any direct call to the deleted POST routes (`/api/auth/google`, `/api/auth/email-login`, `/api/auth/email-signup`, `/api/auth/logout`) is dead — those tests' coverage is superseded by `test/auth.test.ts`'s `describe("Auth", ...)` (Task 10) and `describe("ws join gating with auth enabled", ...)` (Task 12), so delete the dead test rather than trying to adapt it in place.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/board/api.ts packages/server/test
git commit -m "Rewrite the HTTP API for async stores and Supabase JWT-based auth routes"
```

### Task 14: Rewrite `config.ts` and `index.ts`

**Files:**
- Modify (full rewrite): `packages/server/src/config.ts`
- Modify (full rewrite): `packages/server/src/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–13 (`WorkspaceDb.create`, `Roster.create`, `Auth`, async `Channels`/`MessageStore`/`Attachments`/`BoardService`, `AuthGate` with `googleAuthEnabled`).
- Produces: `config.supabaseUrl`/`config.supabaseServiceRoleKey`/`config.supabaseDbUrl`/`config.googleAuthEnabled` (new); `config.googleClientId` is gone.

- [ ] **Step 1: Rewrite `config.ts`**

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// dotenv.config() with no path defaults to CWD, but npm workspaces run this
// with cwd = packages/server, not the repo root where .env lives. Point at
// it explicitly so `npm run dev` picks up the root .env (Docker Compose
// doesn't need this — it injects .env as real container env vars already).
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required — set it in the root .env`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  /** Sandbox root for the agent's native file/bash tools (Toolman) only —
   *  unrelated to persistence, which now lives entirely in Supabase. */
  dataDir: process.env.DATA_DIR ?? path.resolve(__dirname, "../../../data"),
  /** Single allowed browser origin for the HTTP API (the Vite dev client). */
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  supabaseDbUrl: required("SUPABASE_DB_URL"),
  /** Google sign-in itself is configured in the Supabase dashboard, not
   *  here; this only gates whether the client shows the Google button. */
  googleAuthEnabled: process.env.GOOGLE_AUTH_ENABLED === "1",
  /** Email/password sign-in. Neither this nor googleAuthEnabled set = guest mode. */
  emailAuthEnabled: process.env.EMAIL_AUTH === "1",
  /** Shared secret the agent joins with when auth is enabled. */
  agentToken: process.env.AGENT_TOKEN ?? null,
  /** Built client to serve as the single origin; absent = API only (dev). */
  clientDist: process.env.CLIENT_DIST ?? path.resolve(__dirname, "../../client/dist"),
};
```

- [ ] **Step 2: Rewrite `index.ts`**

```ts
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { config } from "./config";
import { createStaticSite } from "./staticSite";
import { Hub } from "./hub";
import { Roster } from "./roster";
import { WorkspaceDb } from "./db";
import { Attachments } from "./chat/Attachments";
import { Channels } from "./chat/Channels";
import { MessageStore } from "./chat/MessageStore";
import { Auth } from "./auth/Auth";
import { createJoinGate } from "./auth/joinPolicy";
import { BoardService } from "./board/BoardService";
import { Toolman } from "./board/Toolman";
import { Sessions } from "./board/sessions";
import { createApiHandler, type AuthGate } from "./board/api";
import { loadDemoScripts } from "./demo/script";
import { DemoOrchestrator } from "./demo/DemoOrchestrator";

const ASSETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets");

async function main() {
  const db = await WorkspaceDb.create(config.supabaseDbUrl);
  const messages = new MessageStore(db);
  const service = new BoardService(db);
  const sessions = new Sessions();
  const workspaceDir = path.join(config.dataDir, "workspace");
  const toolman = new Toolman(service, workspaceDir);
  await toolman.init();

  const scripts = await loadDemoScripts(path.join(ASSETS_DIR, "demo/scripts"));
  const demoChannels = [...scripts.keys()].sort();
  const channels = new Channels(db);
  await channels.seed([
    { name: "general", isDemo: false },
    ...demoChannels.map((name) => ({ name, isDemo: true })),
  ]);

  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);

  let authGate: AuthGate | null = null;
  if (config.googleAuthEnabled || config.emailAuthEnabled) {
    authGate = {
      googleAuthEnabled: config.googleAuthEnabled,
      emailAuthEnabled: config.emailAuthEnabled,
      auth: new Auth(db, supabase),
    };
    if (config.googleAuthEnabled) console.log("[auth] Google sign-in enabled");
    if (config.emailAuthEnabled) console.log("[auth] Email sign-in enabled");
    if (!config.agentToken) {
      console.warn("[auth] AGENT_TOKEN is not set: no agent can join this server");
    }
  } else {
    console.warn("[auth] no sign-in method configured: all joins will be refused");
  }

  const attachments = new Attachments(db, supabase);
  const handleApi = createApiHandler(
    db,
    service,
    sessions,
    messages,
    channels,
    attachments,
    config.corsOrigin,
    authGate,
  );
  const staticSite = fs.existsSync(path.join(config.clientDist, "index.html"))
    ? createStaticSite(config.clientDist)
    : null;
  console.log(
    staticSite
      ? `[static] serving client from ${config.clientDist}`
      : `[static] no client build at ${config.clientDist}; API only`,
  );
  const server = http.createServer(async (req, res) => {
    if (await handleApi(req, res)) return;
    if (staticSite && (await staticSite(req, res))) return;
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "NOT_FOUND" }));
  });

  const roster = await Roster.create(db);
  const hub = new Hub(server, roster, messages, channels, attachments, sessions, toolman, {
    serverId: db.serverId,
    demoChannels,
    // Unconfigured is not guest mode here: refuse every join rather than
    // trust self-declared names (the Hub's own undefined-gate fallback is
    // for tests that build it directly, never for the running server).
    authorizeJoin: authGate
      ? createJoinGate(authGate.auth, config.agentToken)
      : async () => ({ ok: false }),
  });
  service.onEvent = (envelope) => hub.broadcastBoardEvent(envelope);
  channels.onCreated = (name) => hub.broadcastChannelCreated(name);
  channels.onRenamed = (oldName, newName) => hub.broadcastChannelRenamed(oldName, newName);
  channels.onArchived = (name, archived) => hub.broadcastChannelArchived(name, archived);
  channels.onPinned = (name, pinned) => hub.broadcastChannelPinned(name, pinned);
  channels.onDeleted = (name) => hub.broadcastChannelDeleted(name);
  new DemoOrchestrator(
    hub,
    roster,
    db,
    service,
    workspaceDir,
    path.join(ASSETS_DIR, "demo/seed"),
    scripts,
  );

  server.listen(config.port, () => {
    console.log(
      `[hub] listening on ws://localhost:${config.port} (http api on http://localhost:${config.port})`,
    );
  });
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
```

Two behavior notes for the engineer:
- `messages.importLegacyJson(config.dataDir)` (the one-time pre-SQLite JSON import) is dropped, not ported — Task 4 already deleted the method itself since there is no legacy data path for a Supabase-backed deployment.
- The `authorizeJoin` fallback for an unconfigured server changes from a synchronous `() => ({ ok: false })` to `async () => ({ ok: false })`, matching `HubOptions.authorizeJoin`'s new `Promise`-returning type from Task 11.

- [ ] **Step 3: Typecheck the whole server package**

```bash
cd /home/harris/Programming/convyio/app
npx tsc --noEmit -p packages/server
```

Expected: the only remaining errors are inside `src/demo/DemoOrchestrator.ts` — it is the last source file still calling the store layer synchronously, fixed next in Task 15. If any error is reported outside that one file, stop and fix it before continuing; every other source file should be fully consistent at this point.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/config.ts packages/server/src/index.ts
git commit -m "Wire index.ts to Supabase Postgres/Auth/Storage"
```

### Task 15: Make `demo/DemoOrchestrator.ts` async

**Files:**
- Modify: `packages/server/src/demo/DemoOrchestrator.ts` (`start`, `post`, `approveProposal`, `cleanupDemoItems`)

**Interfaces:**
- Consumes: `Hub.clearChannel`/`Hub.postMessage` (Task 11), `Roster.join` (Task 9), `WorkspaceDb.upsertActor` (Task 3), `BoardService.find`/`approve`/`softDelete` (Task 6) — all now `Promise`-returning.
- Produces: `post`/`cleanupDemoItems` become `private async ... : Promise<void>`; `start`/`approveProposal` (already `async`) gain the missing `await`s. `removePersonas` is unaffected — `Roster.get`/`Roster.removeHuman` stayed synchronous in Task 9.

- [ ] **Step 1: `post`**

Change:
```ts
  /** Post a message as a scripted persona through the normal pipeline. */
  private post(persona: string, content: string, channel: string): void {
    const participant = this.roster.join("human", persona);
    this.hub.broadcastPresence();
    this.hub.postMessage(participant, content, channel);
  }
```
to:
```ts
  /** Post a message as a scripted persona through the normal pipeline. */
  private async post(persona: string, content: string, channel: string): Promise<void> {
    const participant = await this.roster.join("human", persona);
    this.hub.broadcastPresence();
    await this.hub.postMessage(participant, content, channel);
  }
```

- [ ] **Step 2: `cleanupDemoItems`**

Change:
```ts
  private cleanupDemoItems(asPersona: string): void {
    if (this.demoRefs.size === 0) return;
    const actor = this.db.upsertActor("human", asPersona);
    for (const ref of this.demoRefs) {
      try {
        const item = this.service.find(this.db.serverId, ref);
        if (item && item.deletedAt == null) this.service.softDelete(actor, ref);
      } catch (err) {
        console.warn(`[demo] cleanup of ${ref} failed:`, err instanceof Error ? err.message : err);
      }
    }
    this.demoRefs.clear();
  }
```
to:
```ts
  private async cleanupDemoItems(asPersona: string): Promise<void> {
    if (this.demoRefs.size === 0) return;
    const actor = await this.db.upsertActor("human", asPersona);
    for (const ref of this.demoRefs) {
      try {
        const item = await this.service.find(this.db.serverId, ref);
        if (item && item.deletedAt == null) await this.service.softDelete(actor, ref);
      } catch (err) {
        console.warn(`[demo] cleanup of ${ref} failed:`, err instanceof Error ? err.message : err);
      }
    }
    this.demoRefs.clear();
  }
```

- [ ] **Step 3: `approveProposal`**

Change:
```ts
  private async approveProposal(author: string, channel: string): Promise<void> {
    const ref =
      this.lastProposalRef ?? (await this.waitForProposal(AGENT_TIMEOUT_MS));
    const actor = this.db.upsertActor("human", author);
    const item = this.service.find(this.db.serverId, ref);
    if (!item || item.status !== "proposed") {
      throw new Error(`demo proposal ${ref} is not approvable`);
    }
    this.service.approve(actor, ref);
    console.log(`[demo] ${author} approved ${ref}`);
    await this.waitForAgentReply(channel, WORK_TIMEOUT_MS);
  }
```
to:
```ts
  private async approveProposal(author: string, channel: string): Promise<void> {
    const ref =
      this.lastProposalRef ?? (await this.waitForProposal(AGENT_TIMEOUT_MS));
    const actor = await this.db.upsertActor("human", author);
    const item = await this.service.find(this.db.serverId, ref);
    if (!item || item.status !== "proposed") {
      throw new Error(`demo proposal ${ref} is not approvable`);
    }
    await this.service.approve(actor, ref);
    console.log(`[demo] ${author} approved ${ref}`);
    await this.waitForAgentReply(channel, WORK_TIMEOUT_MS);
  }
```

- [ ] **Step 4: `start`'s call sites**

Change:
```ts
    try {
      this.hub.clearChannel(channel);
      this.cleanupDemoItems(script.personas[0]);
      if (script.seedDir) await this.seedWorkspace(script.seedDir);

      const agentName = this.roster.onlineAgentName();
      if (!agentName) {
        this.post(script.personas[0], "(demo aborted: no agent is online — start the agent process first)", channel);
        return;
      }

      for (const step of script.steps) {
        await delay(STEP_DELAY_MS);
        if (gen !== this.generation) return;
        this.post(step.author, step.say.replaceAll("{agent}", agentName), channel);
        if (step.await === "agent_reply") {
          await this.waitForAgentReply(channel, AGENT_TIMEOUT_MS);
          if (gen !== this.generation) return;
        }
        if (step.await === "approve_proposal") {
          await this.approveProposal(step.author, channel);
          if (gen !== this.generation) return;
        }
      }
    } catch (err) {
```
to:
```ts
    try {
      await this.hub.clearChannel(channel);
      await this.cleanupDemoItems(script.personas[0]);
      if (script.seedDir) await this.seedWorkspace(script.seedDir);

      const agentName = this.roster.onlineAgentName();
      if (!agentName) {
        await this.post(script.personas[0], "(demo aborted: no agent is online — start the agent process first)", channel);
        return;
      }

      for (const step of script.steps) {
        await delay(STEP_DELAY_MS);
        if (gen !== this.generation) return;
        await this.post(step.author, step.say.replaceAll("{agent}", agentName), channel);
        if (step.await === "agent_reply") {
          await this.waitForAgentReply(channel, AGENT_TIMEOUT_MS);
          if (gen !== this.generation) return;
        }
        if (step.await === "approve_proposal") {
          await this.approveProposal(step.author, channel);
          if (gen !== this.generation) return;
        }
      }
    } catch (err) {
```

- [ ] **Step 5: Full typecheck and full test run**

```bash
cd /home/harris/Programming/convyio/app
npm run typecheck
npm test -w @workspace/server
```

Expected: `typecheck` passes for `@workspace/server` (the other three packages — `shared`, `client`, `agent` — are untouched so far and should already have passed before this migration started; if `packages/client` now fails, that is expected and addressed in Tasks 16–18, not here — `npm run typecheck` runs all four packages, so read its output per-package). `npm test -w @workspace/server` passes in full.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/demo/DemoOrchestrator.ts
git commit -m "Make DemoOrchestrator async to match the async store layer"
```

This closes out the server-side migration: every store method is async end-to-end, from `db.ts` through `hub.ts`/`board/api.ts`/`demo/DemoOrchestrator.ts`, with no remaining `node:sqlite`, scrypt, Google ID-token, or local-disk-upload code anywhere in `packages/server`.

### Task 16: Add the Supabase browser client and rewrite `LoginScreen.tsx`

**Files:**
- Create: `packages/client/src/lib/supabase.ts`
- Modify (full rewrite): `packages/client/src/components/LoginScreen.tsx`

**Interfaces:**
- Consumes: `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` (already in root `.env`, exposed to the Vite bundle by the existing `VITE_` prefix convention).
- Produces: `export const supabase: SupabaseClient` (the one browser Supabase client instance, imported everywhere client code needs auth). `LoginScreen`'s props change from `{ googleClientId: string | null; emailAuthEnabled: boolean; onSignedIn: (authToken, rememberMe) => void }` to `{ googleAuthEnabled: boolean; emailAuthEnabled: boolean }` — it no longer hands back a token; it only *starts* a Supabase sign-in (redirect for Google, direct call for email/password), and `App.tsx` (Task 17) reacts to the resulting Supabase session via `supabase.auth.onAuthStateChange`, the same way for both providers.

Deliberate scope trim, called out explicitly rather than silently dropped: the old "Remember for 30 days" checkbox is removed. It toggled between `localStorage`/`sessionStorage` for the app's own 30-day session token; Supabase's client always persists its session in `localStorage` with its own automatic refresh, and per-sign-in storage-lifetime toggling isn't something `@supabase/supabase-js` exposes — reintroducing it would mean hand-rolling session storage again, which is exactly what this migration removes. If session-per-tab behavior is wanted later, it is a `createClient(..., { auth: { persistSession: false } })` follow-up, not something this plan re-implements.

- [ ] **Step 1: Add `packages/client/src/lib/supabase.ts`**

```ts
import { createClient } from "@supabase/supabase-js";

/**
 * The one browser Supabase client. Auth (Google OAuth + email/password)
 * flows through this; the server never sees Supabase credentials, only the
 * resulting access token as a Bearer header / WS join `authToken`.
 */
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);
```

- [ ] **Step 2: Rewrite `LoginScreen.tsx`**

```tsx
import { useState } from "react";
import { supabase } from "../lib/supabase";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-chat">
      <div className="w-96 animate-fade-in rounded-lg bg-sidebar p-8 shadow-2xl">
        {children}
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  ...inputProps
}: { id: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="mb-4">
      <label
        htmlFor={id}
        className="mb-2 block text-xs font-bold tracking-wide text-muted uppercase"
      >
        {label}
      </label>
      <input
        id={id}
        className="w-full rounded border border-divider bg-input px-3 py-2.5 text-body outline-none focus:ring-2 focus:ring-blurple"
        {...inputProps}
      />
    </div>
  );
}

function Divider() {
  return (
    <div className="my-6 flex items-center gap-3">
      <div className="h-px flex-1 bg-divider" />
      <span className="text-xs font-medium text-faint uppercase">Or</span>
      <div className="h-px flex-1 bg-divider" />
    </div>
  );
}

/**
 * The auth-mode front door: starts a Supabase sign-in (email/password
 * directly, Google via redirect) and nothing else — it never sees or hands
 * back a token. App.tsx reacts to the resulting Supabase session via
 * supabase.auth.onAuthStateChange for both providers alike, including the
 * post-auth "pick a username" step (App.tsx's UsernameStep).
 */
export function LoginScreen({
  googleAuthEnabled,
  emailAuthEnabled,
}: {
  googleAuthEnabled: boolean;
  emailAuthEnabled: boolean;
}) {
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [googleBusy, setGoogleBusy] = useState(false);

  const signInWithGoogle = async () => {
    setGoogleBusy(true);
    setGoogleError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) {
      setGoogleError(error.message);
      setGoogleBusy(false);
    }
    // On success the browser navigates to Google and this component unmounts.
  };

  return (
    <Card>
      {emailAuthEnabled ? (
        <EmailAuthForm />
      ) : (
        <>
          <h1 className="mb-1 text-2xl font-semibold text-body">Sign in</h1>
          <p className="mb-6 text-muted">
            One room, humans and agents side by side. Sign in with Google to join.
          </p>
        </>
      )}
      {googleAuthEnabled && (
        <>
          {emailAuthEnabled && <Divider />}
          <button
            onClick={() => void signInWithGoogle()}
            disabled={googleBusy}
            className="w-full rounded border border-divider bg-input py-2.5 font-medium text-body transition hover:bg-popup disabled:cursor-not-allowed disabled:opacity-50"
          >
            Sign in with Google
          </button>
        </>
      )}
      {googleError && (
        <p role="alert" className="mt-4 text-sm text-dead">
          {googleError}
        </p>
      )}
    </Card>
  );
}

/** The email/password form: toggles between signing in and creating an
 *  account. Username is not collected here — both providers pick a
 *  username through the same post-auth step (App.tsx's UsernameStep). */
function EmailAuthForm() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [forgotMsg, setForgotMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const emailValid = EMAIL_PATTERN.test(email.trim());
  const passwordValid = password.length >= MIN_PASSWORD_LENGTH;
  const canSubmit = emailValid && passwordValid && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const { error } =
      mode === "login"
        ? await supabase.auth.signInWithPassword({ email: email.trim(), password })
        : await supabase.auth.signUp({ email: email.trim(), password });
    if (error) setError(error.message);
    setSubmitting(false);
    // On success App.tsx's onAuthStateChange picks up the new session.
  };

  return (
    <>
      <p className="mb-1 text-sm text-muted">Please enter your details</p>
      <h1 className="mb-6 text-2xl font-semibold text-body">
        {mode === "login" ? "Welcome back" : "Create your account"}
      </h1>

      <Field
        id="email"
        label="Email address"
        type="email"
        autoFocus
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
        placeholder="you@example.com"
      />
      <Field
        id="password"
        label="Password"
        type="password"
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
        placeholder="••••••••"
      />

      {mode === "login" && (
        <div className="mb-4 flex items-center justify-end text-sm">
          <button
            type="button"
            onClick={() => setForgotMsg("Password reset isn't set up yet — ask an admin for help.")}
            className="font-medium text-blurple hover:underline"
          >
            Forgot password
          </button>
        </div>
      )}
      {forgotMsg && <p className="mb-4 text-sm text-faint">{forgotMsg}</p>}

      <button
        onClick={() => void submit()}
        disabled={!canSubmit}
        className="w-full rounded bg-blurple py-2.5 font-medium text-mention-text transition hover:bg-working disabled:cursor-not-allowed disabled:opacity-50"
      >
        {mode === "login" ? "Sign in" : "Create account"}
      </button>

      {error && (
        <p role="alert" className="mt-4 text-sm text-dead">
          {error}
        </p>
      )}

      <p className="mt-6 text-center text-sm text-muted">
        {mode === "login" ? "Don't have an account?" : "Already have an account?"}{" "}
        <button
          type="button"
          onClick={() => {
            setMode(mode === "login" ? "signup" : "login");
            setError(null);
          }}
          className="font-medium text-blurple hover:underline"
        >
          {mode === "login" ? "Sign up" : "Sign in"}
        </button>
      </p>
    </>
  );
}
```

- [ ] **Step 3: Commit**

```bash
cd /home/harris/Programming/convyio/app
git add packages/client/src/lib/supabase.ts packages/client/src/components/LoginScreen.tsx
git commit -m "Replace Google Identity Services + custom email form with Supabase Auth"
```

Note: this leaves `App.tsx` passing the old `googleClientId`/`onSignedIn` props, which no longer exist on `LoginScreen` — expected, fixed in Task 17 immediately next; do not run the client build/tests until that lands.

### Task 17: Rewrite `App.tsx` to drive the workspace off the Supabase session

**Files:**
- Modify (full rewrite): `packages/client/src/App.tsx`

**Interfaces:**
- Consumes: `supabase` (Task 16), `LoginScreen`'s new props (Task 16), `WorkspaceProvider`'s existing `credentials: JoinCredentials` / `onAuthRejected` / `onSignOut` props (`packages/client/src/hooks/WorkspaceContext.tsx` — **unchanged, no edits needed there**: `onSignOut`'s declared type `(() => void) | null` already accepts a callback that fires-and-forgets a Promise, which is exactly what `() => void supabase.auth.signOut()` is).
- Produces: no more app-managed `localStorage`/`sessionStorage` "authToken" — the Supabase client owns session persistence and refresh; `credentials.authToken` is always the live `session.access_token`, so `useConnection`'s existing effect (keyed on `credentials.authToken`, `packages/client/src/hooks/useConnection.ts` — **unchanged**) naturally reconnects the websocket on an hourly token refresh. That reconnect is a deliberate, accepted trade-off, not an oversight: it replaces the alternative of holding a token that silently goes stale and can no longer rejoin after a network drop or laptop sleep — `WorkspaceSocket`'s existing auto-reconnect-with-backoff (`ws.ts`) already makes a reconnect cheap and unsurprising (a brief "Reconnecting…" banner), so no changes are needed there either. This directly resolves the design spec's "WebSocket auth" open question.

A race the tri-state `usernameStatus` below exists specifically to prevent: if `needsUsername` were a plain boolean initialized to `false`, the render right after `session` first becomes non-null would briefly fall through to `WorkspaceProvider` (mounting a WS join) before the async "does this Supabase user have a bound actor yet?" check resolves — for a brand-new sign-in, that join would be refused by the server (no actor bound to the id yet) and `onAuthRejected` would sign the user back out, when it should have shown the username step instead. `usernameStatus` starts at `"unknown"` on every session change and `WorkspaceProvider` only ever renders once it resolves to `"ok"`, so that premature join can never happen.

- [ ] **Step 1: Rewrite `App.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import type { BoardItem, ChatMessage } from "@workspace/shared";
import { WorkspaceProvider, useWorkspace } from "./hooks/WorkspaceContext";
import { LoginScreen } from "./components/LoginScreen";
import { Sidebar } from "./components/Sidebar";
import { TopBar, type WorkspaceView } from "./components/TopBar";
import { FileDropZone } from "./components/FileDropZone";
import { MessageList } from "./components/MessageList";
import { MessageInput, type Prefill } from "./components/MessageInput";
import { BoardView } from "./components/BoardView";
import { QuickSwitcher } from "./components/QuickSwitcher";
import { Toasts } from "./components/Toasts";
import { apiBaseUrl } from "./lib/serverUrl";
import { supabase } from "./lib/supabase";

const USERNAME_PATTERN = /^[A-Za-z0-9 _-]{1,32}$/;

/**
 * Boot: ask the server which mode it runs in, then gate accordingly. No auth
 * method configured is treated as a misconfigured deployment, not guest mode
 * — it shows a dead-end screen instead of letting anyone in unauthenticated.
 * Auth mode tracks the Supabase session directly (supabase-js persists and
 * refreshes it in localStorage on its own, no app-managed token storage
 * needed); a brand-new Supabase user who has not yet picked a username sees
 * UsernameStep before the workspace, for either sign-in provider alike.
 */
export default function App() {
  const [authMode, setAuthMode] = useState<{
    googleAuthEnabled: boolean;
    emailAuthEnabled: boolean;
  } | null>(null);
  // undefined = still resolving the initial session; null = signed out.
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  // "unknown" = still checking whether this session has a bound actor yet —
  // see the race note above for why WorkspaceProvider must never render
  // until this resolves to "ok".
  const [usernameStatus, setUsernameStatus] = useState<"unknown" | "ok" | "needs_username">(
    "unknown",
  );

  useEffect(() => {
    let cancelled = false;
    let retry: number | undefined;
    const load = async () => {
      try {
        const res = await fetch(`${apiBaseUrl()}/api/auth/config`);
        const data = (await res.json()) as { googleAuthEnabled: boolean; emailAuthEnabled: boolean };
        if (!cancelled) setAuthMode(data);
      } catch {
        // Server not up yet (dev restarts): keep asking, it decides the flow.
        if (!cancelled) retry = window.setTimeout(() => void load(), 2000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
    };
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setUsernameStatus("unknown");
      return;
    }
    setUsernameStatus("unknown");
    let cancelled = false;
    (async () => {
      const res = await fetch(`${apiBaseUrl()}/api/auth/session`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = (await res.json()) as { status: "ok" | "needs_username" };
      if (!cancelled) setUsernameStatus(data.status);
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.access_token]);

  if (!authMode || session === undefined) {
    return (
      <div className="flex h-full items-center justify-center bg-chat">
        <p role="status" className="text-muted">
          Connecting…
        </p>
      </div>
    );
  }

  const authEnabled = authMode.googleAuthEnabled || authMode.emailAuthEnabled;

  if (!authEnabled) {
    return (
      <div className="flex h-full items-center justify-center bg-chat">
        <div className="w-96 rounded-lg bg-sidebar p-8 text-center shadow-2xl">
          <h1 className="mb-2 text-2xl font-semibold text-body">Sign-in unavailable</h1>
          <p className="text-muted">
            This workspace isn't configured for sign-in yet. Contact{" "}
            <a href="mailto:hello@convyio.com" className="font-medium text-blurple hover:underline">
              hello@convyio.com
            </a>{" "}
            for access.
          </p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <LoginScreen
        googleAuthEnabled={authMode.googleAuthEnabled}
        emailAuthEnabled={authMode.emailAuthEnabled}
      />
    );
  }

  if (usernameStatus === "unknown") {
    return (
      <div className="flex h-full items-center justify-center bg-chat">
        <p role="status" className="text-muted">
          Connecting…
        </p>
      </div>
    );
  }

  if (usernameStatus === "needs_username") {
    return (
      <UsernameStep accessToken={session.access_token} onDone={() => setUsernameStatus("ok")} />
    );
  }

  return (
    <WorkspaceProvider
      credentials={{ authToken: session.access_token }}
      onAuthRejected={() => void supabase.auth.signOut()}
      onSignOut={() => void supabase.auth.signOut()}
    >
      <Workspace />
    </WorkspaceProvider>
  );
}

/** First sign-in only (either provider): bind the one permanent username to
 *  the new Supabase account. */
function UsernameStep({ accessToken, onDone }: { accessToken: string; onDone: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const trimmed = name.trim();
  const valid = USERNAME_PATTERN.test(trimmed);

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${apiBaseUrl()}/api/auth/username`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ username: trimmed }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setError(data.message ?? `Could not save the username (${res.status}).`);
        return;
      }
      onDone();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-chat">
      <div className="w-96 animate-fade-in rounded-lg bg-sidebar p-8 shadow-2xl">
        <h1 className="mb-1 text-2xl font-semibold text-body">Pick a username</h1>
        <p className="mb-6 text-muted">
          This is who you are here, permanently — choose well.
        </p>
        <label
          htmlFor="username"
          className="mb-2 block text-xs font-bold tracking-wide text-muted uppercase"
        >
          Username
        </label>
        <input
          id="username"
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          className="mb-2 w-full rounded border border-divider bg-input px-3 py-2.5 text-body outline-none focus:ring-2 focus:ring-blurple"
          placeholder="e.g. harris"
          maxLength={32}
        />
        <p role={error ? "alert" : undefined} className={`mb-4 text-sm ${error ? "text-dead" : "text-faint"}`}>
          {error ?? "1-32 characters: letters, digits, spaces, - and _"}
        </p>
        <button
          onClick={() => void submit()}
          disabled={!valid || submitting}
          className="w-full rounded bg-blurple py-2.5 font-medium text-mention-text transition hover:bg-working disabled:cursor-not-allowed disabled:opacity-50"
        >
          Join Workspace
        </button>
      </div>
    </div>
  );
}

/** The workspace shell: view/channel navigation and cross-view jumps. */
function Workspace() {
  const workspace = useWorkspace();
  const [channel, setChannel] = useState("general");
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [view, setView] = useState<WorkspaceView>("chat");
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [highlightRef, setHighlightRef] = useState<string | null>(null);
  const highlightTimer = useRef<number | null>(null);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // Switching channels leaves any in-flight reply behind and marks the
  // channel we're entering as read (also covers the initial mount).
  useEffect(() => {
    setReplyTo(null);
    workspace.markRead(channel);
  }, [channel]);

  // The active channel can vanish out from under the viewer (someone else
  // deletes it); archived channels stay viewable, so only a real delete
  // needs a fallback.
  useEffect(() => {
    if (
      !workspace.channels.includes(channel) &&
      !workspace.archivedChannels.includes(channel)
    ) {
      setChannel("general");
    }
  }, [workspace.channels, workspace.archivedChannels, channel]);

  const cycleChannel = (dir: -1 | 1) => {
    const { channels } = workspace;
    if (channels.length === 0) return;
    const idx = channels.indexOf(channel);
    setChannel(channels[(idx + dir + channels.length) % channels.length]);
  };

  const selectFromSwitcher = (target: string) => {
    setChannel(target);
    setView("chat");
    setSwitcherOpen(false);
  };

  // Single window-level listener for the two global shortcuts, registered
  // with useCapture so it runs before MessageInput's own keydown handling —
  // that handler's ArrowUp-to-edit branch has no modifier check, so without
  // capture+stopPropagation an Alt+ArrowUp while composing would fire both.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault(); // keep the browser's own search bar from opening
        setSwitcherOpen(true);
        return;
      }
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        e.stopPropagation();
        cycleChannel(e.key === "ArrowUp" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [workspace.channels, channel]);

  const prefillText = (text: string) => setPrefill({ text, nonce: Date.now() });

  const handleRefClick = (ref: string) => {
    setView("board");
    const item = workspace.board.find((i) => i.ref === ref);
    setOpenItemId(item?.id ?? null);
    setHighlightRef(ref);
    if (highlightTimer.current != null) {
      window.clearTimeout(highlightTimer.current);
    }
    highlightTimer.current = window.setTimeout(
      () => setHighlightRef(null),
      2000,
    );
  };

  const discussItem = (item: BoardItem) => {
    workspace.sendMessage(`discuss ${item.ref} — "${item.title}"`, channel);
    setView("chat");
  };

  const jumpToTrace = (runId: string) => {
    setView("chat");
    window.setTimeout(() => {
      document
        .getElementById(`trace-${runId}`)
        ?.scrollIntoView({ behavior: "smooth" });
    }, 50);
  };

  const handleSend = (content: string, attachmentIds: string[]): boolean => {
    // Attachment-carrying sends are always messages, never slash commands.
    if (attachmentIds.length === 0 && content.startsWith("/")) {
      const command = content.slice(1).split(/\s+/)[0].toLowerCase();
      switch (command) {
        case "clear":
          workspace.clearMessages();
          return true;
        case "interrupt": {
          const match = content.match(/^\/interrupt\s+@(\S+)\s+(.+)$/s);
          if (!match) {
            workspace.notify("Usage: /interrupt @agent <new prompt>");
            return false;
          }
          const [, target, prompt] = match;
          workspace.interrupt(target, prompt);
          return true;
        }
        default:
          workspace.notify(`Unknown command: /${command}`);
          return false;
      }
    }
    workspace.sendMessage(content, channel, attachmentIds, replyTo?.id);
    setReplyTo(null);
    return true;
  };

  return (
    <div className="flex h-full">
      <Sidebar
        channel={channel}
        onSelectChannel={setChannel}
        onDiscuss={discussItem}
        onPrefill={prefillText}
      />
      <main className="flex min-w-0 flex-1 flex-col bg-chat">
        <TopBar channel={channel} view={view} onSetView={setView} />
        {view === "chat" ? (
          <FileDropZone
            onFiles={(files) => workspace.addAttachments(channel, files)}
          >
            <MessageList
              channel={channel}
              onRefClick={handleRefClick}
              onReply={setReplyTo}
              editingId={editingId}
              onEditingIdChange={setEditingId}
              onDiscuss={discussItem}
              onPrefill={prefillText}
            />
            <MessageInput
              channel={channel}
              onSend={handleSend}
              prefill={prefill}
              replyTo={replyTo}
              onCancelReply={() => setReplyTo(null)}
              editingId={editingId}
              onRequestEditLast={setEditingId}
            />
          </FileDropZone>
        ) : (
          <BoardView
            highlightRef={highlightRef}
            openItemId={openItemId}
            onOpenItem={setOpenItemId}
            onDiscuss={discussItem}
            onJumpToTrace={jumpToTrace}
          />
        )}
      </main>
      {!workspace.connected && (
        <div
          role="status"
          className="fixed top-14 left-1/2 z-[60] -translate-x-1/2 rounded-full bg-popup px-3 py-1 text-xs font-semibold text-working shadow-lg"
        >
          {workspace.self ? "Reconnecting…" : "Connecting…"}
        </div>
      )}
      <Toasts
        toasts={workspace.toasts}
        onDismiss={workspace.dismissToast}
        onAction={(toast) => {
          if (!toast.action) return;
          setView("board");
          setOpenItemId(toast.action.itemId);
        }}
      />
      {switcherOpen && (
        <QuickSwitcher
          channels={workspace.channels}
          unreadCount={workspace.unreadCount}
          onSelect={selectFromSwitcher}
          onClose={() => setSwitcherOpen(false)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd /home/harris/Programming/convyio/app
git add packages/client/src/App.tsx
git commit -m "Drive App auth state off the Supabase session instead of a stored token"
```

### Task 18: Update `App.test.tsx` for the Supabase-session boot flow

**Files:**
- Modify (full rewrite): `packages/client/src/App.test.tsx`

**Interfaces:**
- Consumes: `vi.mock("./lib/supabase", ...)` — a fake Supabase client exposing only `auth.getSession`/`auth.onAuthStateChange`/`auth.signOut`, controlled via a `vi.hoisted` mutable `authState.session`, mirroring the existing `vi.mock("./ws", ...)` pattern already in this file for the websocket boundary.

This file's old `bootWorkspace()` helpers seed `window.localStorage.setItem("authToken", "tok-1")`, which `App.tsx` no longer reads (Task 17 removed all app-managed token storage in favor of the live Supabase session). They also mock only `GET /api/auth/config`, letting every other fetch hang forever — Task 17 adds a second fetch (`GET /api/auth/session`) that `App` must resolve before it ever reaches the chat view, so the mock needs a branch for it too.

- [ ] **Step 1: Rewrite `App.test.tsx`**

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";

// Only the network boundary is mocked; the boot decision itself runs for real.
const fetchMock = vi.fn<typeof fetch>();

// The websocket boundary is replaced by a fake that greets with a welcome
// frame and records what the UI sends, so the real Workspace can boot.
// `historySeed` lets individual tests plant chat history before boot (e.g. an
// own message to edit); tests reset it in beforeEach.
const { sent, historySeed, channelsSeed, authState } = vi.hoisted(() => ({
  sent: [] as Array<{ type: string; content?: string; replyToId?: string }>,
  historySeed: [] as unknown[],
  channelsSeed: ["general"] as string[],
  // The Supabase auth boundary: null = signed out. Tests set this directly
  // instead of seeding localStorage, since App.tsx now sources its session
  // from supabase.auth.getSession()/onAuthStateChange, not stored tokens.
  authState: { session: null as null | { access_token: string } },
}));

vi.mock("./lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: authState.session } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut: () => Promise.resolve({ error: null }),
    },
  },
}));

vi.mock("./ws", () => {
  class WorkspaceSocket {
    private listeners = new Set<(event: unknown) => void>();
    connect() {
      const self = {
        id: "u-1",
        name: "hana",
        kind: "human",
        status: "",
        runState: "idle",
        online: true,
      };
      for (const listener of this.listeners) {
        listener({
          type: "welcome",
          self,
          history: historySeed,
          participants: [self],
          channels: channelsSeed,
          archivedChannels: [],
          pinnedChannels: [],
          demoChannels: [],
          token: "tok-1",
          apiUrl: "http://api.test",
        });
      }
    }
    send(event: { type: string }) {
      sent.push(event);
    }
    onEvent(listener: (event: unknown) => void) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    onDisconnect() {
      return () => {};
    }
    close() {}
  }
  return { WorkspaceSocket };
});

// MessageList is owned by a parallel change and isn't under test here; stub
// it so App's reply/edit wiring (the thing this file covers) is observable
// without depending on MessageList's own reply-button UI.
vi.mock("./components/MessageList", () => ({
  MessageList: ({
    editingId,
    onReply,
  }: {
    editingId: string | null;
    onReply: (message: {
      id: string;
      authorId: string;
      authorName: string;
      authorKind: string;
      content: string;
      timestamp: number;
    }) => void;
  }) => (
    <>
      <div data-testid="editing-id">{editingId ?? ""}</div>
      <button
        onClick={() =>
          onReply({
            id: "m-1",
            authorId: "u-2",
            authorName: "bob",
            authorKind: "human",
            content: "hello world",
            timestamp: Date.now(),
          })
        }
      >
        trigger-reply
      </button>
    </>
  ),
}));

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  }) as Response;

describe("App boot decision", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    authState.session = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("no auth method configured shows the contact-support dead end", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { googleAuthEnabled: false, emailAuthEnabled: false }),
    );

    render(<App />);

    expect(await screen.findByText("Sign-in unavailable")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "hello@convyio.com" })).toHaveAttribute(
      "href",
      "mailto:hello@convyio.com",
    );
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/auth/config"));
  });

  it("auth mode shows the Google login screen instead", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { googleAuthEnabled: true, emailAuthEnabled: false }),
    );

    render(<App />);

    expect(await screen.findByText("Sign in")).toBeInTheDocument();
    expect(screen.queryByText("Join the workspace")).not.toBeInTheDocument();
  });
});

describe("Workspace composer", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    sent.length = 0;
    historySeed.length = 0;
    channelsSeed.length = 0;
    channelsSeed.push("general");
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  /** Boot straight into the chat view and hand back the composer textarea. */
  const bootWorkspace = async (): Promise<HTMLElement> => {
    authState.session = { access_token: "tok-1" };
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/api/auth/config")) {
        return Promise.resolve(jsonResponse(200, { googleAuthEnabled: false, emailAuthEnabled: true }));
      }
      if (url.includes("/api/auth/session")) {
        return Promise.resolve(jsonResponse(200, { status: "ok" }));
      }
      // Board snapshot etc.: stay pending, irrelevant to these tests.
      return new Promise<Response>(() => {});
    });
    render(<App />);
    return await screen.findByLabelText("Message general");
  };

  it("an unknown slash command toasts and keeps the draft", async () => {
    const user = userEvent.setup();
    const composer = await bootWorkspace();

    await user.type(composer, "/foo{Enter}");

    expect(await screen.findByText("Unknown command: /foo")).toBeInTheDocument();
    expect(composer).toHaveValue("/foo");
    expect(sent.filter((e) => e.type === "message")).toHaveLength(0);
  });

  it("Shift+Enter inserts a newline instead of sending", async () => {
    const user = userEvent.setup();
    const composer = await bootWorkspace();

    await user.type(composer, "line1{Shift>}{Enter}{/Shift}line2");

    expect(composer).toHaveValue("line1\nline2");
    expect(sent.filter((e) => e.type === "message")).toHaveLength(0);

    await user.keyboard("{Enter}");
    expect(sent.filter((e) => e.type === "message")).toEqual([
      expect.objectContaining({ content: "line1\nline2" }),
    ]);
    expect(composer).toHaveValue("");
  });

  it("reply pill appears and the × clears it", async () => {
    const user = userEvent.setup();
    await bootWorkspace();

    await user.click(screen.getByRole("button", { name: "trigger-reply" }));
    expect(await screen.findByText("Replying to bob")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel reply" }));
    expect(screen.queryByText("Replying to bob")).not.toBeInTheDocument();
  });

  it("sending with a reply passes replyToId and clears the pill", async () => {
    const user = userEvent.setup();
    const composer = await bootWorkspace();

    await user.click(screen.getByRole("button", { name: "trigger-reply" }));
    await screen.findByText("Replying to bob");

    await user.type(composer, "thanks{Enter}");

    expect(sent.filter((e) => e.type === "message")).toEqual([
      expect.objectContaining({ content: "thanks", replyToId: "m-1" }),
    ]);
    expect(screen.queryByText("Replying to bob")).not.toBeInTheDocument();
  });

  it("Escape clears reply state", async () => {
    const user = userEvent.setup();
    await bootWorkspace();

    await user.click(screen.getByRole("button", { name: "trigger-reply" }));
    await screen.findByText("Replying to bob");

    // The reply pill focuses the composer, so Escape lands on it.
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Replying to bob")).not.toBeInTheDocument();
  });

  it("ArrowUp in an empty composer sets editingId to the user's own last message", async () => {
    historySeed.push({
      id: "own-msg-1",
      authorId: "u-1",
      authorName: "hana",
      authorKind: "human",
      content: "my earlier message",
      timestamp: Date.now(),
      channel: "general",
    });
    const user = userEvent.setup();
    const composer = await bootWorkspace();

    await user.click(composer);
    await user.keyboard("{ArrowUp}");

    expect(await screen.findByTestId("editing-id")).toHaveTextContent("own-msg-1");
  });

  it("ArrowUp with text in the composer does not request an edit", async () => {
    historySeed.push({
      id: "own-msg-1",
      authorId: "u-1",
      authorName: "hana",
      authorKind: "human",
      content: "my earlier message",
      timestamp: Date.now(),
      channel: "general",
    });
    const user = userEvent.setup();
    const composer = await bootWorkspace();

    await user.type(composer, "still typing");
    await user.keyboard("{ArrowUp}");

    expect(screen.getByTestId("editing-id")).toHaveTextContent("");
  });
});

describe("Workspace keyboard navigation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    sent.length = 0;
    historySeed.length = 0;
    channelsSeed.length = 0;
    channelsSeed.push("general", "random", "bugs");
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  /** Boot straight into the chat view and hand back the composer textarea. */
  const bootWorkspace = async (): Promise<HTMLElement> => {
    authState.session = { access_token: "tok-1" };
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/api/auth/config")) {
        return Promise.resolve(jsonResponse(200, { googleAuthEnabled: false, emailAuthEnabled: true }));
      }
      if (url.includes("/api/auth/session")) {
        return Promise.resolve(jsonResponse(200, { status: "ok" }));
      }
      return new Promise<Response>(() => {});
    });
    render(<App />);
    return await screen.findByLabelText("Message general");
  };

  it("Alt+ArrowDown advances the channel and wraps at the end", async () => {
    const user = userEvent.setup();
    await bootWorkspace();

    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(await screen.findByLabelText("Message random")).toBeInTheDocument();

    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(await screen.findByLabelText("Message bugs")).toBeInTheDocument();

    // Wraps back around to the first channel.
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(await screen.findByLabelText("Message general")).toBeInTheDocument();
  });

  it("Alt+ArrowUp cycles channels while the composer is focused, without also triggering its own edit-last shortcut", async () => {
    historySeed.push({
      id: "own-msg-1",
      authorId: "u-1",
      authorName: "hana",
      authorKind: "human",
      content: "my earlier message",
      timestamp: Date.now(),
      channel: "general",
    });
    const user = userEvent.setup();
    const composer = await bootWorkspace();
    await user.click(composer);

    // Backward from "general" (index 0) wraps to the last channel, "bugs".
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");

    expect(await screen.findByLabelText("Message bugs")).toBeInTheDocument();
    expect(screen.getByTestId("editing-id")).toHaveTextContent("");
  });

  it("Ctrl+K opens the quick switcher", async () => {
    const user = userEvent.setup();
    await bootWorkspace();

    await user.keyboard("{Control>}k{/Control}");
    expect(await screen.findByLabelText("Jump to channel")).toBeInTheDocument();
  });

  it("typing filters the channel list", async () => {
    const user = userEvent.setup();
    await bootWorkspace();

    await user.keyboard("{Control>}k{/Control}");
    const input = await screen.findByLabelText("Jump to channel");
    await user.type(input, "bug");

    const list = screen.getByRole("list");
    expect(within(list).getByText("bugs")).toBeInTheDocument();
    expect(within(list).queryByText("random")).not.toBeInTheDocument();
  });

  it("Enter selects the highlighted channel and closes the switcher", async () => {
    const user = userEvent.setup();
    await bootWorkspace();

    await user.keyboard("{Control>}k{/Control}");
    const input = await screen.findByLabelText("Jump to channel");
    await user.type(input, "bug{Enter}");

    expect(await screen.findByLabelText("Message bugs")).toBeInTheDocument();
    expect(screen.queryByLabelText("Jump to channel")).not.toBeInTheDocument();
  });

  it("Escape closes the switcher", async () => {
    const user = userEvent.setup();
    await bootWorkspace();

    await user.keyboard("{Control>}k{/Control}");
    await screen.findByLabelText("Jump to channel");
    await user.keyboard("{Escape}");

    expect(screen.queryByLabelText("Jump to channel")).not.toBeInTheDocument();
  });
});
```

Note what was deliberately dropped versus the original: the `storageStub()` helper and every `vi.stubGlobal("localStorage", ...)`/`window.sessionStorage.clear()` call are gone — `App.tsx` no longer touches `localStorage`/`sessionStorage` at all (Task 17), so there is nothing left for those tests to seed or isolate there.

- [ ] **Step 2: Run the client test suite**

```bash
cd /home/harris/Programming/convyio/app
npm test -w @workspace/client -- App.test.tsx
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/App.test.tsx
git commit -m "Update App.test.tsx for the Supabase-session boot flow"
```

### Task 19: Update `.env.example`, `docker-compose.yml`, `DEPLOY.md`, `scripts/reset-data.sh`

**Files:**
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `DEPLOY.md`
- Modify (full rewrite): `scripts/reset-data.sh`
- Create: `scripts/reset-data.mjs`

**Interfaces:**
- Produces: `npm run db:wipe` truncates every Postgres table (via the `postgres` package, already a server dependency from Task 2 and hoisted to the repo root's `node_modules` by npm workspaces) and empties the Supabase Storage `attachments` bucket (via `@supabase/supabase-js`), instead of deleting a local SQLite file and `uploads/` directory.

- [ ] **Step 1: Update `.env.example`**

```
# Copy to .env (repo root) and fill in what you use — one file feeds every
# process: `npm run dev` (server/agent load it via dotenv, client via Vite's
# envDir) and Docker Compose (which injects it as real container env vars).
# Never commit the real .env.

# --- Supabase (required — see DEPLOY.md for project setup) ---
# SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
# SUPABASE_ANON_KEY=your-anon-key
# SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
# SUPABASE_DB_URL=postgresql://postgres:password@db.xxxxxxxxxxxx.supabase.co:5432/postgres
# Same URL/anon key, exposed to the browser bundle (Vite requires the
# VITE_ prefix); values are identical to SUPABASE_URL/SUPABASE_ANON_KEY above.
# VITE_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
# VITE_SUPABASE_ANON_KEY=your-anon-key

# --- Agent (optional — without a key the workspace runs with no AI agent) ---
# AGENT_PROVIDER=gemini            # "gemini" (default) or "claude"
# GEMINI_API_KEY=your-gemini-api-key   # gemini provider only
# AGENT_NAME=noodle
# AGENT_MODEL=gemini-2.5-flash     # or claude-sonnet-5 for the claude provider
# claude provider: no API key. Run `claude login` once on this host so the
# bundled claude CLI has a subscription session before starting the agent.
# CLAUDE_WORKDIR=./data/workspace  # cwd for Claude Code's native file/bash tools

# --- Login (unset both = clients see a "contact support" dead end) ---
# Google sign-in and email/password are both configured in the Supabase
# dashboard (Authentication → Providers); these two flags only control
# whether the client shows each option — they do not enable the provider.
# GOOGLE_AUTH_ENABLED=1
# EMAIL_AUTH=1
# Long random secret the agent presents to join an auth-enabled server:
#   openssl rand -hex 32
# AGENT_TOKEN=

# --- Server (container defaults are fine; see DEPLOY.md for the full table) ---
# PORT=3001
# DATA_DIR=/data   # agent file/bash-tool sandbox only — no longer holds the
                    # database or uploads, both live in Supabase now.
```

- [ ] **Step 2: Update `docker-compose.yml`**

Change:
```yaml
    volumes:
      - ./data:/data
```
to:
```yaml
    # Only the agent's file/bash-tool sandbox lives here now — the database
    # and uploads are both in Supabase, not on this volume.
    volumes:
      - ./data:/data
```

(The mount itself is unchanged; only the comment explaining its now-narrower purpose is new.)

- [ ] **Step 3: Update `DEPLOY.md`**

Apply these changes:

1. Delete the bare-metal section's Node version caveat — it exists only because `node:sqlite` needed `--experimental-sqlite` on Node < 23.4, and `node:sqlite` no longer appears anywhere in this codebase:

Change:
```
Node 23.4+ (`node:sqlite` unflagged; Node 22 needs `--experimental-sqlite`).
```
to:
```
Node 20+ (no SQLite version constraint anymore — the database is Supabase Postgres).
```

2. Replace the Environment table:

```markdown
## Environment

| Variable                    | Used by | Default                    | Meaning                                                                 |
| ---------------------------- | ------- | --------------------------- | ------------------------------------------------------------------------ |
| `PORT`                      | server  | `3001`                     | HTTP + websocket port.                                                  |
| `DATA_DIR`                  | server  | `./data` (`/data` in image)| Agent file/bash-tool sandbox only (`Toolman`) — the database and uploads live in Supabase, not here. |
| `SUPABASE_URL`               | server  | — (required)                | Supabase project URL.                                                    |
| `SUPABASE_SERVICE_ROLE_KEY`  | server  | — (required)                | Service-role key: verifies user JWTs and reads/writes Storage server-side. Never expose to the client. |
| `SUPABASE_DB_URL`             | server  | — (required)                | Postgres connection string (Supabase project settings → Database).      |
| `VITE_SUPABASE_URL`          | client  | — (required)                | Same project URL, exposed to the browser bundle.                        |
| `VITE_SUPABASE_ANON_KEY`     | client  | — (required)                | Supabase anon (public) key — safe to expose, used for browser sign-in.  |
| `GEMINI_API_KEY`             | agent   | —                           | Enables the agent; unset = no agent starts.                             |
| `AGENT_NAME`                 | agent   | `noodle`                   | The agent's display name.                                               |
| `AGENT_MODEL`                | agent   | `gemini-2.5-flash`         | Gemini model id.                                                        |
| `AGENT_PROVIDER`             | agent   | `gemini`                   | `gemini` or `claude`. `claude` needs no API key but does need a `claude login` session — see below. |
| `CLAUDE_WORKDIR`             | agent   | `./data/workspace`         | cwd for Claude Code's native file/bash tools when `AGENT_PROVIDER=claude`. |
| `GOOGLE_AUTH_ENABLED`        | server  | — (sign-in unavailable)    | Set to `1` = Google Sign-In offered to humans. The OAuth client itself is configured in the Supabase dashboard, not here — see "Google Sign-In" below. |
| `EMAIL_AUTH`                 | server  | — (sign-in unavailable)    | Set to `1` = email/password sign-in offered. Neither this nor `GOOGLE_AUTH_ENABLED` set = the server refuses every join and the client shows a "contact support" dead end (`hello@convyio.com`) instead of a login screen. |
| `AGENT_TOKEN`                 | both    | —                           | Shared secret agents join with when auth is on. Long and random.        |
| `CLIENT_DIST`                 | server  | `packages/client/dist`     | Where the built client lives; absent = API only (dev).                  |
| `CORS_ORIGIN`                 | server  | `http://localhost:5173`    | Dev-only: the Vite origin allowed to call the API cross-origin.         |
| `VITE_WS_URL`                 | client  | —                           | Dev-only build override; production derives from `window.location`.     |
```

3. Add a new section right before "## Google Sign-In":

```markdown
## Supabase setup

1. Create a project at [supabase.com](https://supabase.com) (the free tier is enough for this app's scale).
2. Apply the schema: `npx supabase link --project-ref <your-project-ref> && npx supabase db push` (or `psql "$SUPABASE_DB_URL" -f supabase/migrations/20260809120000_init.sql`), then create the private `attachments` Storage bucket — see `supabase/migrations/` and Task 1 of the migration plan for the exact commands.
3. Copy the project's URL and keys (Project Settings → API) into `.env`: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL` (same as `SUPABASE_URL`), `VITE_SUPABASE_ANON_KEY` (same as `SUPABASE_ANON_KEY`); copy the Postgres connection string (Project Settings → Database → Connection string → URI) into `SUPABASE_DB_URL`.
4. In Authentication → Providers, enable Email (for `EMAIL_AUTH=1`) and/or Google (for `GOOGLE_AUTH_ENABLED=1` — see "Google Sign-In" below for the OAuth client setup Google itself requires).
5. If email/password sign-in is enabled, decide whether Authentication → Settings → "Confirm email" should be on. This app's UI does not currently have a "check your email" step — leaving it off gives the same zero-friction signup the app had before this migration; turning it on will strand new signups on this app's UI until that flow is built.
```

4. Rewrite "## Google Sign-In" (the OAuth client's constraints changed: the app used to render Google's own button in-page with no redirect URI; it now uses Supabase's `signInWithOAuth`, which is a real browser redirect through Supabase's own callback URL):

```markdown
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
```

5. Update the "## Data" section:

```markdown
## Data

- The database, auth, and uploaded files all live in Supabase — back up
  through Supabase's own dashboard/CLI (`supabase db dump`), not this
  container. `DATA_DIR` only holds the agent's file/bash-tool sandbox now.
- Uploads are unauthenticated capability URLs (the unguessable UUID is the
  secret, the Discord-CDN model — recorded in ARCHITECTURE.md): the server
  proxies them from a private Supabase Storage bucket using the service-role
  key, so the bucket itself is never exposed directly.
- Known gap: no rate limiting yet.
```

- [ ] **Step 4: Rewrite `scripts/reset-data.sh` to call a new `scripts/reset-data.mjs`**

```bash
#!/usr/bin/env bash
# Wipes all persisted workspace data: users, messages, board items, channels,
# and uploaded files — everything in Supabase Postgres + Storage that this
# app owns. The server recreates a fresh (empty) database and a new
# server_id on next start, exactly like before this was Supabase-backed.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "This permanently deletes all users, messages, and board data in the"
echo "Supabase project configured by this repo's .env."
read -rp "Type 'yes' to continue: " confirm
[ "$confirm" = "yes" ] || { echo "Aborted."; exit 1; }

node scripts/reset-data.mjs
```

- [ ] **Step 5: Write `scripts/reset-data.mjs`**

```js
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const dbUrl = process.env.SUPABASE_DB_URL;
const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!dbUrl || !supabaseUrl || !serviceRoleKey) {
  console.error("SUPABASE_DB_URL/SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY must be set in .env");
  process.exit(1);
}

const sql = postgres(dbUrl);
await sql`
  TRUNCATE TABLE
    attachments, message_reactions, messages, board_events, board_items,
    ref_counters, channels, actors, meta
  RESTART IDENTITY CASCADE
`;
await sql.end();
console.log("Wiped every table (a new server_id is generated on next server start).");

const supabase = createClient(supabaseUrl, serviceRoleKey);
const { data: files, error: listError } = await supabase.storage.from("attachments").list();
if (listError) throw listError;
if (files && files.length > 0) {
  const { error: removeError } = await supabase.storage.from("attachments").remove(files.map((f) => f.name));
  if (removeError) throw removeError;
}
console.log(`Wiped ${files?.length ?? 0} object(s) from the attachments bucket.`);
```

- [ ] **Step 6: Commit**

```bash
cd /home/harris/Programming/convyio/app
chmod +x scripts/reset-data.sh
git add .env.example docker-compose.yml DEPLOY.md scripts/reset-data.sh scripts/reset-data.mjs
git commit -m "Update deploy docs and the data-wipe script for Supabase"
```

### Task 20: Update `ARCHITECTURE.md`'s stale SQLite/Google-auth/local-disk descriptions

**Files:**
- Modify: `ARCHITECTURE.md`

**Interfaces:** none (documentation only).

`ARCHITECTURE.md` describes `WorkspaceDb` as SQLite, `Attachments` as local-disk, `Auth`/`googleIdToken.ts` as hand-rolled Google ID-token verification with `auth_sessions` DB rows — all now false. Following this file's own convention of appending dated decisions rather than rewriting history (see its existing "Decisions a reader would not predict" log), update the component descriptions in place (they describe current behavior, not history) and append one new dated entry to the decisions log rather than editing the older entries.

- [ ] **Step 1: Update the component descriptions**

Change:
```markdown
- `WorkspaceDb` (`db.ts`) — owns the SQLite file: schema, migrations,
  transactions, actors, per-server ref allocation.
```
to:
```markdown
- `WorkspaceDb` (`db.ts`) — owns the Supabase Postgres connection: queries,
  transactions, actors, per-server ref allocation. Schema/migrations live in
  `supabase/migrations/`, applied via the Supabase CLI, not in this file.
```

Change:
```markdown
- `Attachments` (`chat/`) — owns uploaded files: stores bytes on disk
  (`data/uploads/<id>`), records metadata, binds them to messages, serves
  them back.  → WorkspaceDb
```
to:
```markdown
- `Attachments` (`chat/`) — owns uploaded files: stores bytes in the
  Supabase Storage `attachments` bucket, records metadata, binds them to
  messages, serves them back.  → WorkspaceDb
```

Change:
```markdown
- `Auth` (`auth/`) — owns login identity: exchanges verified Google
  credentials for workspace actors and persistent 30-day sessions
  (auth_sessions), so the hub and the API never know Google exists.
  → WorkspaceDb
- `googleIdToken.ts` (`auth/`) — verifies a Google ID token and nothing
  else; the JWKS fetcher is injectable so tests never touch the network.
- `joinPolicy.ts` (`auth/`) — the auth-mode join gate: resolves a join frame
  to an allowed participant name (human session token or agent shared
  secret), so the Hub never knows how identities are proven.  → Auth
```
to:
```markdown
- `Auth` (`auth/`) — bridges a verified Supabase session to a workspace
  actor: re-verifies the caller's Supabase access token on every call (via
  a Supabase admin client) and maps it onto an `actors` row, creating one
  the first time a user picks a username. Google OAuth and email/password
  are both entirely Supabase Auth's problem — this class never sees a
  password or a Google credential, only the resulting JWT.  → WorkspaceDb
- `joinPolicy.ts` (`auth/`) — the auth-mode join gate: resolves a join frame
  to an allowed participant name (a verified Supabase session or the
  agent's shared secret), so the Hub never knows how identities are proven.
  → Auth
```

Change:
```markdown
- `messages.author_id` has no FK to `actors`: history imported from the
  legacy JSON store may predate actor rows.
```
to:
```markdown
- `messages.author_id` has no FK to `actors`: kept loose so a message and
  its reactions can be deleted together without a cascade depending on the
  author row still existing.
```

- [ ] **Step 2: Append a new decisions-log entry**

Add this entry to the end of the "## Decisions a reader would not predict" list (after the last existing entry):

```markdown
- 2026-08-09 — Persistence, auth, and file storage moved from
  `node:sqlite`/hand-rolled Google ID-token verification+scrypt/local disk
  to Supabase (Postgres, Auth, Storage) — a clean cutover, no data
  migration, since there was no production data yet. Consequence: every
  store method that used to be a synchronous `DatabaseSync` call is now
  `async` (a Postgres round-trip); `actors.id` for a Supabase-authenticated
  human is the Supabase Auth user id (`auth.users.id`), not an
  app-generated uuid; agent actors are unaffected (they never went through
  Supabase Auth). See `docs/superpowers/plans/2026-08-09-supabase-migration.md`.
```

- [ ] **Step 3: Commit**

```bash
cd /home/harris/Programming/convyio/app
git add ARCHITECTURE.md
git commit -m "Update ARCHITECTURE.md for the Supabase migration"
```

### Task 21: Full-repo verification and manual smoke test

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Full typecheck**

```bash
cd /home/harris/Programming/convyio/app
npm run typecheck
```

Expected: all four packages (`shared`, `server`, `client`, `agent`) pass with zero errors. `agent` is untouched by this migration but is part of the typecheck script, so a pre-existing failure there is not this plan's concern — a *new* failure introduced by a shared-type change would be, so check its output specifically if anything fails.

- [ ] **Step 2: Full test run**

```bash
npm test
```

Expected: `shared`, `server`, `client`, and `agent` test suites all pass. The server suite talks to the real hosted Supabase project throughout (Task 3's design decision) — a flaky failure here is far more likely to be a network hiccup against Supabase than a code defect; rerun once before investigating further.

- [ ] **Step 3: Set up local env and Supabase dashboard settings for a manual run**

Confirm the root `.env` has every variable Task 19's `.env.example` documents (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, plus `EMAIL_AUTH=1` for this smoke test). In the Supabase dashboard, Authentication → Settings, turn **off** "Confirm email" for this test run (Task 19 Step 3's point 4 explains why: this app's UI has no "check your email" step yet).

- [ ] **Step 4: Run the server and client in dev mode**

```bash
cd /home/harris/Programming/convyio/app
npm run dev
```

Expected console lines: `[auth] Email sign-in enabled`, `[hub] listening on ws://localhost:3001 (http api on http://localhost:3001)`. Open `http://localhost:5173`.

- [ ] **Step 5: Sign up, verify the actor row, sign out, sign back in**

In the browser: sign up with a new email/password and a username. Expect to land directly in the chat workspace (no separate email-confirmation step, since Step 3 disabled it). Verify the actor row landed with the Supabase user id as its primary key:

```bash
psql "$SUPABASE_DB_URL" -c "select id, kind, display_name, email from actors;"
```

Expected: one row, `kind = 'human'`, `id` matching a uuid (the Supabase `auth.users.id`, confirmable via `psql "$SUPABASE_DB_URL" -c "select id, email from auth.users;"` — the two ids should match). Click sign out (wherever the workspace UI exposes it); expect to land back on the login screen. Sign back in with the same email/password; expect to land directly back in the workspace (no username step this time — Task 10/17's `needs_username` path only fires once).

- [ ] **Step 6: Send a message, upload a file, reload**

Send a chat message. Upload an image via drag-and-drop or the attach button and send it in a message. Reload the page (`Cmd/Ctrl+R`). Expect both the text message and the image (rendered inline, loaded successfully — confirming `GET /api/uploads/:id/:name` is correctly streaming from Supabase Storage) to still be present after reload. Confirm the object landed in Storage:

```bash
psql "$SUPABASE_DB_URL" -c "select id, name, mime, size from attachments;"
```

- [ ] **Step 7: Create and approve a board item**

Switch to the board view, create a board item. Expect it to appear with status `approved` (human-created items are approved by construction). Confirm the row and its audit event:

```bash
psql "$SUPABASE_DB_URL" -c "select ref, title, status from board_items;"
psql "$SUPABASE_DB_URL" -c "select type, actor_id, created_at from board_events order by id;"
```

Expected: one `board_items` row, one `board_events` row with `type = 'item.created'`.

- [ ] **Step 8: Restart the server, confirm everything survived**

Stop `npm run dev` (Ctrl+C) and restart it. Reload the browser tab. Expect the chat message, the uploaded image, and the board item from Steps 6–7 to all still be there — this is the actual point of the migration: persistence now survives a process restart the same way it did with the old SQLite file, but via Supabase instead of a local disk file that would be lost on most container platforms' ephemeral filesystems.

- [ ] **Step 9: If `GOOGLE_AUTH_ENABLED=1` is also set up, smoke-test Google sign-in**

This step requires the OAuth client and Supabase provider setup from Task 19's rewritten "Google Sign-In" section in `DEPLOY.md` — skip it if that has not been configured for this environment. Otherwise: sign out, click "Sign in with Google," complete the redirect flow, and confirm it lands on the username step (a new Supabase identity) exactly like a first email signup did.
