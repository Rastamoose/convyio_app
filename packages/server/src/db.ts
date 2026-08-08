import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Actor, ParticipantKind } from "@workspace/shared";

/**
 * Workspace persistence: one SQLite file holding actors, chat messages, and
 * the board. board_events is append-only — it is both the audit trail and the
 * realtime feed, so rows are never updated or deleted. Per-server refs come
 * from ref_counters so concurrent creates still allocate unique sequential
 * refs inside their transactions.
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
  server_id     TEXT NOT NULL,
  google_sub    TEXT, -- Google account id for signed-in humans; NULL otherwise
  email         TEXT,
  password_hash TEXT -- set for email/password accounts; NULL otherwise
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token       TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL REFERENCES actors(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
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
  scope_paths      TEXT,
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

CREATE TABLE IF NOT EXISTS channels (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_by  TEXT REFERENCES actors(id), -- NULL = system-seeded
  is_demo     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  author_id    TEXT NOT NULL,
  author_name  TEXT NOT NULL,
  author_kind  TEXT NOT NULL CHECK (author_kind IN ('human', 'agent')),
  content      TEXT NOT NULL,
  channel      TEXT NOT NULL DEFAULT 'general',
  run_id       TEXT,
  trace        TEXT,
  attachments  TEXT,
  pinned_at    INTEGER,
  pinned_by    TEXT,
  edited_at    INTEGER,
  reply_to_id  TEXT,
  created_at   INTEGER NOT NULL
);

-- No FK to messages: like messages.author_id, kept loose; deletes remove both
-- rows in one transaction (MessageStore).
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id  TEXT NOT NULL,
  emoji       TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  actor_name  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (message_id, emoji, actor_id)
);

CREATE TABLE IF NOT EXISTS attachments (
  id           TEXT PRIMARY KEY,
  uploader_id  TEXT NOT NULL REFERENCES actors(id),
  message_id   TEXT, -- NULL until bound to a sent message
  name         TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  width        INTEGER,
  height       INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_server_status ON board_items (server_id, status);
CREATE INDEX IF NOT EXISTS idx_events_server_created ON board_events (server_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages (channel, created_at);
`;

/** Columns added after first release; applied to databases created before them. */
const MIGRATIONS = [
  `ALTER TABLE board_items ADD COLUMN scope_paths TEXT`,
  `ALTER TABLE messages ADD COLUMN attachments TEXT`,
  `ALTER TABLE messages ADD COLUMN pinned_at INTEGER`,
  `ALTER TABLE messages ADD COLUMN pinned_by TEXT`,
  `ALTER TABLE messages ADD COLUMN edited_at INTEGER`,
  `ALTER TABLE messages ADD COLUMN reply_to_id TEXT`,
  `ALTER TABLE actors ADD COLUMN google_sub TEXT`,
  `ALTER TABLE actors ADD COLUMN email TEXT`,
  `ALTER TABLE actors ADD COLUMN password_hash TEXT`,
  // SQLite cannot ALTER-add a UNIQUE column, so uniqueness of google_sub is a
  // partial index; it must run after the ALTERs above so pre-auth databases
  // have the column first.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_actors_google_sub
     ON actors (google_sub) WHERE google_sub IS NOT NULL`,
  // One account per email address, regardless of how it signed up.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_actors_email
     ON actors (lower(email)) WHERE email IS NOT NULL`,
  `ALTER TABLE channels ADD COLUMN archived_at INTEGER`,
  `ALTER TABLE channels ADD COLUMN pinned_at INTEGER`,
];

export class WorkspaceDb {
  readonly db: DatabaseSync;
  readonly serverId: string;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.applyMigrations();
    this.serverId = this.ensureServer();
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
  upsertActor(kind: ParticipantKind, displayName: string): Actor {
    const existing = this.findActorByName(kind, displayName);
    if (existing) return existing;
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

  /** Case-insensitive display-name lookup, matching upsertActor's dedupe rule. */
  findActorByName(kind: ParticipantKind, displayName: string): Actor | null {
    const row = this.db
      .prepare(
        `SELECT * FROM actors WHERE server_id = ? AND kind = ? AND lower(display_name) = lower(?)`,
      )
      .get(this.serverId, kind, displayName) as ActorRow | undefined;
    return row ? toActor(row) : null;
  }

  findActorByGoogleSub(googleSub: string): Actor | null {
    const row = this.db
      .prepare(`SELECT * FROM actors WHERE server_id = ? AND google_sub = ?`)
      .get(this.serverId, googleSub) as ActorRow | undefined;
    return row ? toActor(row) : null;
  }

  /**
   * Create the persistent human for a completed Google signup. Caller must
   * have checked name availability; the google_sub unique index is the last
   * line of defense against two actors for one Google account.
   */
  createGoogleHuman(displayName: string, googleSub: string, email: string | null): Actor {
    const actor: Actor = {
      id: randomUUID(),
      kind: "human",
      displayName,
      serverId: this.serverId,
    };
    this.db
      .prepare(
        `INSERT INTO actors (id, kind, display_name, server_id, google_sub, email)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(actor.id, actor.kind, actor.displayName, actor.serverId, googleSub, email);
    return actor;
  }

  findActorByEmail(email: string): Actor | null {
    const row = this.db
      .prepare(`SELECT * FROM actors WHERE server_id = ? AND lower(email) = lower(?)`)
      .get(this.serverId, email) as ActorRow | undefined;
    return row ? toActor(row) : null;
  }

  getPasswordHash(actorId: string): string | null {
    const row = this.db
      .prepare(`SELECT password_hash FROM actors WHERE id = ?`)
      .get(actorId) as { password_hash: string | null } | undefined;
    return row?.password_hash ?? null;
  }

  /** Create the persistent human for a completed email/password signup. */
  createEmailHuman(displayName: string, email: string, passwordHash: string): Actor {
    const actor: Actor = {
      id: randomUUID(),
      kind: "human",
      displayName,
      serverId: this.serverId,
    };
    this.db
      .prepare(
        `INSERT INTO actors (id, kind, display_name, server_id, email, password_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(actor.id, actor.kind, actor.displayName, actor.serverId, email, passwordHash);
    return actor;
  }

  getActor(id: string): Actor | null {
    const row = this.db.prepare(`SELECT * FROM actors WHERE id = ?`).get(id) as
      | ActorRow
      | undefined;
    return row ? toActor(row) : null;
  }

  listActors(kind?: ParticipantKind): Actor[] {
    const rows = (
      kind
        ? this.db.prepare(`SELECT * FROM actors WHERE server_id = ? AND kind = ?`).all(this.serverId, kind)
        : this.db.prepare(`SELECT * FROM actors WHERE server_id = ?`).all(this.serverId)
    ) as unknown as ActorRow[];
    return rows.map(toActor);
  }

  private applyMigrations(): void {
    for (const migration of MIGRATIONS) {
      try {
        this.db.exec(migration);
      } catch (err) {
        // "duplicate column" means the schema is already current; anything
        // else is a real failure and must abort startup.
        if (!(err instanceof Error) || !err.message.includes("duplicate column")) throw err;
      }
    }
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

  close(): void {
    this.db.close();
  }
}

interface ActorRow {
  id: string;
  kind: ParticipantKind;
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
