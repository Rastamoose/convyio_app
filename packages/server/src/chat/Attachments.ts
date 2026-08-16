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
    const storageKey = `${this.store.workspaceId}/${id}`;
    const { error } = await this.supabase.storage.from(BUCKET).upload(storageKey, bytes, {
      contentType: meta.mime,
    });
    if (error) throw new ApiError(500, "UPLOAD_FAILED", `could not store the file: ${error.message}`);
    await this.store.sql`
      INSERT INTO attachments
        (id, workspace_id, storage_key, uploader_id, message_id, name, mime, size, width, height, created_at)
      VALUES (
        ${id}, ${this.store.workspaceId}, ${storageKey}, ${uploader.id}, NULL,
        ${name}, ${meta.mime}, ${bytes.length}, ${width}, ${height}, ${Date.now()}
      )
    `;
    return toAttachment(
      { id, name, mime: meta.mime, size: bytes.length, width, height },
      this.store.workspaceId,
    );
  }

  async get(id: string): Promise<{ attachment: Attachment; blob: Blob } | null> {
    const rows = await this.store.sql<AttachmentRow[]>`
      SELECT * FROM attachments
      WHERE workspace_id = ${this.store.workspaceId} AND id = ${id}
    `;
    const row = rows[0];
    if (!row) return null;
    const { data, error } = await this.supabase.storage.from(BUCKET).download(row.storage_key);
    if (error || !data) return null;
    return { attachment: toAttachment(row, this.store.workspaceId), blob: data };
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
          const rows = await sql<AttachmentRow[]>`
            SELECT * FROM attachments
            WHERE workspace_id = ${this.store.workspaceId} AND id = ${id}
          `;
          const row = rows[0];
          if (!row || row.message_id !== null || row.uploader_id !== senderId) {
            throw new ApiError(400, "BAD_ATTACHMENT", `attachment ${id} is not an unbound upload of yours`);
          }
          await sql`
            UPDATE attachments SET message_id = ${messageId}
            WHERE workspace_id = ${this.store.workspaceId} AND id = ${id}
          `;
          return toAttachment(row, this.store.workspaceId);
        }),
      ),
    );
  }

  /** Delete rows and objects for unbound uploads older than the cutoff. */
  async sweepOrphans(olderThanMs = ORPHAN_TTL_MS): Promise<void> {
    const rows = await this.store.sql<{ storage_key: string }[]>`
      DELETE FROM attachments
      WHERE workspace_id = ${this.store.workspaceId}
        AND message_id IS NULL AND created_at < ${Date.now() - olderThanMs}
      RETURNING storage_key
    `;
    if (rows.length === 0) return;
    await this.supabase.storage.from(BUCKET).remove(rows.map((row) => row.storage_key));
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
  workspace_id: string;
  storage_key: string;
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
  workspaceId: string,
): Attachment {
  const attachment: Attachment = {
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    url: `/api/uploads/${workspaceId}/${row.id}/${encodeURIComponent(row.name)}`,
  };
  if (row.width !== null) attachment.width = row.width;
  if (row.height !== null) attachment.height = row.height;
  return attachment;
}
