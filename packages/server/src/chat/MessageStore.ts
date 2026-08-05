import fs from "node:fs";
import path from "node:path";
import type { ChatMessage, TraceChunk } from "@workspace/shared";
import type { WorkspaceDb } from "../db";

/** Chat history persistence. Exists so the hub never touches SQL. */
export class MessageStore {
  constructor(private store: WorkspaceDb) {}

  list(): ChatMessage[] {
    const rows = this.store.db
      .prepare(`SELECT * FROM messages ORDER BY created_at ASC, rowid ASC`)
      .all() as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  append(message: ChatMessage): void {
    this.store.db
      .prepare(
        `INSERT INTO messages
           (id, author_id, author_name, author_kind, content, channel, run_id, trace, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.authorId,
        message.authorName,
        message.authorKind,
        message.content,
        message.channel ?? "general",
        message.runId ?? null,
        message.trace ? JSON.stringify(message.trace) : null,
        message.timestamp,
      );
  }

  /** Delete all messages, or only those in the given channel. */
  clear(channel?: string): void {
    if (channel) {
      this.store.db.prepare(`DELETE FROM messages WHERE channel = ?`).run(channel);
    } else {
      this.store.db.prepare(`DELETE FROM messages`).run();
    }
  }

  /**
   * One-time import of the pre-SQLite JSON history file. The source file is
   * renamed afterwards so the import can never run twice.
   */
  importLegacyJson(dataDir: string): void {
    const file = path.join(dataDir, "messages.json");
    if (!fs.existsSync(file)) return;
    const messages = JSON.parse(fs.readFileSync(file, "utf-8")) as ChatMessage[];
    this.store.transaction(() => {
      for (const message of messages) this.append(message);
    });
    fs.renameSync(file, `${file}.imported`);
    console.log(`[chat] imported ${messages.length} messages from legacy ${file}`);
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
  created_at: number;
}

function toMessage(row: MessageRow): ChatMessage {
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
  return message;
}
