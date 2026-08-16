import { randomUUID } from "node:crypto";
import type { Actor, ChannelInfo } from "@workspace/shared";
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
  onCreated: ((channel: ChannelInfo) => void) | null = null;
  onRenamed: ((oldName: string, newName: string) => void) | null = null;
  onArchived: ((name: string, archived: boolean) => void) | null = null;
  onPinned: ((name: string, pinned: boolean) => void) | null = null;
  onDeleted: ((name: string) => void) | null = null;

  constructor(private store: WorkspaceDb) {}

  /** Idempotent boot seeding; NULL created_by marks system channels. */
  async seed(defaults: { name: string; isDemo: boolean }[]): Promise<void> {
    for (const { name, isDemo } of defaults) {
      await this.store.sql`
        INSERT INTO channels (id, workspace_id, name, created_by, is_demo, created_at)
        VALUES (${randomUUID()}, ${this.store.workspaceId}, ${name}, NULL, ${isDemo}, ${Date.now()})
        ON CONFLICT (workspace_id, lower(name)) DO NOTHING
      `;
    }
  }

  /** Active (unarchived) channel names: pinned first (by pin order), then
   *  general, then creation order. */
  async list(): Promise<string[]> {
    return (await this.listInfo()).map((channel) => channel.name);
  }

  /** Active channels with stable ids, in the same display order as list(). */
  async listInfo(): Promise<ChannelInfo[]> {
    return this.store.sql<ChannelInfo[]>`
      SELECT id, name FROM channels
      WHERE workspace_id = ${this.store.workspaceId} AND archived_at IS NULL
      ORDER BY pinned_at IS NULL ASC, pinned_at ASC,
               name = 'general' DESC, created_at ASC, seq ASC
    `;
  }

  /** Archived channel names, most recently archived first. */
  async listArchived(): Promise<string[]> {
    const rows = await this.store.sql<{ name: string }[]>`
      SELECT name FROM channels
      WHERE workspace_id = ${this.store.workspaceId} AND archived_at IS NOT NULL
      ORDER BY archived_at DESC
    `;
    return rows.map((row) => row.name);
  }

  /** Pinned (and active) channel names, in pin order. */
  async pinned(): Promise<string[]> {
    const rows = await this.store.sql<{ name: string }[]>`
      SELECT name FROM channels
      WHERE workspace_id = ${this.store.workspaceId} AND pinned_at IS NOT NULL AND archived_at IS NULL
      ORDER BY pinned_at ASC
    `;
    return rows.map((row) => row.name);
  }

  async get(name: string): Promise<ChannelInfo | null> {
    const [channel] = await this.store.sql<ChannelInfo[]>`
      SELECT id, name FROM channels
      WHERE workspace_id = ${this.store.workspaceId} AND name = ${name}
    `;
    return channel ?? null;
  }

  async exists(name: string): Promise<boolean> {
    return (await this.get(name)) !== null;
  }

  /** Normalize and validate a requested name, record it, and fan out. */
  async create(actor: Actor, rawName: string): Promise<ChannelInfo> {
    this.requireHuman(actor);
    const name = this.normalize(rawName);
    if (await this.exists(name)) {
      throw new ApiError(409, "CHANNEL_EXISTS", `channel ${name} already exists`);
    }
    const [{ c }] = await this.store.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM channels WHERE workspace_id = ${this.store.workspaceId}
    `;
    if (c >= MAX_CHANNELS) {
      throw new ApiError(409, "CHANNEL_LIMIT", `channel cap of ${MAX_CHANNELS} reached`);
    }
    const channel = { id: randomUUID(), name };
    await this.store.sql`
      INSERT INTO channels (id, workspace_id, name, created_by, is_demo, created_at)
      VALUES (${channel.id}, ${this.store.workspaceId}, ${channel.name}, ${actor.id}, false, ${Date.now()})
    `;
    this.onCreated?.(channel);
    return channel;
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
      await sql`
        UPDATE channels SET name = ${newName}
        WHERE workspace_id = ${this.store.workspaceId} AND name = ${name}
      `;
      await sql`
        UPDATE messages SET channel = ${newName}
        WHERE workspace_id = ${this.store.workspaceId} AND channel = ${name}
      `;
    });
    this.onRenamed?.(name, newName);
    return newName;
  }

  async setArchived(actor: Actor, name: string, archived: boolean): Promise<void> {
    this.requireHuman(actor);
    await this.requireMutable(name);
    await this.store.sql`
      UPDATE channels SET archived_at = ${archived ? Date.now() : null}
      WHERE workspace_id = ${this.store.workspaceId} AND name = ${name}
    `;
    this.onArchived?.(name, archived);
  }

  async setPinned(actor: Actor, name: string, pinned: boolean): Promise<void> {
    this.requireHuman(actor);
    if (!(await this.exists(name))) {
      throw new ApiError(404, "NOT_FOUND", `no such channel: ${name}`);
    }
    await this.store.sql`
      UPDATE channels SET pinned_at = ${pinned ? Date.now() : null}
      WHERE workspace_id = ${this.store.workspaceId} AND name = ${name}
    `;
    this.onPinned?.(name, pinned);
  }

  /** Drop the channel and its messages; "general" cannot be removed. */
  async remove(actor: Actor, name: string): Promise<void> {
    this.requireHuman(actor);
    await this.requireMutable(name);
    await this.store.sql`
      DELETE FROM channels WHERE workspace_id = ${this.store.workspaceId} AND name = ${name}
    `;
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
