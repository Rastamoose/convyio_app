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
  static async create(connectionString: string, searchPath = "public", max?: number): Promise<WorkspaceDb> {
    const sql = postgres(connectionString, {
      connection: { search_path: searchPath },
      max,
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
