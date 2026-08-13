import { randomUUID } from "node:crypto";
import type {
  AgentConversation,
  AgentRunRequest,
  AgentWorkAssignment,
  ChatMessage,
  PermissionMode,
  RunRequestStatus,
} from "@workspace/shared";
import type { Sql, WorkspaceDb } from "../db";
import type { MessageStore } from "./MessageStore";
import type { ThreadEventStore } from "./ThreadEventStore";

export class RunRequestAccessError extends Error {}

/** Projects durable agent conversations and mention-triggered run requests. */
export class AgentWorkStore {
  constructor(
    private store: WorkspaceDb,
    private threadEvents: ThreadEventStore,
    private messages: MessageStore,
  ) {}

  /** Queue exactly one request per target inside the message transaction. */
  async queue(sql: Sql, message: ChatMessage, agentIds: string[]): Promise<AgentRunRequest[]> {
    if (message.authorKind !== "human" || agentIds.length === 0) return [];
    if (!message.channelId) throw new Error("queued message channelId is required");

    const queued: AgentRunRequest[] = [];
    for (const agentId of new Set(agentIds)) {
      const conversation = await this.getOrCreateConversation(sql, message, agentId);
      const [row] = await sql<RunRequestRow[]>`
        INSERT INTO agent_run_requests (
          id, workspace_id, channel_id, agent_id, message_id, conversation_id,
          status, created_at, claimed_at, completed_at
        ) VALUES (
          ${randomUUID()}, ${this.store.workspaceId}, ${message.channelId}, ${agentId},
          ${message.id}, ${conversation.id}, 'queued', ${message.timestamp}, NULL, NULL
        )
        ON CONFLICT (agent_id, message_id) DO NOTHING
        RETURNING *
      `;
      if (!row) continue;
      const request = toRunRequest(row);
      queued.push(request);
      await this.threadEvents.append(sql, {
        workspaceId: request.workspaceId,
        channelId: request.channelId,
        actorId: message.authorId,
        kind: "agent.run.requested",
        conversationId: request.conversationId,
        subjectId: request.id,
        parentId: request.messageId,
        payload: {
          requestId: request.id,
          agentId: request.agentId,
          messageId: request.messageId,
        },
        createdAt: request.createdAt,
      });
    }
    return queued;
  }

  /** Claim all ids or none; repeats by the owning agent return the same assignments. */
  async claim(agentId: string, requestIds: string[]): Promise<AgentWorkAssignment[]> {
    this.requireDistinctIds(requestIds);
    return this.store.transaction(async (sql) => {
      const rows = await this.lockOwned(sql, agentId, requestIds);
      if (rows.some((row) => row.status !== "queued" && row.status !== "claimed")) {
        throw new RunRequestAccessError("work request is not claimable");
      }

      const now = Date.now();
      for (const row of rows) {
        if (row.status === "claimed") continue;
        const [claimed] = await sql<RunRequestRow[]>`
          UPDATE agent_run_requests
          SET status = 'claimed', claimed_at = ${now}
          WHERE id = ${row.id} AND status = 'queued'
          RETURNING *
        `;
        if (!claimed) throw new Error("locked queued work request could not be claimed");
        await this.threadEvents.append(sql, {
          workspaceId: claimed.workspace_id,
          channelId: claimed.channel_id,
          actorId: agentId,
          kind: "agent.run.claimed",
          conversationId: claimed.conversation_id,
          subjectId: claimed.id,
          parentId: claimed.message_id,
          payload: { requestId: claimed.id, messageId: claimed.message_id },
          createdAt: now,
        });
      }
      return this.hydrate(sql, requestIds);
    });
  }

  /** Complete or cancel owned claimed requests; repeating the same outcome is a no-op. */
  async finish(
    agentId: string,
    requestIds: string[],
    outcome: "completed" | "cancelled",
  ): Promise<void> {
    this.requireDistinctIds(requestIds);
    await this.store.transaction(async (sql) => {
      const rows = await this.lockOwned(sql, agentId, requestIds);
      if (rows.some((row) => row.status !== "claimed" && row.status !== outcome)) {
        throw new RunRequestAccessError("work request is not completable");
      }

      const now = Date.now();
      for (const row of rows) {
        if (row.status === outcome) continue;
        const [finished] = await sql<RunRequestRow[]>`
          UPDATE agent_run_requests
          SET status = ${outcome}, completed_at = ${now}
          WHERE id = ${row.id} AND status = 'claimed'
          RETURNING *
        `;
        if (!finished) throw new Error("locked claimed work request could not be finished");
        await this.threadEvents.append(sql, {
          workspaceId: finished.workspace_id,
          channelId: finished.channel_id,
          actorId: agentId,
          kind: outcome === "completed" ? "agent.run.completed" : "agent.run.cancelled",
          conversationId: finished.conversation_id,
          subjectId: finished.id,
          parentId: finished.message_id,
          payload: { requestId: finished.id, messageId: finished.message_id },
          createdAt: now,
        });
      }
    });
  }

