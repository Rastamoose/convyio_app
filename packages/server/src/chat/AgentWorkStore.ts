import { randomUUID } from "node:crypto";
import type {
  ActivityBatchEvent,
  AgentConversation,
  AgentRunFinishEvent,
  AgentRunRequest,
  AgentWorkAssignment,
  ChatMessage,
  ConversationSessionSetEvent,
  PermissionMode,
  RunRequestStatus,
  ThreadEvent,
  ThreadEventKind,
  TraceChunk,
} from "@workspace/shared";
import type { Sql, WorkspaceDb } from "../db";
import type { MessageStore } from "./MessageStore";
import type { ThreadEventStore } from "./ThreadEventStore";

export class RunRequestAccessError extends Error {}

export interface ConversationSessionUpdate {
  conversation: AgentConversation;
  event: ThreadEvent | null;
}

export interface AgentRunFinishResult {
  message: ChatMessage | null;
  events: ThreadEvent[];
}

/** Projects durable agent conversations and mention-triggered run requests. */
export class AgentWorkStore {
  constructor(
    private store: WorkspaceDb,
    private threadEvents: ThreadEventStore,
    private messages: MessageStore,
  ) {}

  /**
   * Queue work for an approved ticket owner. Humans stay mention-driven;
   * this path is how the server, not a local stash, resumes ticket work.
   */
  async queueApprovedTicket(input: {
    actor: { id: string; displayName: string };
    owner: { id: string; displayName: string; kind: "human" | "agent" };
    item: { id: string; ref: string; title: string };
    channelId: string;
    channelName: string;
  }): Promise<{ request: AgentRunRequest; message: ChatMessage } | null> {
    if (input.owner.kind !== "agent") return null;
    const now = Date.now();
    const message: ChatMessage = {
      id: randomUUID(),
      authorId: input.actor.id,
      authorName: input.actor.displayName,
      authorKind: "human",
      content:
        `@${input.owner.displayName} ${input.item.ref} ("${input.item.title}") is approved and assigned to you. ` +
        `Call board_start("${input.item.ref}"), do the authorized work, then board_complete with evidence.`,
      timestamp: now,
      channelId: input.channelId,
      channel: input.channelName,
      mentions: [input.owner.id],
    };
    const [request] = await this.messages.appendAtomically(message, (sql) =>
      this.queue(sql, message, [input.owner.id]),
    );
    return request ? { request, message } : null;
  }

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

  async appendActivity(agentId: string, batch: ActivityBatchEvent): Promise<ThreadEvent[]> {
    return this.store.transaction(async (sql) => {
      await this.requireAgent(sql, agentId);
      for (const event of batch.events) {
        await this.requireActivityScope(sql, agentId, event.channelId, event.conversationId);
      }
      const appended = await this.threadEvents.appendBatch(
        sql,
        batch.events.map((event) => ({
          workspaceId: this.store.workspaceId,
          channelId: event.channelId,
          actorId: agentId,
          kind: event.kind,
          conversationId: event.conversationId,
          runId: event.runId,
          subjectId: event.subjectId,
          parentId: event.parentId,
          clientEventId: event.clientEventId,
          payload: event.payload,
        })),
      );
      return appended.filter((entry) => entry.inserted).map((entry) => entry.event);
    });
  }

  async setConversationSession(
    agentId: string,
    event: ConversationSessionSetEvent,
  ): Promise<ConversationSessionUpdate> {
    return this.store.transaction(async (sql) => {
      await this.requireAgent(sql, agentId);
      const conversation = await this.requireConversation(sql, agentId, event.conversationId, undefined, true);
      if (
        conversation.provider_session_id === event.providerSessionId &&
        conversation.permission_mode === event.permissionMode
      ) {
        return { conversation: toConversation(conversation), event: null };
      }

      const now = Date.now();
      const [updated] = await sql<ConversationRow[]>`
        UPDATE agent_conversations
        SET provider_session_id = ${event.providerSessionId},
            permission_mode = ${event.permissionMode},
            updated_at = ${now}
        WHERE id = ${conversation.id}
        RETURNING *
      `;
      const [appended] = await this.threadEvents.appendBatch(sql, [{
        workspaceId: updated.workspace_id,
        channelId: updated.channel_id,
        actorId: agentId,
        kind: "agent.provider.session",
        conversationId: updated.id,
        subjectId: updated.id,
        clientEventId: event.clientEventId,
        payload: {
          providerSessionIdSet: updated.provider_session_id !== null,
          permissionMode: updated.permission_mode,
        },
        createdAt: now,
      }]);
      return {
        conversation: toConversation(updated),
        event: appended.inserted ? appended.event : null,
      };
    });
  }

