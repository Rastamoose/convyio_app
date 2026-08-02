import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Actor, ActorKind } from "@workspace/shared";

/**
 * SQLite persistence for the board (spec allows SQLite for local dev; the
 * schema mirrors the Postgres DDL). Chat messages remain in JSON storage —
 * only board data is relational.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actors (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  display_name  TEXT NOT NULL,
  server_id     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS board_items (
  id               TEXT PRIMARY KEY,
  server_id        TEXT NOT NULL,
  ref              TEXT NOT NULL,
  title            TEXT NOT NULL,
  description      TEXT,
  status           TEXT NOT NULL CHECK (status IN
    ('proposed', 'denied', 'approved', 'in_progress', 'blocked', 'done')),
  origin           TEXT NOT NULL CHECK (origin IN ('human', 'agent')),
  created_by       TEXT NOT NULL REFERENCES actors(id),
  approved_by      TEXT REFERENCES actors(id),
  owner            TEXT REFERENCES actors(id),
  proposal_why     TEXT,
  proposal_effect  TEXT,
  created_at       INTEGER NOT NULL,
  approved_at      INTEGER,
  started_at       INTEGER,
  completed_at     INTEGER,
  deleted_at       INTEGER,
  UNIQUE (server_id, ref)
);

CREATE TABLE IF NOT EXISTS board_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id   TEXT NOT NULL,
  item_id     TEXT NOT NULL REFERENCES board_items(id),
  type        TEXT NOT NULL,
  actor_id    TEXT NOT NULL REFERENCES actors(id),
  payload     TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ref_counters (
  server_id  TEXT PRIMARY KEY,
  n          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_server_status ON board_items (server_id, status);
CREATE INDEX IF NOT EXISTS idx_events_server_created ON board_events (server_id, created_at);
`;

export class BoardDb {
  readonly db: DatabaseSync;
  readonly serverId: string;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.serverId = this.ensureServer();
    this.seed();
  }

  /** Run fn inside a transaction; rolls back on throw. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Allocate the next per-server ref inside the caller's transaction. */
  nextRef(serverId: string): string {
    this.db
      .prepare(
        `INSERT INTO ref_counters (server_id, n) VALUES (?, 0)
         ON CONFLICT(server_id) DO NOTHING`,
      )
      .run(serverId);
    const row = this.db
      .prepare(
        `UPDATE ref_counters SET n = n + 1 WHERE server_id = ? RETURNING n`,
      )
      .get(serverId) as { n: number };
    return `task-${row.n}`;
  }

  /** Find or create a persistent actor identity for a joining participant. */
  upsertActor(kind: ActorKind, displayName: string): Actor {
    const existing = this.db
      .prepare(
        `SELECT * FROM actors WHERE server_id = ? AND kind = ? AND lower(display_name) = lower(?)`,
      )
      .get(this.serverId, kind, displayName) as ActorRow | undefined;
    if (existing) return toActor(existing);
    const actor: Actor = {
      id: randomUUID(),
      kind,
      displayName,
      serverId: this.serverId,
    };
    this.db
      .prepare(
        `INSERT INTO actors (id, kind, display_name, server_id) VALUES (?, ?, ?, ?)`,
      )
      .run(actor.id, actor.kind, actor.displayName, actor.serverId);
    return actor;
  }

  getActor(id: string): Actor | null {
    const row = this.db.prepare(`SELECT * FROM actors WHERE id = ?`).get(id) as
      | ActorRow
      | undefined;
    return row ? toActor(row) : null;
  }

  private ensureServer(): string {
    const row = this.db
      .prepare(`SELECT value FROM meta WHERE key = 'server_id'`)
      .get() as { value: string } | undefined;
    if (row) return row.value;
    const id = randomUUID();
    this.db.prepare(`INSERT INTO meta (key, value) VALUES ('server_id', ?)`).run(id);
    return id;
  }

  /** Seed data: two humans and one agent actor (idempotent). */
  private seed(): void {
    const count = this.db
      .prepare(`SELECT count(*) AS c FROM actors WHERE server_id = ?`)
      .get(this.serverId) as { c: number };
    if (count.c > 0) return;
    this.upsertActor("human", "harris");
    this.upsertActor("human", "dana");
    this.upsertActor("agent", "noodle");
  }

  close(): void {
    this.db.close();
  }
}

interface ActorRow {
  id: string;
  kind: ActorKind;
  display_name: string;
  server_id: string;
}

function toActor(row: ActorRow): Actor {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    serverId: row.server_id,
  };
}
