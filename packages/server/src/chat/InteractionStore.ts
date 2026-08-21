import { randomUUID } from "node:crypto";
import type { InteractionRequest } from "@workspace/shared";
import type { WorkspaceDb } from "../db";
import type { ThreadEventStore } from "./ThreadEventStore";

/**
 * Durable permission prompts. A pending request is a row, not a promise, so a
 * paused run survives a server restart and every surface that renders the
 * prompt resolves the same id instead of minting its own copy.
 */
export class InteractionStore {
  constructor(
    private store: WorkspaceDb,
    private events: ThreadEventStore,
  ) {}

  async open(input: {
    workspaceId: string;
    channelId: string;
    agentId: string;
    conversationId: string | null;
    summary: string;
    capability: string;
    boardItemRef: string | null;
    targetActorId?: string | null;
  }): Promise<InteractionRequest> {
    const id = randomUUID();
    const createdAt = Date.now();
    return this.store.transaction(async (sql) => {
      const [row] = await sql<Row[]>`
        INSERT INTO interaction_requests
          (id, workspace_id, channel_id, agent_id, conversation_id, summary,
           capability, board_item_ref, target_actor_id, status, created_at)
        VALUES (
          ${id}, ${input.workspaceId}, ${input.channelId}, ${input.agentId},
          ${input.conversationId}, ${input.summary}, ${input.capability},
          ${input.boardItemRef}, ${input.targetActorId ?? null}, 'pending', ${new Date(createdAt)}
        )
        RETURNING *
      `;
      await this.events.append(sql, {
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        actorId: input.agentId,
        kind: "interaction.requested",
        conversationId: input.conversationId,
        subjectId: id,
        payload: {
          requestId: id,
          summary: input.summary,
          capability: input.capability,
          boardItemRef: input.boardItemRef,
        },
      });
      return toRequest(row);
    });
  }

  /**
   * Records a human's verdict. Returns null when the request is already
   * resolved, so a second click from another surface cannot flip a decision.
   */
  async resolve(
    workspaceId: string,
    requestId: string,
    decision: "approved" | "denied" | "expired",
    resolvedBy: string | null,
  ): Promise<InteractionRequest | null> {
    return this.store.transaction(async (sql) => {
      const [row] = await sql<Row[]>`
        UPDATE interaction_requests
        SET status = ${decision}, resolved_by = ${resolvedBy}, resolved_at = now()
        WHERE id = ${requestId} AND workspace_id = ${workspaceId} AND status = 'pending'
        RETURNING *
      `;
      if (!row) return null;
      await this.events.append(sql, {
        workspaceId,
        channelId: row.channel_id,
        actorId: resolvedBy ?? row.agent_id,
        kind: "interaction.resolved",
        conversationId: row.conversation_id,
        subjectId: requestId,
        payload: { requestId, decision },
      });
      return toRequest(row);
    });
  }

  async pending(workspaceId: string): Promise<InteractionRequest[]> {
    const rows = await this.store.sql<Row[]>`
      SELECT * FROM interaction_requests
      WHERE workspace_id = ${workspaceId} AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT 100
    `;
    return rows.map(toRequest);
  }

  async pendingForAgent(workspaceId: string, agentId: string): Promise<InteractionRequest[]> {
    const rows = await this.store.sql<Row[]>`
      SELECT * FROM interaction_requests
      WHERE workspace_id = ${workspaceId} AND agent_id = ${agentId} AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT 100
    `;
    return rows.map(toRequest);
  }

  async findPending(workspaceId: string, requestId: string): Promise<InteractionRequest | null> {
    const [row] = await this.store.sql<Row[]>`
      SELECT * FROM interaction_requests
      WHERE id = ${requestId} AND workspace_id = ${workspaceId} AND status = 'pending'
    `;
    return row ? toRequest(row) : null;
  }

  async expireForTarget(workspaceId: string, targetActorId: string): Promise<InteractionRequest[]> {
    const rows = await this.store.sql<Row[]>`
      UPDATE interaction_requests
      SET status = 'expired', resolved_at = now()
      WHERE workspace_id = ${workspaceId} AND status = 'pending' AND target_actor_id = ${targetActorId}
      RETURNING *
    `;
    return rows.map(toRequest);
  }

  /**
   * A pending request from a previous process has no waiter left to wake, so
   * startup expires it rather than leaving a prompt no answer can reach.
   */
  async expireStale(workspaceId: string): Promise<number> {
    const rows = await this.store.sql<{ id: string }[]>`
      UPDATE interaction_requests SET status = 'expired', resolved_at = now()
      WHERE workspace_id = ${workspaceId} AND status = 'pending'
      RETURNING id
    `;
    return rows.length;
  }
}

interface Row {
  id: string;
  workspace_id: string;
  channel_id: string;
  agent_id: string;
  conversation_id: string | null;
  summary: string;
  capability: string;
  board_item_ref: string | null;
  target_actor_id: string | null;
  status: InteractionRequest["status"];
  resolved_by: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

function toRequest(row: Row): InteractionRequest {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    agentId: row.agent_id,
    conversationId: row.conversation_id,
    summary: row.summary,
    capability: row.capability,
    boardItemRef: row.board_item_ref,
    targetActorId: row.target_actor_id,
    status: row.status,
    resolvedBy: row.resolved_by,
    createdAt: row.created_at.getTime(),
    resolvedAt: row.resolved_at ? row.resolved_at.getTime() : null,
  };
}
