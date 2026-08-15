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
 * Workspace persistence: Supabase-managed Postgres holding the workspace
 * row, global actor identities, workspace memberships, chat messages, and
 * the board. board_events is append-only — it is both the audit trail and
 * the realtime feed, so rows are never updated or deleted. Per-workspace
 * refs come from ref_counters so concurrent creates still allocate unique
 * sequential refs inside their transactions.
 *
 * Schema lives in supabase/migrations/*.sql, applied via the Supabase CLI
 * (or test/pgSchema.ts for tests) — this class only connects and queries,
 * it never creates tables.
 */
export class WorkspaceDb {
  readonly sql: Sql;
  readonly workspaceId: string;
  readonly workspaceName: string;

  private constructor(sql: Sql, workspace: { id: string; name: string }) {
    this.sql = sql;
    this.workspaceId = workspace.id;
    this.workspaceName = workspace.name;
  }

  /**
   * Connect and resolve this deployment's workspace. `searchPath` lets
   * tests point every query at an isolated, throwaway schema instead of
   * `public` (see test/pgSchema.ts) without touching production data.
   */
  /** Wrap an existing postgres.js client (used by tests to share one
   *  connection between schema setup, migrations, and the WorkspaceDb). */
  static async adopt(sql: Sql): Promise<WorkspaceDb> {
    return new WorkspaceDb(sql, await ensureWorkspace(sql));
  }

