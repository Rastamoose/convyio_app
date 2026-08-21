import { randomUUID } from "node:crypto";
import type { Actor, ContextNote, ContextNoteScope, ThreadEvent } from "@workspace/shared";
import { ApiError } from "../board/BoardService";
import type { ThreadEventStore } from "../chat/ThreadEventStore";
import type { WorkspaceDb } from "../db";

export class ContextNotes {
  onEvent: ((event: ThreadEvent) => void) | null = null;

  constructor(
    private store: WorkspaceDb,
    private events: ThreadEventStore,
  ) {}

  async create(actor: Actor, input: { scope: ContextNoteScope; agentId?: string | null; body: string }): Promise<ContextNote> {
    const body = input.body.trim();
    if (!body) throw new ApiError(400, "BODY_REQUIRED", "note body is required");
    if (body.length > 4000) throw new ApiError(400, "BODY_TOO_LONG", "note exceeds 4000 characters");
    const agentId = input.scope === "agent" ? input.agentId ?? actor.id : null;
    if (input.scope === "workspace" && actor.kind !== "human") {
      throw new ApiError(403, "HUMAN_ONLY", "only humans can publish workspace guidance");
    }
    if (input.scope === "agent") {
      if (actor.kind !== "agent" || agentId !== actor.id) {
        throw new ApiError(403, "AGENT_NOTE_FORBIDDEN", "agents may write only their own notebook");
      }
      const target = await this.store.getActor(agentId);
      if (!target || target.kind !== "agent") throw new ApiError(404, "NOT_FOUND", "no such agent");
    }
    const id = randomUUID();
    const now = Date.now();
    const result = await this.store.transaction(async (sql) => {
      const [row] = await sql<NoteRow[]>`
        INSERT INTO context_notes (
          id, workspace_id, scope, agent_id, body, created_by, created_at, superseded_by
        ) VALUES (
          ${id}, ${this.store.workspaceId}, ${input.scope}, ${agentId}, ${body}, ${actor.id}, ${now}, NULL
        )
        RETURNING *
      `;
      const event = await this.events.append(sql, {
        workspaceId: this.store.workspaceId,
        actorId: actor.id,
        kind: "note.created",
        subjectId: id,
        payload: { noteId: id, scope: input.scope, agentId },
        createdAt: now,
      });
      return { note: toNote(row, actor.displayName), event };
    });
    this.onEvent?.(result.event);
    return result.note;
  }

  async listFor(actor: Actor): Promise<ContextNote[]> {
    return actor.kind === "agent" ? this.listForAgent(actor.id) : this.listAll();
  }

  async listForAgent(agentId: string): Promise<ContextNote[]> {
    const rows = await this.store.sql<NamedNoteRow[]>`
      SELECT n.*, author.display_name AS created_by_name
      FROM context_notes n
      JOIN actors author ON author.id = n.created_by
      WHERE n.workspace_id = ${this.store.workspaceId}
        AND n.superseded_by IS NULL
        AND (n.scope = 'workspace' OR (n.scope = 'agent' AND n.agent_id = ${agentId}))
      ORDER BY n.created_at ASC
    `;
    return rows.map((row) => toNote(row, row.created_by_name));
  }

  async listAll(): Promise<ContextNote[]> {
    const rows = await this.store.sql<NamedNoteRow[]>`
      SELECT n.*, author.display_name AS created_by_name
      FROM context_notes n
      JOIN actors author ON author.id = n.created_by
      WHERE n.workspace_id = ${this.store.workspaceId} AND n.superseded_by IS NULL
      ORDER BY n.created_at ASC
    `;
    return rows.map((row) => toNote(row, row.created_by_name));
  }
}

interface NoteRow {
  id: string;
  workspace_id: string;
  scope: ContextNoteScope;
  agent_id: string | null;
  body: string;
  created_by: string;
  created_at: number;
  superseded_by: string | null;
}

interface NamedNoteRow extends NoteRow {
  created_by_name: string;
}

function toNote(row: NoteRow, createdByName?: string): ContextNote {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    scope: row.scope,
    agentId: row.agent_id,
    body: row.body,
    createdBy: row.created_by,
    ...(createdByName ? { createdByName } : {}),
    createdAt: row.created_at,
    supersededBy: row.superseded_by,
  };
}
