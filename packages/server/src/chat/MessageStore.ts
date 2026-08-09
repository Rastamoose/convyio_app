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