  static async create(connectionString: string, searchPath = "public", max?: number, idleTimeout?: number): Promise<WorkspaceDb> {
    const sql = postgres(connectionString, {
      connection: { search_path: searchPath },
      max,
      idle_timeout: idleTimeout,
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
    return new WorkspaceDb(sql, await ensureWorkspace(sql));
  }

  /**
   * Run fn inside a transaction; rolls back on throw. Every query inside fn
   * must use the `sql` it is given, not `this.sql` — postgres.js scopes
   * transactional queries to that callback's own client.
   */
  async transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
    return this.sql.begin((tx) => fn(tx as unknown as Sql)) as Promise<T>;
  }

  /** Allocate the next per-workspace ref inside the caller's transaction. */
  async nextRef(sql: Sql, workspaceId: string): Promise<string> {
    await sql`
      INSERT INTO ref_counters (workspace_id, n) VALUES (${workspaceId}, 0)
      ON CONFLICT (workspace_id) DO NOTHING
    `;
    const [row] = await sql<{ n: number }[]>`
      UPDATE ref_counters SET n = n + 1 WHERE workspace_id = ${workspaceId} RETURNING n
    `;
    return `task-${row.n}`;
  }

  async nextPlanRef(sql: Sql, workspaceId: string): Promise<string> {
    await sql`
      INSERT INTO ref_counters (workspace_id, n, plan_n) VALUES (${workspaceId}, 0, 0)
      ON CONFLICT (workspace_id) DO NOTHING
    `;
    const [row] = await sql<{ plan_n: number }[]>`
      UPDATE ref_counters SET plan_n = plan_n + 1 WHERE workspace_id = ${workspaceId} RETURNING plan_n
    `;
    return `plan-${row.plan_n}`;
  }

  /**
   * Find or create a persistent actor identity for a joining participant.
   * A newly created agent is also registered as a workspace member
   * (registered agents survive restarts in the roster); a newly created
   * human is NOT — demo personas and guest joins are identities, not
   * workspace registrations (signup registers via createHuman).
   */
  async upsertActor(kind: ParticipantKind, displayName: string): Promise<Actor> {
    const existing = await this.findActorByName(kind, displayName);
    if (existing) return existing;
    const actor: Actor = { id: randomUUID(), kind, displayName, workspaceId: this.workspaceId };
    await this.sql`
      INSERT INTO actors (id, kind, display_name)
      VALUES (${actor.id}, ${actor.kind}, ${actor.displayName})
    `;
    if (kind === "agent") {
      await this.sql`
        INSERT INTO workspace_members (workspace_id, actor_id, joined_at)
        VALUES (${this.workspaceId}, ${actor.id}, ${Date.now()})
        ON CONFLICT DO NOTHING
      `;
    }
    return actor;
  }

  /**
   * Case-insensitive display-name lookup, matching upsertActor's dedupe
   * rule. Humans are a global, permanent identity (the platform-wide
   * username model), so the lookup has no workspace filter. Agents are
   * not: an agent has no existence outside the workspace that created it,
   * so its name is only taken while it is still a member here — once
   * removed (invite revoked), its old actor row is inert history and the
   * name is free again for what is, deliberately, a brand-new identity.
   */
  async findActorByName(kind: ParticipantKind, displayName: string): Promise<Actor | null> {
    const rows =
      kind === "agent"
        ? await this.sql<ActorRow[]>`
            SELECT a.* FROM actors a
            JOIN workspace_members m ON m.actor_id = a.id AND m.workspace_id = ${this.workspaceId}
            WHERE a.kind = 'agent' AND lower(a.display_name) = lower(${displayName})
          `
        : await this.sql<ActorRow[]>`
            SELECT * FROM actors
            WHERE kind = 'human' AND lower(display_name) = lower(${displayName})
          `;
    return rows[0] ? this.toActor(rows[0]) : null;
  }

  /**
   * Create the persistent human for a Supabase-authenticated signup. `id`
   * is the Supabase Auth user id (auth.users.id) — the two systems share
   * one identity from here on, no local mapping table needed. Signup also
   * auto-registers them into the one workspace; identity and registration
   * are distinct rows. Caller must have checked name availability; the id
   * primary key and email unique index are the last line of defense
   * against duplicates.
   */
  async createHuman(id: string, displayName: string, email: string | null): Promise<Actor> {
    const actor: Actor = { id, kind: "human", displayName, workspaceId: this.workspaceId };
    await this.transaction(async (sql) => {
      await sql`
        INSERT INTO actors (id, kind, display_name, email)
        VALUES (${actor.id}, ${actor.kind}, ${actor.displayName}, ${email})
      `;
      await sql`
        INSERT INTO workspace_members (workspace_id, actor_id, joined_at)
        VALUES (${this.workspaceId}, ${actor.id}, ${Date.now()})
        ON CONFLICT DO NOTHING
      `;
    });
    return actor;
  }

  async getActor(id: string): Promise<Actor | null> {
    const rows = await this.sql<ActorRow[]>`SELECT * FROM actors WHERE id = ${id}`;
    return rows[0] ? this.toActor(rows[0]) : null;
  }

  /** The actors registered into this workspace (workspace_members join). */
  async listMembers(kind?: ParticipantKind): Promise<Actor[]> {
    const rows = kind
      ? await this.sql<ActorRow[]>`
          SELECT a.* FROM actors a
          JOIN workspace_members m ON m.actor_id = a.id
          WHERE m.workspace_id = ${this.workspaceId} AND a.kind = ${kind}
        `
      : await this.sql<ActorRow[]>`
          SELECT a.* FROM actors a
          JOIN workspace_members m ON m.actor_id = a.id
          WHERE m.workspace_id = ${this.workspaceId}
        `;
    return rows.map((row) => this.toActor(row));
  }

  async isMember(actorId: string): Promise<boolean> {
    const rows = await this.sql`
      SELECT 1 FROM workspace_members
      WHERE workspace_id = ${this.workspaceId} AND actor_id = ${actorId}
    `;
    return rows.length > 0;
  }

  /** Remove a member's workspace_members row ("remove from workspace"). The
   *  actor row stays for message/board attribution, so this only affects
   *  isMember/listMembers and anything gated on them (join, roster reload).
   *  Returns false if the actor was not a member to begin with. */
  async removeMember(actorId: string): Promise<boolean> {
    const rows = await this.sql`
      DELETE FROM workspace_members
      WHERE workspace_id = ${this.workspaceId} AND actor_id = ${actorId}
      RETURNING actor_id
    `;
    return rows.length > 0;
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  /** The actors table stores global identity only; an Actor value means
   *  "this identity acting in this workspace", so the WorkspaceDb (which
   *  is per-workspace) stamps its own workspaceId. */
  private toActor(row: ActorRow): Actor {
    return { id: row.id, kind: row.kind, displayName: row.display_name, workspaceId: this.workspaceId };
  }
}

async function ensureWorkspace(sql: Sql): Promise<{ id: string; name: string }> {
  const rows = await sql<{ id: string; name: string }[]>`SELECT id, name FROM workspaces LIMIT 1`;
  if (rows[0]) return rows[0];
  const workspace = { id: randomUUID(), name: "test_space" };
  await sql`
    INSERT INTO workspaces (id, name, created_at)
    VALUES (${workspace.id}, ${workspace.name}, ${Date.now()})
  `;
  return workspace;
}

interface ActorRow {
  id: string;
  kind: ParticipantKind;
  display_name: string;
}
