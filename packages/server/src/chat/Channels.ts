import { randomUUID } from "node:crypto";
import type { Actor } from "@workspace/shared";
import { ApiError } from "../board/BoardService";
import type { WorkspaceDb } from "../db";

const NAME_PATTERN = /^[a-z0-9-]{1,32}$/;
const MAX_CHANNELS = 100;

/**
 * Owns the set of chat channels: seeds defaults, validates names, records
 * new ones. Names are unique case-insensitively (COLLATE NOCASE on the
 * column), so `exists` and the duplicate check agree with the constraint.
 */
export class Channels {
  /** Fan-out hook; the composition root wires it to the hub broadcast. */
  onCreated: ((name: string) => void) | null = null;

  constructor(private store: WorkspaceDb) {}

  /** Idempotent boot seeding; NULL created_by marks system channels. */
  seed(defaults: { name: string; isDemo: boolean }[]): void {
    const insert = this.store.db.prepare(
      `INSERT OR IGNORE INTO channels (id, name, created_by, is_demo, created_at)
       VALUES (?, ?, NULL, ?, ?)`,
    );
    for (const { name, isDemo } of defaults) {
      insert.run(randomUUID(), name, isDemo ? 1 : 0, Date.now());
    }
  }

  /** All channel names: general first, then creation order. */
  list(): string[] {
    const rows = this.store.db
      .prepare(
        `SELECT name FROM channels
         ORDER BY name = 'general' DESC, created_at ASC, rowid ASC`,
      )
      .all() as unknown as { name: string }[];
    return rows.map((row) => row.name);
  }

  exists(name: string): boolean {
    return (
      this.store.db.prepare(`SELECT 1 FROM channels WHERE name = ?`).get(name) !==
      undefined
    );
  }

  /** Normalize and validate a requested name, record it, and fan out. */
  create(actor: Actor, rawName: string): string {
    if (actor.kind !== "human") {
      throw new ApiError(403, "FORBIDDEN", "only humans can create channels");
    }
    const name = rawName.trim().toLowerCase().replace(/\s+/g, "-");
    if (!NAME_PATTERN.test(name)) {
      throw new ApiError(
        400,
        "BAD_CHANNEL_NAME",
        "channel names are 1-32 characters of a-z, 0-9, and -",
      );
    }
    if (this.exists(name)) {
      throw new ApiError(409, "CHANNEL_EXISTS", `channel ${name} already exists`);
    }
    const { c } = this.store.db
      .prepare(`SELECT count(*) AS c FROM channels`)
      .get() as { c: number };
    if (c >= MAX_CHANNELS) {
      throw new ApiError(409, "CHANNEL_LIMIT", `channel cap of ${MAX_CHANNELS} reached`);
    }
    this.store.db
      .prepare(
        `INSERT INTO channels (id, name, created_by, is_demo, created_at)
         VALUES (?, ?, ?, 0, ?)`,
      )
      .run(randomUUID(), name, actor.id, Date.now());
    this.onCreated?.(name);
    return name;
  }
}
