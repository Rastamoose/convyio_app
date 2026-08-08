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
  /** Fan-out hooks; the composition root wires them to hub broadcasts. */
  onCreated: ((name: string) => void) | null = null;
  onRenamed: ((oldName: string, newName: string) => void) | null = null;
  onArchived: ((name: string, archived: boolean) => void) | null = null;
  onPinned: ((name: string, pinned: boolean) => void) | null = null;
  onDeleted: ((name: string) => void) | null = null;

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

  /** Active (unarchived) channel names: pinned first (by pin order), then
   *  general, then creation order. */
  list(): string[] {
    const rows = this.store.db
      .prepare(
        `SELECT name FROM channels WHERE archived_at IS NULL
         ORDER BY pinned_at IS NULL ASC, pinned_at ASC,
                  name = 'general' DESC, created_at ASC, rowid ASC`,
      )
      .all() as unknown as { name: string }[];
    return rows.map((row) => row.name);
  }

  /** Archived channel names, most recently archived first. */
  listArchived(): string[] {
    const rows = this.store.db
      .prepare(
        `SELECT name FROM channels WHERE archived_at IS NOT NULL
         ORDER BY archived_at DESC`,
      )
      .all() as unknown as { name: string }[];
    return rows.map((row) => row.name);
  }

  /** Pinned (and active) channel names, in pin order. */
  pinned(): string[] {
    const rows = this.store.db
      .prepare(
        `SELECT name FROM channels WHERE pinned_at IS NOT NULL AND archived_at IS NULL
         ORDER BY pinned_at ASC`,
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
    this.requireHuman(actor);
    const name = this.normalize(rawName);
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

  /** Rename a channel; messages keep pointing at it under the new name.
   *  "general" is the default channel messages fall back to and stays fixed. */
  rename(actor: Actor, name: string, rawNewName: string): string {
    this.requireHuman(actor);
    this.requireMutable(name);
    const newName = this.normalize(rawNewName);
    if (newName !== name && this.exists(newName)) {
      throw new ApiError(409, "CHANNEL_EXISTS", `channel ${newName} already exists`);
    }
    this.store.transaction(() => {
      this.store.db.prepare(`UPDATE channels SET name = ? WHERE name = ?`).run(newName, name);
      this.store.db
        .prepare(`UPDATE messages SET channel = ? WHERE channel = ?`)
        .run(newName, name);
    });
    this.onRenamed?.(name, newName);
    return newName;
  }

  setArchived(actor: Actor, name: string, archived: boolean): void {
    this.requireHuman(actor);
    this.requireMutable(name);
    this.store.db
      .prepare(`UPDATE channels SET archived_at = ? WHERE name = ?`)
      .run(archived ? Date.now() : null, name);
    this.onArchived?.(name, archived);
  }

  setPinned(actor: Actor, name: string, pinned: boolean): void {
    this.requireHuman(actor);
    if (!this.exists(name)) {
      throw new ApiError(404, "NOT_FOUND", `no such channel: ${name}`);
    }
    this.store.db
      .prepare(`UPDATE channels SET pinned_at = ? WHERE name = ?`)
      .run(pinned ? Date.now() : null, name);
    this.onPinned?.(name, pinned);
  }

  /** Drop the channel and its messages; "general" cannot be removed. */
  remove(actor: Actor, name: string): void {
    this.requireHuman(actor);
    this.requireMutable(name);
    this.store.db.prepare(`DELETE FROM channels WHERE name = ?`).run(name);
    this.onDeleted?.(name);
  }

  private requireHuman(actor: Actor): void {
    if (actor.kind !== "human") {
      throw new ApiError(403, "FORBIDDEN", "only humans can manage channels");
    }
  }

  /** Exists and isn't the fixed default channel every message falls back to. */
  private requireMutable(name: string): void {
    if (!this.exists(name)) {
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
