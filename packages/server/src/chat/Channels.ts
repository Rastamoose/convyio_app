import { randomUUID } from "node:crypto";
import type { Actor, ChannelInfo, ChannelSection } from "@workspace/shared";
import { ApiError } from "../board/BoardService";
import type { WorkspaceDb } from "../db";

const NAME_PATTERN = /^[a-z0-9-]{1,32}$/;
const SECTION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_CHANNELS = 100;
const MAX_SECTIONS = 40;

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
  onSectionCreated: ((section: ChannelSection) => void) | null = null;
  onMoved: ((name: string, sectionId: string | null) => void) | null = null;

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
    const rows = await this.store.sql<{ id: string; name: string; section_id: string | null }[]>`
      SELECT id, name, section_id FROM channels
      WHERE workspace_id = ${this.store.workspaceId} AND archived_at IS NULL
      ORDER BY pinned_at IS NULL ASC, pinned_at ASC,
               name = 'general' DESC, created_at ASC, seq ASC
    `;
    return rows.map(toChannelInfo);
  }

  async listSections(): Promise<ChannelSection[]> {
    const rows = await this.store.sql<{ id: string; name: string }[]>`
      SELECT id, name FROM channel_sections
      WHERE workspace_id = ${this.store.workspaceId}
      ORDER BY created_at ASC, seq ASC
    `;
    return rows;
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
    const [channel] = await this.store.sql<{ id: string; name: string; section_id: string | null }[]>`
      SELECT id, name, section_id FROM channels
      WHERE workspace_id = ${this.store.workspaceId} AND name = ${name}
    `;
    return channel ? toChannelInfo(channel) : null;
  }

  async getById(id: string): Promise<ChannelInfo | null> {
    const [channel] = await this.store.sql<{ id: string; name: string; section_id: string | null }[]>`
      SELECT id, name, section_id FROM channels
      WHERE workspace_id = ${this.store.workspaceId} AND id = ${id}
    `;
    return channel ? toChannelInfo(channel) : null;
  }

  async resolve(idOrName?: string | null): Promise<ChannelInfo | null> {
    if (idOrName) {
      const byId = await this.getById(idOrName);
      if (byId) return byId;
      const byName = await this.get(idOrName);
      if (byName) return byName;
    }
    return (await this.get("general")) ?? (await this.listInfo())[0] ?? null;
  }

  async exists(name: string): Promise<boolean> {
    return (await this.get(name)) !== null;
  }

  /** Normalize and validate a requested name, record it, and fan out. */
  async create(actor: Actor, rawName: string, sectionId: string | null = null): Promise<ChannelInfo> {
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
    if (sectionId !== null) {
      const [section] = await this.store.sql<{ id: string }[]>`
        SELECT id FROM channel_sections
        WHERE workspace_id = ${this.store.workspaceId} AND id = ${sectionId}
      `;
      if (!section) throw new ApiError(404, "NOT_FOUND", `no such section: ${sectionId}`);
    }
    const channel: ChannelInfo = { id: randomUUID(), name, sectionId };
    await this.store.sql`
      INSERT INTO channels (id, workspace_id, name, created_by, is_demo, created_at, section_id)
      VALUES (${channel.id}, ${this.store.workspaceId}, ${channel.name}, ${actor.id}, false, ${Date.now()}, ${sectionId})
    `;
    this.onCreated?.(channel);
    return channel;
  }

  async createSection(actor: Actor, rawName: string): Promise<ChannelSection> {
    this.requireHuman(actor);
    const name = this.normalizeSection(rawName);
    if (name === "rooms") {
      throw new ApiError(409, "SECTION_EXISTS", "rooms is the default section");
    }
    const [existing] = await this.store.sql<{ id: string }[]>`
      SELECT id FROM channel_sections
      WHERE workspace_id = ${this.store.workspaceId} AND lower(name) = ${name}
    `;
    if (existing) {
      throw new ApiError(409, "SECTION_EXISTS", `section ${name} already exists`);
    }
    const [{ c }] = await this.store.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM channel_sections WHERE workspace_id = ${this.store.workspaceId}
    `;
    if (c >= MAX_SECTIONS) {
      throw new ApiError(409, "SECTION_LIMIT", `section cap of ${MAX_SECTIONS} reached`);
    }
    const section = { id: randomUUID(), name };
    try {
      await this.store.sql`
        INSERT INTO channel_sections (id, workspace_id, name, created_by, created_at)
        VALUES (${section.id}, ${this.store.workspaceId}, ${section.name}, ${actor.id}, ${Date.now()})
      `;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ApiError(409, "SECTION_EXISTS", `section ${name} already exists`);
      }
      throw err;
    }
    this.onSectionCreated?.(section);
    return section;
  }

  /** Move an active channel into a custom section, or back to Rooms (`null`). */
  async move(actor: Actor, name: string, sectionId: string | null): Promise<void> {
    this.requireHuman(actor);
    if (!(await this.exists(name))) {
      throw new ApiError(404, "NOT_FOUND", `no such channel: ${name}`);
    }
    if (sectionId !== null) {
      const [section] = await this.store.sql<{ id: string }[]>`
        SELECT id FROM channel_sections
        WHERE workspace_id = ${this.store.workspaceId} AND id = ${sectionId}
      `;
      if (!section) throw new ApiError(404, "NOT_FOUND", `no such section: ${sectionId}`);
    }
    await this.store.sql`
      UPDATE channels SET section_id = ${sectionId}
      WHERE workspace_id = ${this.store.workspaceId} AND name = ${name}
    `;
    this.onMoved?.(name, sectionId);
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

  private normalizeSection(rawName: string): string {
    const name = rawName.trim().toLowerCase().replace(/\s+/g, "-");
    if (!SECTION_NAME_PATTERN.test(name)) {
      throw new ApiError(
        400,
        "BAD_SECTION_NAME",
        "section names are 1-32 characters of a-z, 0-9, and -, starting with a letter or digit",
      );
    }
    return name;
  }
}

function toChannelInfo(row: { id: string; name: string; section_id: string | null }): ChannelInfo {
  return { id: row.id, name: row.name, sectionId: row.section_id };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "23505";
}