  async finishRun(
    agentId: string,
    event: AgentRunFinishEvent,
    trace: TraceChunk[],
  ): Promise<AgentRunFinishResult> {
    this.requireDistinctIdsOrEmpty(event.requestIds);
    return this.store.transaction(async (sql) => {
      const actorName = await this.requireAgent(sql, agentId);
      const channel = await this.requireChannel(sql, event.channelId);
      const requests = event.requestIds.length > 0
        ? await this.lockOwned(sql, agentId, event.requestIds)
        : [];
      if (
        requests.some(
          (request) =>
            request.channel_id !== event.channelId ||
            request.conversation_id !== event.conversationId,
        )
      ) {
        throw new RunRequestAccessError("work request does not match run scope");
      }
      if (event.conversationId) {
        await this.requireConversation(sql, agentId, event.conversationId, event.channelId, true);
      } else if (requests.length > 0) {
        throw new RunRequestAccessError("durable work requires a conversation");
      }

      const finishClientEventId = `agent-run-finish:${event.runId}`;
      const existing = await this.threadEvents.findByClientEvent(sql, agentId, finishClientEventId);
      if (existing) {
        this.requireMatchingFinish(existing, event);
        return { message: null, events: [] };
      }

      const requestStatus: RunRequestStatus = event.outcome;
      if (requests.some((request) => request.status !== "claimed" && request.status !== requestStatus)) {
        throw new RunRequestAccessError("work request is not finishable");
      }

      const now = Date.now();
      const committed: ThreadEvent[] = [];
      const lifecycleKind: ThreadEventKind =
        event.outcome === "completed"
          ? "agent.run.completed"
          : event.outcome === "cancelled"
            ? "agent.run.cancelled"
            : "agent.run.failed";
      for (const request of requests) {
        if (request.status === "claimed") {
          const [finished] = await sql<RunRequestRow[]>`
            UPDATE agent_run_requests
            SET status = ${requestStatus}, completed_at = ${now}
            WHERE id = ${request.id} AND status = 'claimed'
            RETURNING *
          `;
          if (!finished) throw new Error("locked claimed work request could not be finished");
          committed.push(await this.threadEvents.append(sql, {
            workspaceId: finished.workspace_id,
            channelId: finished.channel_id,
            actorId: agentId,
            kind: lifecycleKind,
            conversationId: finished.conversation_id,
            runId: event.runId,
            subjectId: finished.id,
            parentId: finished.message_id,
            clientEventId: `${finishClientEventId}:request:${finished.id}`,
            payload: {
              requestId: finished.id,
              messageId: finished.message_id,
              outcome: event.outcome,
            },
            createdAt: now,
          }));
        }
      }

      let message: ChatMessage | null = null;
      if (event.outcome !== "cancelled" && event.finalContent.trim()) {
        message = {
          id: randomUUID(),
          authorId: agentId,
          authorName: actorName,
          authorKind: "agent",
          content: event.finalContent,
          timestamp: now,
          channelId: channel.id,
          channel: channel.name,
          mentions: [],
          runId: event.runId,
          trace: trace.length > 0 ? trace : undefined,
        };
        committed.push(await this.messages.appendInTransaction(sql, message, {
          conversationId: event.conversationId,
          clientEventId: `${finishClientEventId}:message`,
        }));
      }

      if (event.conversationId) {
        await sql`
          UPDATE agent_conversations SET updated_at = ${now}
          WHERE id = ${event.conversationId}
        `;
      }
      committed.push(await this.threadEvents.append(sql, {
        workspaceId: this.store.workspaceId,
        channelId: event.channelId,
        actorId: agentId,
        kind: lifecycleKind,
        conversationId: event.conversationId,
        runId: event.runId,
        subjectId: event.runId,
        clientEventId: finishClientEventId,
        payload: {
          requestIds: event.requestIds,
          outcome: event.outcome,
          ...(message ? { messageId: message.id } : {}),
          ...(event.error ? { error: event.error } : {}),
          ...(event.usage ? { usage: event.usage } : {}),
        },
        createdAt: now,
      }));
      return { message, events: committed };
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

  private async requireAgent(sql: Sql, agentId: string): Promise<string> {
    const [actor] = await sql<{ display_name: string }[]>`
      SELECT a.display_name
      FROM actors a
      JOIN workspace_members m ON m.actor_id = a.id
      WHERE a.id = ${agentId}
        AND a.kind = 'agent'
        AND m.workspace_id = ${this.store.workspaceId}
    `;
    if (!actor) throw new RunRequestAccessError("unknown agent identity");
    return actor.display_name;
  }

  private async requireChannel(sql: Sql, channelId: string): Promise<ChannelRow> {
    const [channel] = await sql<ChannelRow[]>`
      SELECT id, name FROM channels WHERE id = ${channelId}
    `;
    if (!channel) throw new RunRequestAccessError("unknown channel");
    return channel;
  }

  private async requireActivityScope(
    sql: Sql,
    agentId: string,
    channelId: string,
    conversationId: string | null,
  ): Promise<void> {
    await this.requireChannel(sql, channelId);
    if (conversationId) {
      await this.requireConversation(sql, agentId, conversationId, channelId, false);
    }
  }

  private async requireConversation(
    sql: Sql,
    agentId: string,
    conversationId: string,
    channelId: string | undefined,
    lock: boolean,
  ): Promise<ConversationRow> {
    const channel = channelId ? sql`AND channel_id = ${channelId}` : sql``;
    const locking = lock ? sql`FOR UPDATE` : sql``;
    const [conversation] = await sql<ConversationRow[]>`
      SELECT * FROM agent_conversations
      WHERE id = ${conversationId}
        AND workspace_id = ${this.store.workspaceId}
        AND agent_id = ${agentId}
        ${channel}
      ${locking}
    `;
    if (!conversation) throw new RunRequestAccessError("unknown or unowned conversation");
    return conversation;
  }

  /**
   * The mode governing a conversation's tool calls. Ownership is part of the
   * lookup, so an agent cannot read a mode set on someone else's conversation;
   * an unknown or unowned id falls back to the strictest prompting mode.
   */
  /**
   * A human's choice of how much of the board grant runs without asking. Keyed
   * on the agent and channel because that is what a person picks in the UI;
   * the conversation may not exist until the agent is first mentioned, so an
   * unmentioned agent's mode is stored the moment it is chosen.
   */
  async setPermissionMode(
    actorId: string,
    agentId: string,
    channelId: string,
    mode: PermissionMode,
  ): Promise<AgentConversation> {
    return this.store.transaction(async (sql) => {
      const now = Date.now();
      const [row] = await sql<ConversationRow[]>`
        INSERT INTO agent_conversations (
          id, workspace_id, agent_id, channel_id, provider_session_id,
          permission_mode, status, created_at, updated_at
        ) VALUES (
          ${randomUUID()}, ${this.store.workspaceId}, ${agentId}, ${channelId},
          NULL, ${mode}, 'active', ${now}, ${now}
        )
        ON CONFLICT (workspace_id, agent_id, channel_id)
        DO UPDATE SET permission_mode = ${mode}, updated_at = ${now}
        RETURNING *
      `;
      await this.threadEvents.append(sql, {
        workspaceId: row.workspace_id,
        channelId: row.channel_id,
        actorId,
        kind: "conversation.mode_changed",
        conversationId: row.id,
        subjectId: row.id,
        payload: { permissionMode: mode, agentId },
        createdAt: now,
      });
      return toConversation(row);
    });
  }

  async permissionMode(agentId: string, conversationId: string): Promise<PermissionMode> {
    const [row] = await this.store.sql<{ permission_mode: PermissionMode }[]>`
      SELECT permission_mode FROM agent_conversations
      WHERE id = ${conversationId}
        AND workspace_id = ${this.store.workspaceId}
        AND agent_id = ${agentId}
    `;
    return row?.permission_mode ?? "default";
  }

  async channelOfConversation(conversationId: string): Promise<string | null> {
    const [row] = await this.store.sql<{ channel_id: string }[]>`
      SELECT channel_id FROM agent_conversations
      WHERE id = ${conversationId} AND workspace_id = ${this.store.workspaceId}
    `;
    return row?.channel_id ?? null;
  }

  private requireMatchingFinish(existing: ThreadEvent, event: AgentRunFinishEvent): void {
    const requestIds = existing.payload.requestIds;
    if (
      existing.kind !==
        (event.outcome === "completed"
          ? "agent.run.completed"
          : event.outcome === "cancelled"
            ? "agent.run.cancelled"
            : "agent.run.failed") ||
      existing.channelId !== event.channelId ||
      existing.conversationId !== event.conversationId ||
      existing.runId !== event.runId ||
      existing.payload.outcome !== event.outcome ||
      !Array.isArray(requestIds) ||
      requestIds.length !== event.requestIds.length ||
      requestIds.some((id, index) => id !== event.requestIds[index])
    ) {
      throw new RunRequestAccessError("run id was already finalized with different data");
    }
  }

  private requireDistinctIds(requestIds: string[]): void {
    if (requestIds.length === 0 || new Set(requestIds).size !== requestIds.length) {
      throw new RunRequestAccessError("work request ids must be non-empty and unique");
    }
  }

  private requireDistinctIdsOrEmpty(requestIds: string[]): void {
    if (new Set(requestIds).size !== requestIds.length) {
      throw new RunRequestAccessError("work request ids must be unique");
    }
  }
}

interface ChannelRow {
  id: string;
  name: string;
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
