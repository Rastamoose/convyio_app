import { randomUUID } from "node:crypto";
import type {
  Actor,
  AgentResourceAccessRequest,
  AgentResourceGrant,
  ProtectedResourceKind,
  ResourceAccessStatus,
  ThreadEvent,
} from "@workspace/shared";
import { ApiError } from "../board/BoardService";
import type { ThreadEventStore } from "../chat/ThreadEventStore";
import type { Sql, WorkspaceDb } from "../db";

interface ResourceRecord {
  id: string;
  kind: ProtectedResourceKind;
  name: string;
  ownerId: string | null;
}

export class ResourceAccessStore {
  onEvent: ((event: ThreadEvent) => void) | null = null;

  constructor(
    private store: WorkspaceDb,
    private events: ThreadEventStore,
    private canInvoke: (agentId: string, humanId: string) => Promise<boolean>,
  ) {}

  async has(agentId: string, resourceKind: ProtectedResourceKind, resourceId: string): Promise<boolean> {
    const rows = await this.store.sql`
      SELECT id FROM agent_resource_grants
      WHERE workspace_id = ${this.store.workspaceId}
        AND agent_id = ${agentId}
        AND resource_kind = ${resourceKind}
        AND resource_id = ${resourceId}
        AND revoked_at IS NULL
      LIMIT 1
    `;
    return rows.length > 0;
  }

