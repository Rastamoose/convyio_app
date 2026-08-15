import { randomUUID } from "node:crypto";
import type {
  ContextCursor,
  ContextEntry,
  ContextKind,
  ContextScope,
} from "@workspace/shared";
import type { Sql, WorkspaceDb } from "../db";
import type { ThreadEventStore } from "../chat/ThreadEventStore";

/**
 * Durable shared-context records. One entry is one attributed fact, decision,
 * constraint, blocker, handoff or summary. Entries never grant authority and
 * are superseded rather than rewritten.
 */
export class ContextStore {
  constructor(
    private store: WorkspaceDb,
    private events: ThreadEventStore,
  ) {}

  async create(input: {
    actorId: string;
    kind: ContextKind;
    scope: ContextScope;
    subjectId?: string | null;
    body: string;
  }): Promise<ContextEntry> {
    const body = input.body.trim();
    if (!body) throw new Error("context entry body is required");
    if (input.scope === "workspace" && input.subjectId) {
      throw new Error("workspace-scoped context cannot name a subject");
    }
    if (input.scope !== "workspace" && !input.subjectId) {
      throw new Error(`${input.scope}-scoped context requires a subject`);
    }
    const id = randomUUID();
    const createdAt = Date.now();
    return this.store.transaction(async (sql) => {
      const [row] = await sql<Row[]>`
        INSERT INTO context_entries
          (id, workspace_id, kind, scope, subject_id, body, created_by, superseded_by, created_at)
        VALUES (
          ${id}, ${this.store.workspaceId}, ${input.kind}, ${input.scope},
          ${input.subjectId ?? null}, ${body}, ${input.actorId}, NULL, ${createdAt}
        )
        RETURNING *
      `;
      await this.events.append(sql, {
        workspaceId: this.store.workspaceId,
        actorId: input.actorId,
        kind: "context.created",
        subjectId: id,
        payload: {
          entryId: id,
          kind: input.kind,
          scope: input.scope,
          subjectId: input.subjectId ?? null,
        },
        createdAt,
      });
      return toEntry(row);
    });
  }

  async supersede(actorId: string, id: string, replacement: {
    kind?: ContextKind;
    body: string;
  }): Promise<ContextEntry> {
    const current = await this.find(id);
    if (!current) throw new Error(`no context entry ${id}`);
    if (current.supersededBy) throw new Error(`${id} is already superseded`);
    const next = await this.create({
      actorId,
      kind: replacement.kind ?? current.kind,
      scope: current.scope,
      subjectId: current.subjectId,
      body: replacement.body,
    });
    await this.store.transaction(async (sql) => {
      const [updated] = await sql<Row[]>`
        UPDATE context_entries
        SET superseded_by = ${next.id}
        WHERE id = ${id} AND superseded_by IS NULL
        RETURNING *
      `;
      if (!updated) throw new Error(`${id} is already superseded`);
      await this.events.append(sql, {
        workspaceId: this.store.workspaceId,
        actorId,
        kind: "context.superseded",
        subjectId: id,
        payload: { entryId: id, supersededBy: next.id },
      });
    });
    return next;
  }

  async find(id: string): Promise<ContextEntry | null> {
    const [row] = await this.store.sql<NamedRow[]>`
      ${selectEntry(this.store.sql)}
      WHERE e.id = ${id} AND e.workspace_id = ${this.store.workspaceId}
    `;
    return row ? toNamedEntry(row) : null;
  }

  async listActive(): Promise<ContextEntry[]> {
    const rows = await this.store.sql<NamedRow[]>`
      ${selectEntry(this.store.sql)}
      WHERE e.workspace_id = ${this.store.workspaceId} AND e.superseded_by IS NULL
      ORDER BY e.created_at DESC
    `;
    return rows.map(toNamedEntry);
  }
}

function selectEntry(sql: Sql) {
  return sql`
    SELECT e.*, a.display_name AS created_by_name
    FROM context_entries e
    JOIN actors a ON a.id = e.created_by
  `;
}

interface Row {
  id: string;
  workspace_id: string;
  kind: ContextKind;
  scope: ContextScope;
  subject_id: string | null;
  body: string;
  created_by: string;
  superseded_by: string | null;
  created_at: number;
}

interface NamedRow extends Row {
  created_by_name: string;
}

function toEntry(row: Row): ContextEntry {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    scope: row.scope,
    subjectId: row.subject_id,
    body: row.body,
    createdBy: row.created_by,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
  };
}

function toNamedEntry(row: NamedRow): ContextEntry {
  return { ...toEntry(row), createdByName: row.created_by_name };
}