  /** A reconnect makes this agent's prior claims stale; no timer or lease is involved. */
  async requeueClaimed(agentId: string): Promise<void> {
    await this.store.transaction(async (sql) => {
      const rows = await sql<RunRequestRow[]>`
        SELECT * FROM agent_run_requests
        WHERE workspace_id = ${this.store.workspaceId}
          AND agent_id = ${agentId}
          AND status = 'claimed'
        ORDER BY created_at, id
        FOR UPDATE
      `;
      const now = Date.now();
      for (const row of rows) {
        await sql`
          UPDATE agent_run_requests
          SET status = 'queued', claimed_at = NULL
          WHERE id = ${row.id}
        `;
        await this.threadEvents.append(sql, {
          workspaceId: row.workspace_id,
          channelId: row.channel_id,
          actorId: agentId,
          kind: "agent.run.requeued",
          conversationId: row.conversation_id,
          subjectId: row.id,
          parentId: row.message_id,
          payload: { requestId: row.id, messageId: row.message_id },
          createdAt: now,
        });
      }
    });
  }

  async listPending(agentId: string): Promise<AgentRunRequest[]> {
    const rows = await this.store.sql<RunRequestRow[]>`
      SELECT * FROM agent_run_requests
      WHERE workspace_id = ${this.store.workspaceId}
        AND agent_id = ${agentId}
        AND status = 'queued'
      ORDER BY created_at, id
    `;
    return rows.map(toRunRequest);
  }

  private async getOrCreateConversation(
    sql: Sql,
    message: ChatMessage,
    agentId: string,
  ): Promise<AgentConversation> {
    const now = message.timestamp;
    const [created] = await sql<ConversationRow[]>`
      INSERT INTO agent_conversations (
        id, workspace_id, agent_id, channel_id, provider_session_id,
        permission_mode, status, created_at, updated_at
      ) VALUES (
        ${randomUUID()}, ${this.store.workspaceId}, ${agentId}, ${message.channelId!},
        NULL, 'default', 'active', ${now}, ${now}
      )
      ON CONFLICT (workspace_id, agent_id, channel_id) DO NOTHING
      RETURNING *
    `;
    if (created) {
      const conversation = toConversation(created);
      await this.threadEvents.append(sql, {
        workspaceId: conversation.workspaceId,
        channelId: conversation.channelId,
        actorId: message.authorId,
        kind: "conversation.created",
        conversationId: conversation.id,
        subjectId: conversation.id,
        payload: { conversationId: conversation.id, agentId },
        createdAt: now,
      });
      return conversation;
    }

    const [existing] = await sql<ConversationRow[]>`
      UPDATE agent_conversations
      SET updated_at = GREATEST(updated_at, ${now})
      WHERE workspace_id = ${this.store.workspaceId}
        AND agent_id = ${agentId}
        AND channel_id = ${message.channelId!}
      RETURNING *
    `;
    if (!existing) throw new Error("conversation conflict did not resolve to a row");
    return toConversation(existing);
  }

  private async lockOwned(
    sql: Sql,
    agentId: string,
    requestIds: string[],
  ): Promise<RunRequestRow[]> {
    const rows = await sql<RunRequestRow[]>`
      SELECT * FROM agent_run_requests
      WHERE workspace_id = ${this.store.workspaceId}
        AND id IN ${sql(requestIds)}
      FOR UPDATE
    `;
    if (rows.length !== requestIds.length || rows.some((row) => row.agent_id !== agentId)) {
      throw new RunRequestAccessError("unknown or unowned work request");
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    return requestIds.map((id) => byId.get(id)!);
  }

  private async hydrate(sql: Sql, requestIds: string[]): Promise<AgentWorkAssignment[]> {
    const requests = await sql<RunRequestRow[]>`
      SELECT * FROM agent_run_requests WHERE id IN ${sql(requestIds)}
    `;
    const requestById = new Map(requests.map((row) => [row.id, toRunRequest(row)]));
    const ordered = requestIds.map((id) => requestById.get(id)!);
    const conversations = await sql<ConversationRow[]>`
      SELECT * FROM agent_conversations
      WHERE id IN ${sql([...new Set(ordered.map((request) => request.conversationId))])}
    `;
    const conversationById = new Map(
      conversations.map((row) => [row.id, toConversation(row)]),
    );
    const triggers = await this.messages.getManyInTransaction(
      sql,
      ordered.map((request) => request.messageId),
    );
    const triggerById = new Map(triggers.map((message) => [message.id, message]));

    return ordered.map((request) => {
      const conversation = conversationById.get(request.conversationId);
      const trigger = triggerById.get(request.messageId);
      if (!conversation || !trigger) throw new Error("work request hydration is incomplete");
      return { request, conversation, trigger };
    });
  }

  private requireDistinctIds(requestIds: string[]): void {
    if (requestIds.length === 0 || new Set(requestIds).size !== requestIds.length) {
      throw new RunRequestAccessError("work request ids must be non-empty and unique");
    }
  }
}

interface ConversationRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  channel_id: string;
  provider_session_id: string | null;
  permission_mode: PermissionMode;
  status: string;
  created_at: number;
  updated_at: number;
}

interface RunRequestRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  agent_id: string;
  message_id: string;
  conversation_id: string;
  status: RunRequestStatus;
  created_at: number;
  claimed_at: number | null;
  completed_at: number | null;
}

function toConversation(row: ConversationRow): AgentConversation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    channelId: row.channel_id,
    providerSessionId: row.provider_session_id,
    permissionMode: row.permission_mode,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRunRequest(row: RunRequestRow): AgentRunRequest {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    agentId: row.agent_id,
    messageId: row.message_id,
    conversationId: row.conversation_id,
    status: row.status,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
  };
}