  async request(
    actor: Actor,
    input: {
      resourceKind: ProtectedResourceKind;
      resourceId: string;
      reason: string;
      originChannelId?: string | null;
    },
  ): Promise<AgentResourceAccessRequest> {
    if (actor.kind !== "agent") throw new ApiError(403, "AGENT_ONLY", "only agents can request resource access");
    const reason = input.reason.trim();
    if (!reason) throw new ApiError(400, "REASON_REQUIRED", "a reason is required");
    if (reason.length > 1000) throw new ApiError(400, "REASON_TOO_LONG", "reason exceeds 1000 characters");
    const resource = await this.requireResource(this.store.sql, input.resourceKind, input.resourceId);
    if (await this.has(actor.id, input.resourceKind, input.resourceId)) {
      throw new ApiError(409, "ALREADY_GRANTED", `agent already has access to ${resource.name}`);
    }
    if (input.originChannelId) await this.requireResource(this.store.sql, "channel", input.originChannelId);
    const id = randomUUID();
    const now = Date.now();
    try {
      const result = await this.store.transaction(async (sql) => {
        const [row] = await sql<RequestRow[]>`
          INSERT INTO agent_resource_access_requests (
            id, workspace_id, agent_id, resource_kind, resource_id, reason,
            status, origin_channel_id, created_at, resolved_by, resolved_at
          ) VALUES (
            ${id}, ${this.store.workspaceId}, ${actor.id}, ${input.resourceKind},
            ${input.resourceId}, ${reason}, 'pending', ${input.originChannelId ?? null},
            ${now}, NULL, NULL
          )
          RETURNING *
        `;
        const event = await this.events.append(sql, {
          workspaceId: this.store.workspaceId,
          channelId: input.originChannelId ?? null,
          actorId: actor.id,
          kind: "resource.access.requested",
          subjectId: id,
          payload: {
            requestId: id,
            agentId: actor.id,
            resourceKind: input.resourceKind,
            resourceId: input.resourceId,
          },
          createdAt: now,
        });
        return { request: toRequest(row, actor.displayName, resource.name), event };
      });
      this.onEvent?.(result.event);
      return result.request;
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, "ALREADY_PENDING", "an access request is already pending");
      throw error;
    }
  }

  /** First-mention / idempotent request: granted or already-pending is not an error. */
  async requestIfNeeded(
    actor: Actor,
    input: {
      resourceKind: ProtectedResourceKind;
      resourceId: string;
      reason: string;
      originChannelId?: string | null;
    },
  ): Promise<AgentResourceAccessRequest | null> {
    try {
      return await this.request(actor, input);
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.code === "ALREADY_GRANTED" || error.code === "ALREADY_PENDING")
      ) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Grant channel access immediately, with no approval round-trip: a human
   * directly mentioning an agent in a channel is itself the authorization to
   * be there, so gating that behind a second explicit approval step is pure
   * friction. Distinct from `request` (via `requestIfNeeded`), which is for
   * an agent's own proactive discovery into channels nobody invited it to —
   * that still goes through human approval.
   */
  async autoGrant(
    agentId: string,
    grantedBy: string,
    input: { resourceKind: ProtectedResourceKind; resourceId: string; reason: string },
  ): Promise<AgentResourceGrant | null> {
    if (await this.has(agentId, input.resourceKind, input.resourceId)) return null;
    await this.requireResource(this.store.sql, input.resourceKind, input.resourceId);
    const now = Date.now();
    const result = await this.store.transaction(async (sql) => {
      const [row] = await sql<GrantRow[]>`
        INSERT INTO agent_resource_grants (
          id, workspace_id, agent_id, resource_kind, resource_id, capability,
          granted_by, reason, created_at, revoked_by, revoked_at
        ) VALUES (
          ${randomUUID()}, ${this.store.workspaceId}, ${agentId}, ${input.resourceKind},
          ${input.resourceId}, 'content_read', ${grantedBy}, ${input.reason}, ${now}, NULL, NULL
        )
        RETURNING *
      `;
      const event = await this.events.append(sql, {
        workspaceId: this.store.workspaceId,
        channelId: input.resourceKind === "channel" ? input.resourceId : null,
        actorId: grantedBy,
        kind: "resource.access.granted",
        subjectId: row.id,
        payload: {
          grantId: row.id,
          agentId,
          resourceKind: input.resourceKind,
          resourceId: input.resourceId,
        },
        createdAt: now,
      });
      return { grant: toGrant(row), event };
    });
    this.onEvent?.(result.event);
    return result.grant;
  }

  async resolve(
    actor: Actor,
    requestId: string,
    decision: Exclude<ResourceAccessStatus, "pending">,
  ): Promise<AgentResourceAccessRequest> {
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can resolve resource access");
    const pending = await this.requirePending(this.store.sql, requestId, false);
    const authorizedResource = await this.requireResource(this.store.sql, pending.resource_kind, pending.resource_id);
    await this.requireGrantAuthority(actor, pending.agent_id, authorizedResource);
    const now = Date.now();
    const result = await this.store.transaction(async (sql) => {
      const request = await this.requirePending(sql, requestId);
      const resource = await this.requireResource(sql, request.resource_kind, request.resource_id);
      const [row] = await sql<RequestRow[]>`
        UPDATE agent_resource_access_requests
        SET status = ${decision}, resolved_by = ${actor.id}, resolved_at = ${now}
        WHERE id = ${requestId} AND workspace_id = ${this.store.workspaceId} AND status = 'pending'
        RETURNING *
      `;
      if (!row) throw new ApiError(404, "NOT_FOUND", "no pending access request");
      let grant: GrantRow | null = null;
      if (decision === "approved") {
        [grant] = await sql<GrantRow[]>`
          INSERT INTO agent_resource_grants (
            id, workspace_id, agent_id, resource_kind, resource_id, capability,
            granted_by, reason, created_at, revoked_by, revoked_at
          ) VALUES (
            ${randomUUID()}, ${this.store.workspaceId}, ${request.agent_id},
            ${request.resource_kind}, ${request.resource_id}, 'content_read',
            ${actor.id}, ${request.reason}, ${now}, NULL, NULL
          )
          RETURNING *
        `;
      }
      const event = await this.events.append(sql, {
        workspaceId: this.store.workspaceId,
        channelId: request.origin_channel_id,
        actorId: actor.id,
        kind: decision === "approved" ? "resource.access.granted" : "resource.access.denied",
        subjectId: grant?.id ?? requestId,
        parentId: requestId,
        payload: {
          requestId,
          grantId: grant?.id,
          agentId: request.agent_id,
          resourceKind: request.resource_kind,
          resourceId: request.resource_id,
        },
        createdAt: now,
      });
      const [agent] = await sql<{ display_name: string }[]>`SELECT display_name FROM actors WHERE id = ${request.agent_id}`;
      return { request: toRequest(row, agent?.display_name, resource.name, actor.displayName), event };
    });
    this.onEvent?.(result.event);
    return result.request;
  }

  async revoke(actor: Actor, grantId: string): Promise<AgentResourceGrant> {
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can revoke resource access");
    const [active] = await this.store.sql<GrantRow[]>`
      SELECT * FROM agent_resource_grants
      WHERE id = ${grantId} AND workspace_id = ${this.store.workspaceId} AND revoked_at IS NULL
    `;
    if (!active) throw new ApiError(404, "NOT_FOUND", "no active resource grant");
    const authorizedResource = await this.requireResource(
      this.store.sql,
      active.resource_kind,
      active.resource_id,
      true,
    );
    await this.requireGrantAuthority(actor, active.agent_id, authorizedResource);
    const now = Date.now();
    const result = await this.store.transaction(async (sql) => {
      const [row] = await sql<GrantRow[]>`
        UPDATE agent_resource_grants
        SET revoked_by = ${actor.id}, revoked_at = ${now}
        WHERE id = ${grantId} AND revoked_at IS NULL
        RETURNING *
      `;
      if (!row) throw new ApiError(404, "NOT_FOUND", "no active resource grant");
      const event = await this.events.append(sql, {
        workspaceId: this.store.workspaceId,
        actorId: actor.id,
        kind: "resource.access.revoked",
        subjectId: grantId,
        payload: {
          grantId,
          agentId: row.agent_id,
          resourceKind: row.resource_kind,
          resourceId: row.resource_id,
        },
        createdAt: now,
      });
      return { grant: toGrant(row, actor.displayName), event };
    });
    this.onEvent?.(result.event);
    return result.grant;
  }

  async grantsForAgent(agentId: string): Promise<AgentResourceGrant[]> {
    const rows = await this.store.sql<NamedGrantRow[]>`
      SELECT g.*, giver.display_name AS granted_by_name, revoker.display_name AS revoked_by_name
      FROM agent_resource_grants g
      JOIN actors giver ON giver.id = g.granted_by
      LEFT JOIN actors revoker ON revoker.id = g.revoked_by
      WHERE g.workspace_id = ${this.store.workspaceId} AND g.agent_id = ${agentId} AND g.revoked_at IS NULL
      ORDER BY g.created_at ASC
    `;
    return rows.map((row) => toGrant(row, row.granted_by_name, row.revoked_by_name));
  }

  async requestsForAgent(agentId: string): Promise<AgentResourceAccessRequest[]> {
    const rows = await this.store.sql<NamedRequestRow[]>`
      SELECT r.*, agent.display_name AS agent_name, resolver.display_name AS resolved_by_name,
        CASE
          WHEN r.resource_kind = 'channel' THEN (SELECT name FROM channels WHERE id = r.resource_id)
          ELSE (SELECT name FROM projects WHERE id = r.resource_id)
        END AS resource_name
      FROM agent_resource_access_requests r
      JOIN actors agent ON agent.id = r.agent_id
      LEFT JOIN actors resolver ON resolver.id = r.resolved_by
      WHERE r.workspace_id = ${this.store.workspaceId} AND r.agent_id = ${agentId}
      ORDER BY r.created_at ASC
    `;
    return rows.map((row) => toRequest(row, row.agent_name, row.resource_name, row.resolved_by_name));
  }

  async pendingRequests(): Promise<AgentResourceAccessRequest[]> {
    const rows = await this.store.sql<NamedRequestRow[]>`
      SELECT r.*, agent.display_name AS agent_name, resolver.display_name AS resolved_by_name,
        CASE
          WHEN r.resource_kind = 'channel' THEN (SELECT name FROM channels WHERE id = r.resource_id)
          ELSE (SELECT name FROM projects WHERE id = r.resource_id)
        END AS resource_name
      FROM agent_resource_access_requests r
      JOIN actors agent ON agent.id = r.agent_id
      LEFT JOIN actors resolver ON resolver.id = r.resolved_by
      WHERE r.workspace_id = ${this.store.workspaceId} AND r.status = 'pending'
      ORDER BY r.created_at ASC
    `;
    return rows.map((row) => toRequest(row, row.agent_name, row.resource_name, row.resolved_by_name));
  }

  private async requirePending(sql: Sql, requestId: string, lock = true): Promise<RequestRow> {
    const [request] = await sql<RequestRow[]>`
      SELECT * FROM agent_resource_access_requests
      WHERE id = ${requestId} AND workspace_id = ${this.store.workspaceId} AND status = 'pending'
      ${lock ? sql`FOR UPDATE` : sql``}
    `;
    if (!request) throw new ApiError(404, "NOT_FOUND", "no pending access request");
    return request;
  }

  private async requireGrantAuthority(actor: Actor, agentId: string, resource: ResourceRecord): Promise<void> {
    if (resource.kind === "channel") {
      if (!(await this.canInvoke(agentId, actor.id))) {
        throw new ApiError(403, "GRANT_FORBIDDEN", "this human may not grant access to that agent");
      }
      return;
    }
    if (resource.ownerId !== actor.id) {
      throw new ApiError(403, "OWNER_ONLY", "only the resource owner may grant access");
    }
  }

  private async requireResource(
    sql: Sql,
    kind: ProtectedResourceKind,
    id: string,
    includeArchived = false,
  ): Promise<ResourceRecord> {
    if (kind === "channel") {
      const [row] = await sql<{ id: string; name: string }[]>`
        SELECT id, name FROM channels
        WHERE id = ${id} AND workspace_id = ${this.store.workspaceId}
          ${includeArchived ? sql`` : sql`AND archived_at IS NULL`}
      `;
      if (row) return { id: row.id, kind, name: row.name, ownerId: null };
    } else if (kind === "git_project" || kind === "local_project") {
      const projectKind = kind === "git_project" ? "git" : "directory";
      const [row] = await sql<{ id: string; name: string; created_by: string }[]>`
        SELECT id, name, created_by FROM projects
        WHERE id = ${id} AND workspace_id = ${this.store.workspaceId} AND kind = ${projectKind}
          ${includeArchived ? sql`` : sql`AND archived_at IS NULL`}
      `;
      if (row) return { id: row.id, kind, name: row.name, ownerId: row.created_by };
    }
    throw new ApiError(404, "NOT_FOUND", "no such resource");
  }
}

