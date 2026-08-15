import { randomUUID } from "node:crypto";
import type { ContextCursor } from "@workspace/shared";
import type { WorkspaceDb } from "../db";
import type { ThreadEventStore } from "../chat/ThreadEventStore";

/**
 * Per-actor acknowledged workspace-event cursor. The cursor advances only
 * after the runner or client acknowledges a specific envelope, so a failed
 * run can replay the same unseen range.
 */
export class ContextCursorStore {
  constructor(
    private store: WorkspaceDb,
    private events: ThreadEventStore,
  ) {}

  async get(actorId: string): Promise<ContextCursor | null> {
    const [row] = await this.store.sql<Row[]>`
      SELECT * FROM context_cursors
      WHERE workspace_id = ${this.store.workspaceId} AND actor_id = ${actorId}
    `;
    return row ? toCursor(row) : null;
  }

  async acknowledge(actorId: string, seq: number, envelopeId?: string): Promise<ContextCursor> {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new Error("acknowledged sequence must be a non-negative integer");
    }
    const now = Date.now();
    const id = envelopeId ?? randomUUID();
    return this.store.transaction(async (sql) => {
      const [existing] = await sql<Row[]>`
        SELECT * FROM context_cursors
        WHERE workspace_id = ${this.store.workspaceId} AND actor_id = ${actorId}
        FOR UPDATE
      `;
      if (existing && existing.acknowledged_seq > seq) {
        return toCursor(existing);
      }
      const [row] = await sql<Row[]>`
        INSERT INTO context_cursors
          (workspace_id, actor_id, acknowledged_seq, acknowledged_at, last_envelope_id)
        VALUES (${this.store.workspaceId}, ${actorId}, ${seq}, ${now}, ${id})
        ON CONFLICT (workspace_id, actor_id) DO UPDATE SET
          acknowledged_seq = GREATEST(context_cursors.acknowledged_seq, EXCLUDED.acknowledged_seq),
          acknowledged_at = EXCLUDED.acknowledged_at,
          last_envelope_id = EXCLUDED.last_envelope_id
        RETURNING *
      `;
      if (!existing || existing.acknowledged_seq < seq) {
        await this.events.append(sql, {
          workspaceId: this.store.workspaceId,
          actorId,
          kind: "context.cursor.acknowledged",
          subjectId: actorId,
          payload: { seq, envelopeId: id },
          createdAt: now,
        });
      }
      return toCursor(row);
    });
  }
}

interface Row {
  workspace_id: string;
  actor_id: string;
  acknowledged_seq: number;
  acknowledged_at: number;
  last_envelope_id: string | null;
}

function toCursor(row: Row): ContextCursor {
  return {
    workspaceId: row.workspace_id,
    actorId: row.actor_id,
    acknowledgedSeq: row.acknowledged_seq,
    acknowledgedAt: row.acknowledged_at,
    lastEnvelopeId: row.last_envelope_id,
  };
}
