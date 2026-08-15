import { randomUUID } from "node:crypto";
import type {
  ThreadEvent,
  ThreadEventKind,
  ThreadEventPayload,
} from "@workspace/shared";
import type { Sql, WorkspaceDb } from "../db";

export const DEFAULT_THREAD_EVENT_LIMIT = 50;
export const MAX_THREAD_EVENT_LIMIT = 100;

export interface AppendThreadEvent {
  id?: string;
  workspaceId: string;
  channelId?: string | null;
  actorId: string;
  kind: ThreadEventKind;
  conversationId?: string | null;
  runId?: string | null;
  subjectId?: string | null;
  parentId?: string | null;
  clientEventId?: string | null;
  payload?: ThreadEventPayload;
  createdAt?: number;
}

export interface ListThreadEvents {
  workspaceId: string;
  channelId?: string | null;
  beforeSeq?: number;
  limit: number;
}

export interface AppendedThreadEvent {
  event: ThreadEvent;
  inserted: boolean;
}

/** Persists and pages the canonical append-only workspace event stream. */
export class ThreadEventStore {
  constructor(private store: WorkspaceDb) {}

  async append(sql: Sql, input: AppendThreadEvent): Promise<ThreadEvent> {
    return (await this.appendBatch(sql, [input]))[0].event;
  }

  async appendBatch(sql: Sql, inputs: readonly AppendThreadEvent[]): Promise<AppendedThreadEvent[]> {
    const appended: AppendedThreadEvent[] = [];
    for (const input of inputs) {
      const id = input.id ?? randomUUID();
      const rows = await sql<ThreadEventRow[]>`
        INSERT INTO thread_events (
          id, workspace_id, channel_id, actor_id, kind, conversation_id, run_id,
          subject_id, parent_id, client_event_id, payload, created_at
        ) VALUES (
          ${id}, ${input.workspaceId}, ${input.channelId ?? null}, ${input.actorId},
          ${input.kind}, ${input.conversationId ?? null}, ${input.runId ?? null},
          ${input.subjectId ?? null}, ${input.parentId ?? null},
          ${input.clientEventId ?? null}, ${sql.json(input.payload ?? {})},
          ${input.createdAt ?? Date.now()}
        )
        ON CONFLICT (actor_id, client_event_id) WHERE client_event_id IS NOT NULL
        DO NOTHING
        RETURNING *
      `;
      if (rows[0]) {
        appended.push({ event: toThreadEvent(rows[0]), inserted: true });
        continue;
      }

      const [existing] = await sql<ThreadEventRow[]>`
        SELECT * FROM thread_events
        WHERE actor_id = ${input.actorId} AND client_event_id = ${input.clientEventId ?? null}
      `;
      if (!existing) throw new Error("thread event insert conflicted without an idempotency match");
      appended.push({ event: toThreadEvent(existing), inserted: false });
    }
    return appended;
  }

  async findByClientEvent(sql: Sql, actorId: string, clientEventId: string): Promise<ThreadEvent | null> {
    const [row] = await sql<ThreadEventRow[]>`
      SELECT * FROM thread_events
      WHERE actor_id = ${actorId} AND client_event_id = ${clientEventId}
    `;
    return row ? toThreadEvent(row) : null;
  }

  async latestSeq(workspaceId: string): Promise<number> {
    const [row] = await this.store.sql<{ seq: number | null }[]>`
      SELECT max(seq) AS seq FROM thread_events WHERE workspace_id = ${workspaceId}
    `;
    return row?.seq ?? 0;
  }

  async listAfter(workspaceId: string, afterSeq: number, limit = MAX_THREAD_EVENT_LIMIT): Promise<ThreadEvent[]> {
    const rows = await this.store.sql<ThreadEventRow[]>`
      SELECT * FROM thread_events
      WHERE workspace_id = ${workspaceId} AND seq > ${afterSeq}
      ORDER BY seq ASC
      LIMIT ${limit}
    `;
    return rows.map(toThreadEvent);
  }

  async list(options: ListThreadEvents): Promise<ThreadEvent[]> {
    const sql = this.store.sql;
    const before = options.beforeSeq === undefined
      ? sql``
      : sql`AND seq < ${options.beforeSeq}`;
    const channel = options.channelId === undefined
      ? sql``
      : options.channelId === null
        ? sql`AND channel_id IS NULL`
        : sql`AND channel_id = ${options.channelId}`;
    const rows = await sql<ThreadEventRow[]>`
      SELECT * FROM thread_events
      WHERE workspace_id = ${options.workspaceId} ${channel} ${before}
      ORDER BY seq DESC
      LIMIT ${options.limit}
    `;
    return rows.reverse().map(toThreadEvent);
  }
}

interface ThreadEventRow {
  id: string;
  seq: number;
  workspace_id: string;
  channel_id: string | null;
  actor_id: string;
  kind: ThreadEventKind;
  conversation_id: string | null;
  run_id: string | null;
  subject_id: string | null;
  parent_id: string | null;
  client_event_id: string | null;
  payload: ThreadEventPayload;
  created_at: number;
}

function toThreadEvent(row: ThreadEventRow): ThreadEvent {
  return {
    id: row.id,
    seq: row.seq,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    actorId: row.actor_id,
    kind: row.kind,
    conversationId: row.conversation_id,
    runId: row.run_id,
    subjectId: row.subject_id,
    parentId: row.parent_id,
    clientEventId: row.client_event_id,
    payload: row.payload,
    createdAt: row.created_at,
  };
}
