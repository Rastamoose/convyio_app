import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ProjectAction,
  ThreadEvent,
  ToolExecution,
  ToolExecutionStatus,
  ToolmanActionKind,
} from "@workspace/shared";
import { DEFAULT_ARTIFACT_RETENTION_DAYS } from "@workspace/shared";
import type { ThreadEventStore } from "../chat/ThreadEventStore";
import type { Sql, WorkspaceDb } from "../db";

const ARTIFACT_BUCKET = "tool-artifacts";

const PREVIEW = 4_000;

export interface ExecutionInput {
  agentId: string;
  projectId: string;
  mountId: string;
  nodeId: string;
  boardItemRef: string | null;
  action: ProjectAction;
  conversationId?: string | null;
  channelId?: string | null;
  runId?: string | null;
}

/**
 * Queryable projection of Toolman executions. The append-only chronology
 * remains in thread_events; this table is the current-state snapshot.
 */
export class ToolExecutionStore {
  constructor(
    private store: WorkspaceDb,
    private events: ThreadEventStore,
    private supabase: SupabaseClient | null = null,
  ) {}

  async start(input: ExecutionInput): Promise<{ execution: ToolExecution; event: ThreadEvent }> {
    const now = Date.now();
    const id = randomUUID();
    const summary = summarize(input.action);
    const inputPreview = preview(input.action);
    return this.store.transaction(async (sql) => {
      await sql`
        INSERT INTO tool_executions (
          id, workspace_id, channel_id, conversation_id, run_id, agent_id, project_id,
          mount_id, node_id, board_item_ref, action, status, summary, input_preview, started_at
        ) VALUES (
          ${id}, ${this.store.workspaceId}, ${input.channelId ?? null}, ${input.conversationId ?? null},
          ${input.runId ?? null}, ${input.agentId}, ${input.projectId}, ${input.mountId}, ${input.nodeId},
          ${input.boardItemRef}, ${input.action.kind}, 'running', ${summary}, ${inputPreview}, ${now}
        )
      `;
      const event = await this.events.append(sql, {
        workspaceId: this.store.workspaceId,
        channelId: input.channelId ?? null,
        actorId: input.agentId,
        kind: "tool.execution.started",
        conversationId: input.conversationId ?? null,
        runId: input.runId ?? null,
        subjectId: id,
        payload: {
          executionId: id,
          action: input.action.kind,
          projectId: input.projectId,
          summary,
          inputPreview,
          boardItemRef: input.boardItemRef,
        },
        createdAt: now,
      });
      return { execution: (await this.findIn(sql, id))!, event };
    });
  }

  async finish(
    id: string,
    outcome: { ok: boolean; output?: string; error?: string; cancelled?: boolean },
  ): Promise<{ execution: ToolExecution; event: ThreadEvent }> {
    const now = Date.now();
    const status: ToolExecutionStatus = outcome.cancelled ? "cancelled" : outcome.ok ? "completed" : "failed";
    const kind =
      status === "cancelled"
        ? "tool.execution.cancelled"
        : status === "completed"
          ? "tool.execution.completed"
          : "tool.execution.failed";
    const outputPreview = outcome.output ? preview(outcome.output) : null;
    const artifact = outcome.output ? await this.storeArtifact(id, "output", outcome.output) : null;
    await this.sweepExpired().catch(() => undefined);
    return this.store.transaction(async (sql) => {
      const [row] = await sql<{ agent_id: string; channel_id: string | null; conversation_id: string | null; run_id: string | null }[]>`
        UPDATE tool_executions
        SET status = ${status},
            output_preview = ${outputPreview},
            error = ${outcome.error ?? null},
            output_object_key = ${artifact?.objectKey ?? null},
            output_sha256 = ${outcome.output ? sha(outcome.output) : null},
            output_bytes = ${outcome.output ? Buffer.byteLength(outcome.output) : null},
            completed_at = ${now}
        WHERE id = ${id} AND workspace_id = ${this.store.workspaceId}
        RETURNING agent_id, channel_id, conversation_id, run_id
      `;
      if (!row) throw new Error(`no execution ${id}`);
      const event = await this.events.append(sql, {
        workspaceId: this.store.workspaceId,
        channelId: row.channel_id,
        actorId: row.agent_id,
        kind,
        conversationId: row.conversation_id,
        runId: row.run_id,
        subjectId: id,
        payload: {
          executionId: id,
          status,
          outputPreview,
          error: outcome.error ?? null,
        },
        createdAt: now,
      });
      return { execution: (await this.findIn(sql, id))!, event };
    });
  }

  async listRecent(limit = 100): Promise<ToolExecution[]> {
    const rows = await this.store.sql<ExecutionRow[]>`
      SELECT * FROM tool_executions
      WHERE workspace_id = ${this.store.workspaceId}
      ORDER BY started_at DESC
      LIMIT ${limit}
    `;
    return rows.reverse().map(toExecution);
  }

