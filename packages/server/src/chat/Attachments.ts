import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Actor, Attachment } from "@workspace/shared";
import { ApiError } from "../board/BoardService";
import type { WorkspaceDb } from "../db";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Unbound uploads older than this are dead: the send they belonged to never happened. */
const ORPHAN_TTL_MS = 60 * 60 * 1000;

/**
 * Owns uploaded files: stores bytes on disk, records metadata, binds them to
 * messages, serves them back. Bytes live at <uploadsDir>/<id> with no
 * extension — the mime type lives in the attachments table, and the id is the
 * capability that grants access to the file.
 */
export class Attachments {
  constructor(
    private store: WorkspaceDb,
    private uploadsDir: string,
  ) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  save(
    uploader: Actor,
    meta: { name: string; mime: string; width?: number; height?: number },
    bytes: Buffer,
  ): Attachment {
    // Lazy orphan sweep on the write path keeps the store bounded without timers.
    this.sweepOrphans();
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
    fs.writeFileSync(path.join(this.uploadsDir, id), bytes);
    this.store.db
      .prepare(
        `INSERT INTO attachments
           (id, uploader_id, message_id, name, mime, size, width, height, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, uploader.id, name, meta.mime, bytes.length, width, height, Date.now());
    return toAttachment({ id, name, mime: meta.mime, size: bytes.length, width, height });
  }

  get(id: string): { attachment: Attachment; filePath: string } | null {
    const row = this.store.db
      .prepare(`SELECT * FROM attachments WHERE id = ?`)
      .get(id) as AttachmentRow | undefined;
    if (!row) return null;
    return { attachment: toAttachment(row), filePath: path.join(this.uploadsDir, row.id) };
  }

  /**
   * Attach uploads to a message being sent. Every id must be an unbound
   * upload belonging to the sender, or the whole bind rolls back. Returns
   * the attachments in the given order.
   */
  bind(messageId: string, ids: string[], senderId: string): Attachment[] {
    return this.store.transaction(() =>
      ids.map((id) => {
        const row = this.store.db
          .prepare(`SELECT * FROM attachments WHERE id = ?`)
          .get(id) as AttachmentRow | undefined;
        if (!row || row.message_id !== null || row.uploader_id !== senderId) {
          throw new ApiError(400, "BAD_ATTACHMENT", `attachment ${id} is not an unbound upload of yours`);
        }
        this.store.db
          .prepare(`UPDATE attachments SET message_id = ? WHERE id = ?`)
          .run(messageId, id);
        return toAttachment(row);
      }),
    );
  }

  /** Delete rows and files for unbound uploads older than the cutoff. */
  sweepOrphans(olderThanMs = ORPHAN_TTL_MS): void {
    const rows = this.store.db
      .prepare(`DELETE FROM attachments WHERE message_id IS NULL AND created_at < ? RETURNING id`)
      .all(Date.now() - olderThanMs) as unknown as { id: string }[];
    for (const { id } of rows) fs.rmSync(path.join(this.uploadsDir, id), { force: true });
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
): Attachment {
  const attachment: Attachment = {
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    url: `/api/uploads/${row.id}/${encodeURIComponent(row.name)}`,
  };
  if (row.width !== null) attachment.width = row.width;
  if (row.height !== null) attachment.height = row.height;
  return attachment;
}