interface GrantRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  resource_kind: ProtectedResourceKind;
  resource_id: string;
  granted_by: string;
  reason: string;
  created_at: number;
  revoked_by: string | null;
  revoked_at: number | null;
}

interface NamedGrantRow extends GrantRow {
  granted_by_name: string;
  revoked_by_name: string | null;
}

interface RequestRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  resource_kind: ProtectedResourceKind;
  resource_id: string;
  reason: string;
  status: ResourceAccessStatus;
  origin_channel_id: string | null;
  created_at: number;
  resolved_by: string | null;
  resolved_at: number | null;
}

interface NamedRequestRow extends RequestRow {
  agent_name: string;
  resource_name: string;
  resolved_by_name: string | null;
}

function toGrant(row: GrantRow, grantedByName?: string, revokedByName?: string | null): AgentResourceGrant {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    grantedBy: row.granted_by,
    ...(grantedByName ? { grantedByName } : {}),
    reason: row.reason,
    createdAt: row.created_at,
    revokedBy: row.revoked_by,
    ...(revokedByName ? { revokedByName } : {}),
    revokedAt: row.revoked_at,
  };
}

function toRequest(
  row: RequestRow,
  agentName?: string,
  resourceName?: string,
  resolvedByName?: string | null,
): AgentResourceAccessRequest {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    ...(agentName ? { agentName } : {}),
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    ...(resourceName ? { resourceName } : {}),
    reason: row.reason,
    status: row.status,
    originChannelId: row.origin_channel_id,
    createdAt: row.created_at,
    resolvedBy: row.resolved_by,
    ...(resolvedByName ? { resolvedByName } : {}),
    resolvedAt: row.resolved_at,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}