  async find(id: string): Promise<ToolExecution | null> {
    const [row] = await this.store.sql<ExecutionRow[]>`
      SELECT * FROM tool_executions WHERE id = ${id} AND workspace_id = ${this.store.workspaceId}
    `;
    return row ? toExecution(row) : null;
  }

  async readArtifact(id: string, role: "input" | "output"): Promise<{ bytes: Buffer; contentType: string } | null> {
    const execution = await this.find(id);
    const ref = role === "input" ? execution?.inputArtifact : execution?.outputArtifact;
    if (!execution || !ref || !this.supabase) return null;
    const { data, error } = await this.supabase.storage.from(ARTIFACT_BUCKET).download(ref.objectKey);
    if (error || !data) return null;
    return { bytes: Buffer.from(await data.arrayBuffer()), contentType: ref.contentType };
  }

  async sweepExpired(retentionDays = DEFAULT_ARTIFACT_RETENTION_DAYS): Promise<number> {
    if (!this.supabase) return 0;
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const rows = await this.store.sql<{ id: string; input_object_key: string | null; output_object_key: string | null; agent_id: string }[]>`
      SELECT id, input_object_key, output_object_key, agent_id
      FROM tool_executions
      WHERE workspace_id = ${this.store.workspaceId}
        AND completed_at IS NOT NULL
        AND completed_at < ${cutoff}
        AND (input_object_key IS NOT NULL OR output_object_key IS NOT NULL)
    `;
    let expired = 0;
    for (const row of rows) {
      const keys = [row.input_object_key, row.output_object_key].filter((key): key is string => Boolean(key));
      if (keys.length) await this.supabase.storage.from(ARTIFACT_BUCKET).remove(keys);
      await this.store.sql`
        UPDATE tool_executions
        SET input_object_key = NULL, output_object_key = NULL
        WHERE id = ${row.id}
      `;
      await this.events.append(this.store.sql, {
        workspaceId: this.store.workspaceId,
        actorId: row.agent_id,
        kind: "tool.artifact.expired",
        subjectId: row.id,
        payload: { executionId: row.id },
      });
      expired += 1;
    }
    return expired;
  }

  async listForRun(runId: string): Promise<ToolExecution[]> {
    const rows = await this.store.sql<ExecutionRow[]>`
      SELECT * FROM tool_executions
      WHERE workspace_id = ${this.store.workspaceId} AND run_id = ${runId}
      ORDER BY started_at ASC
    `;
    return rows.map(toExecution);
  }

  private async storeArtifact(executionId: string, role: "input" | "output", body: string) {
    if (!this.supabase) return null;
    const objectKey = `${this.store.workspaceId}/${executionId}/${role}-${randomUUID()}`;
    const { error } = await this.supabase.storage.from(ARTIFACT_BUCKET).upload(objectKey, Buffer.from(body), {
      contentType: "text/plain",
    });
    if (error) {
      console.warn("[toolman] artifact upload failed:", error.message);
      return null;
    }
    return { objectKey, sha256: sha(body), bytes: Buffer.byteLength(body), contentType: "text/plain" };
  }

  private async findIn(sql: Sql, id: string): Promise<ToolExecution | null> {
    const [row] = await sql<ExecutionRow[]>`SELECT * FROM tool_executions WHERE id = ${id}`;
    return row ? toExecution(row) : null;
  }
}

interface ExecutionRow {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  conversation_id: string | null;
  run_id: string | null;
  agent_id: string;
  project_id: string;
  mount_id: string;
  node_id: string;
  board_item_ref: string | null;
  action: ToolmanActionKind;
  status: ToolExecutionStatus;
  summary: string;
  input_preview: string;
  output_preview: string | null;
  input_object_key: string | null;
  input_sha256: string | null;
  input_bytes: number | null;
  output_object_key: string | null;
  output_sha256: string | null;
  output_bytes: number | null;
  exit_code: number | null;
  error: string | null;
  started_at: number;
  completed_at: number | null;
}

function toExecution(row: ExecutionRow): ToolExecution {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    agentId: row.agent_id,
    projectId: row.project_id,
    mountId: row.mount_id,
    nodeId: row.node_id,
    boardItemRef: row.board_item_ref,
    action: row.action,
    status: row.status,
    summary: row.summary,
    inputPreview: row.input_preview,
    outputPreview: row.output_preview,
    inputArtifact: row.input_object_key
      ? { objectKey: row.input_object_key, sha256: row.input_sha256 ?? "", bytes: row.input_bytes ?? 0, contentType: "text/plain" }
      : null,
    outputArtifact: row.output_object_key
      ? { objectKey: row.output_object_key, sha256: row.output_sha256 ?? "", bytes: row.output_bytes ?? 0, contentType: "text/plain" }
      : null,
    exitCode: row.exit_code,
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function summarize(action: ProjectAction): string {
  if (action.kind === "project_run_command") return action.command.slice(0, 200);
  if (action.kind === "project_move_file") return `${action.from} → ${action.to}`;
  if ("path" in action) return action.path ?? ".";
  return action.kind;
}

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= PREVIEW ? text : `${text.slice(0, PREVIEW)}\n…[${text.length - PREVIEW} more characters]`;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
