import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  JsonValue,
  WorkspaceAccessRequest,
  WorkspaceAccessRequestStatus,
  WorkspaceInvite,
  WorkspaceInvitePreview,
  WorkspaceRole,
  WorkspaceSummary,
} from "@workspace/shared";
import { ApiError } from "../board/BoardService";
import type { Sql } from "../db";
import type { AccountIdentity, AccountStore } from "./AccountStore";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OWNED_WORKSPACES = 20;
const MAX_PENDING_REQUESTS = 20;
const MAX_ACTIVE_INVITES = 50;
const WORKSPACE_NAME_PATTERN = /^[^\p{C}]{1,80}$/u;

export class WorkspaceAccess {
  constructor(
    private sql: Sql,
    private accounts: AccountStore,
  ) {}

  async createWorkspace(actor: AccountIdentity, rawName: string): Promise<WorkspaceSummary> {
    const name = workspaceName(rawName);
    const workspace = {
      id: randomUUID(),
      name,
      publicCode: publicCode(),
      createdAt: Date.now(),
    };
    await this.sql.begin(async (tx) => {
      const sql = tx as unknown as Sql;
      await sql`SELECT id FROM actors WHERE id = ${actor.id} FOR UPDATE`;
      const [{ count }] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM workspace_members
        WHERE actor_id = ${actor.id} AND role = 'owner'
      `;
      if (count >= MAX_OWNED_WORKSPACES) {
        throw new ApiError(409, "WORKSPACE_LIMIT", `an account can own at most ${MAX_OWNED_WORKSPACES} workspaces`);
      }
      await sql`
        INSERT INTO workspaces (id, name, public_code, created_by, created_at, updated_at)
        VALUES (${workspace.id}, ${workspace.name}, ${workspace.publicCode}, ${actor.id}, ${workspace.createdAt}, ${workspace.createdAt})
      `;
      await sql`
        INSERT INTO workspace_members (workspace_id, actor_id, role, joined_at)
        VALUES (${workspace.id}, ${actor.id}, 'owner', ${workspace.createdAt})
      `;
      await sql`
        INSERT INTO channels (id, workspace_id, name, created_by, is_demo, created_at)
        VALUES (${randomUUID()}, ${workspace.id}, 'general', ${actor.id}, false, ${workspace.createdAt})
      `;
      await appendAccessEvent(sql, workspace.id, actor.id, "workspace.created", {
        workspaceId: workspace.id,
        name: workspace.name,
      });
    });
    return {
      id: workspace.id,
      name: workspace.name,
      publicCode: workspace.publicCode,
      role: "owner",
      joinedAt: workspace.createdAt,
    };
  }

  async lookup(rawCode: string): Promise<{ id: string; name: string; publicCode: string } | null> {
    const [row] = await this.sql<{ id: string; name: string; public_code: string }[]>`
      SELECT id, name, public_code FROM workspaces
      WHERE public_code = ${normalizeCode(rawCode)}
    `;
    return row ? { id: row.id, name: row.name, publicCode: row.public_code } : null;
  }

  async requestAccess(
    actor: AccountIdentity,
    rawCode: string,
    rawMessage?: string,
  ): Promise<WorkspaceAccessRequest> {
    const workspace = await this.lookup(rawCode);
    if (!workspace) throw new ApiError(404, "WORKSPACE_NOT_FOUND", "no workspace has that code");
    if (await this.accounts.role(workspace.id, actor.id)) {
      throw new ApiError(409, "ALREADY_MEMBER", "you already belong to this workspace");
    }
    const message = optionalMessage(rawMessage);
    const now = Date.now();
    return this.sql.begin(async (tx) => {
      const sql = tx as unknown as Sql;
      const [existing] = await sql`
        SELECT id FROM workspace_access_requests
        WHERE workspace_id = ${workspace.id} AND requester_id = ${actor.id} AND status = 'pending'
        FOR UPDATE
      `;
      if (!existing) {
        await sql`SELECT id FROM actors WHERE id = ${actor.id} FOR UPDATE`;
        const [{ count }] = await sql<{ count: number }[]>`
          SELECT count(*)::int AS count FROM workspace_access_requests
          WHERE requester_id = ${actor.id} AND status = 'pending'
        `;
        if (count >= MAX_PENDING_REQUESTS) {
          throw new ApiError(409, "ACCESS_REQUEST_LIMIT", `an account can have at most ${MAX_PENDING_REQUESTS} pending requests`);
        }
      }
      const [row] = await sql<AccessRequestRow[]>`
        INSERT INTO workspace_access_requests (
          id, workspace_id, requester_id, message, status, created_at, resolved_by, resolved_at
        ) VALUES (
          ${randomUUID()}, ${workspace.id}, ${actor.id}, ${message}, 'pending', ${now}, NULL, NULL
        )
        ON CONFLICT (workspace_id, requester_id) WHERE status = 'pending'
        DO UPDATE SET message = EXCLUDED.message
        RETURNING *
      `;
      await appendAccessEvent(sql, workspace.id, actor.id, "workspace.access_requested", {
        requestId: row.id,
        requesterId: actor.id,
      });
      return toAccessRequest(row, workspace.name, actor.displayName);
    }) as Promise<WorkspaceAccessRequest>;
  }

  async listRequestsForActor(actorId: string): Promise<WorkspaceAccessRequest[]> {
    const rows = await this.sql<JoinedAccessRequestRow[]>`
      SELECT r.*, w.name AS workspace_name, a.display_name AS requester_name
      FROM workspace_access_requests r
      JOIN workspaces w ON w.id = r.workspace_id
      JOIN actors a ON a.id = r.requester_id
      WHERE r.requester_id = ${actorId}
      ORDER BY r.created_at DESC
    `;
    return rows.map((row) => toAccessRequest(row, row.workspace_name, row.requester_name));
  }

  async listRequests(workspaceId: string, actorId: string): Promise<WorkspaceAccessRequest[]> {
    await this.requireOwner(workspaceId, actorId);
    const rows = await this.sql<JoinedAccessRequestRow[]>`
      SELECT r.*, w.name AS workspace_name, a.display_name AS requester_name
      FROM workspace_access_requests r
      JOIN workspaces w ON w.id = r.workspace_id
      JOIN actors a ON a.id = r.requester_id
      WHERE r.workspace_id = ${workspaceId}
      ORDER BY (r.status = 'pending') DESC, r.created_at DESC
    `;
    return rows.map((row) => toAccessRequest(row, row.workspace_name, row.requester_name));
  }

  async resolveRequest(
    workspaceId: string,
    requestId: string,
    actorId: string,
    decision: "approved" | "denied",
  ): Promise<WorkspaceAccessRequest> {
    await this.requireOwner(workspaceId, actorId);
    const now = Date.now();
    return this.sql.begin(async (tx) => {
      const sql = tx as unknown as Sql;
      let [row] = await sql<JoinedAccessRequestRow[]>`
        UPDATE workspace_access_requests r
        SET status = ${decision}, resolved_by = ${actorId}, resolved_at = ${now}
        FROM workspaces w, actors a
        WHERE r.id = ${requestId}
          AND r.workspace_id = ${workspaceId}
          AND r.status = 'pending'
          AND w.id = r.workspace_id
          AND a.id = r.requester_id
        RETURNING r.*, w.name AS workspace_name, a.display_name AS requester_name
      `;
      if (!row) {
        [row] = await sql<JoinedAccessRequestRow[]>`
          SELECT r.*, w.name AS workspace_name, a.display_name AS requester_name
          FROM workspace_access_requests r
          JOIN workspaces w ON w.id = r.workspace_id
          JOIN actors a ON a.id = r.requester_id
          WHERE r.id = ${requestId} AND r.workspace_id = ${workspaceId}
        `;
        if (!row || row.status !== decision) {
          throw new ApiError(404, "REQUEST_NOT_FOUND", "no matching access request with that id");
        }
        return toAccessRequest(row, row.workspace_name, row.requester_name);
      }
      if (decision === "approved") {
        await sql`
          INSERT INTO workspace_members (workspace_id, actor_id, role, joined_at)
          VALUES (${workspaceId}, ${row.requester_id}, 'member', ${now})
          ON CONFLICT (workspace_id, actor_id) DO NOTHING
        `;
      }
      await appendAccessEvent(sql, workspaceId, actorId, `workspace.access_${decision}`, {
        requestId,
        requesterId: row.requester_id,
      });
      return toAccessRequest(row, row.workspace_name, row.requester_name);
    }) as Promise<WorkspaceAccessRequest>;
  }

  async createInvite(workspaceId: string, actorId: string): Promise<{ invite: WorkspaceInvite; token: string }> {
    await this.requireOwner(workspaceId, actorId);
    const token = randomBytes(32).toString("hex");
    const now = Date.now();
    return this.sql.begin(async (tx) => {
      const sql = tx as unknown as Sql;
      await sql`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
      const [{ count }] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM workspace_invites
        WHERE workspace_id = ${workspaceId}
          AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at > ${now}
      `;
      if (count >= MAX_ACTIVE_INVITES) {
        throw new ApiError(409, "INVITE_LIMIT", `a workspace can have at most ${MAX_ACTIVE_INVITES} active invites`);
      }
      const [row] = await sql<InviteRow[]>`
        INSERT INTO workspace_invites (
          id, workspace_id, token_hash, created_by, created_at, expires_at,
          consumed_by, consumed_at, revoked_at
        ) VALUES (
          ${randomUUID()}, ${workspaceId}, ${hashToken(token)}, ${actorId}, ${now},
          ${now + INVITE_TTL_MS}, NULL, NULL, NULL
        )
        RETURNING *
      `;
      await appendAccessEvent(sql, workspaceId, actorId, "workspace.invite_created", {
        inviteId: row.id,
      });
      return { invite: toInvite(row), token };
    }) as Promise<{ invite: WorkspaceInvite; token: string }>;
  }

  async listInvites(workspaceId: string, actorId: string): Promise<WorkspaceInvite[]> {
    await this.requireOwner(workspaceId, actorId);
    const rows = await this.sql<InviteRow[]>`
      SELECT * FROM workspace_invites
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC
    `;
    return rows.map(toInvite);
  }

  async revokeInvite(workspaceId: string, inviteId: string, actorId: string): Promise<boolean> {
    await this.requireOwner(workspaceId, actorId);
    return this.sql.begin(async (tx) => {
      const sql = tx as unknown as Sql;
      const rows = await sql`
        UPDATE workspace_invites SET revoked_at = ${Date.now()}
        WHERE id = ${inviteId} AND workspace_id = ${workspaceId}
          AND revoked_at IS NULL AND consumed_at IS NULL
        RETURNING id
      `;
      if (rows.length > 0) {
        await appendAccessEvent(sql, workspaceId, actorId, "workspace.invite_revoked", {
          inviteId,
        });
      }
      return rows.length > 0;
    }) as Promise<boolean>;
  }

  async previewInvite(token: string): Promise<WorkspaceInvitePreview | null> {
    const [row] = await this.sql<InvitePreviewRow[]>`
      SELECT w.id AS workspace_id, w.name AS workspace_name,
             a.display_name AS inviter_name, i.expires_at
      FROM workspace_invites i
      JOIN workspaces w ON w.id = i.workspace_id
      JOIN actors a ON a.id = i.created_by
      WHERE i.token_hash = ${hashToken(token)}
        AND i.revoked_at IS NULL
        AND i.consumed_at IS NULL
        AND i.expires_at > ${Date.now()}
    `;
    return row
      ? {
          workspace: { id: row.workspace_id, name: row.workspace_name },
          inviterName: row.inviter_name,
          expiresAt: row.expires_at,
        }
      : null;
  }

  async acceptInvite(actor: AccountIdentity, token: string): Promise<WorkspaceSummary> {
    const now = Date.now();
    return this.sql.begin(async (tx) => {
      const sql = tx as unknown as Sql;
      const [invite] = await sql<InviteAcceptStateRow[]>`
        SELECT i.workspace_id, i.consumed_by, i.consumed_at, i.revoked_at, i.expires_at,
               w.name, w.public_code
        FROM workspace_invites i
        JOIN workspaces w ON w.id = i.workspace_id
        WHERE i.token_hash = ${hashToken(token)}
        FOR UPDATE
      `;
      if (!invite || invite.revoked_at || invite.expires_at <= now) {
        throw new ApiError(410, "INVITE_UNAVAILABLE", "this invite is invalid, expired, or already used");
      }
      if (invite.consumed_by && invite.consumed_by !== actor.id) {
        throw new ApiError(410, "INVITE_UNAVAILABLE", "this invite is invalid, expired, or already used");
      }
      if (!invite.consumed_at) {
        await sql`
          UPDATE workspace_invites
          SET consumed_by = ${actor.id}, consumed_at = ${now}
          WHERE token_hash = ${hashToken(token)} AND workspace_id = ${invite.workspace_id}
        `;
      }
      await sql`
        INSERT INTO workspace_members (workspace_id, actor_id, role, joined_at)
        VALUES (${invite.workspace_id}, ${actor.id}, 'member', ${now})
        ON CONFLICT (workspace_id, actor_id) DO NOTHING
      `;
      const [membership] = await sql<{ role: WorkspaceRole; joined_at: number }[]>`
        SELECT role, joined_at FROM workspace_members
        WHERE workspace_id = ${invite.workspace_id} AND actor_id = ${actor.id}
      `;
      if (!invite.consumed_at) {
        await appendAccessEvent(sql, invite.workspace_id, actor.id, "workspace.invite_accepted", {
          actorId: actor.id,
        });
      }
      return {
        id: invite.workspace_id,
        name: invite.name,
        publicCode: invite.public_code,
        role: membership.role,
        joinedAt: membership.joined_at,
      };
    }) as Promise<WorkspaceSummary>;
  }

  async setRole(
    workspaceId: string,
    targetId: string,
    role: WorkspaceRole,
    actorId: string,
  ): Promise<void> {
    await this.requireOwner(workspaceId, actorId);
    await this.sql.begin(async (tx) => {
      const sql = tx as unknown as Sql;
      if (targetId === actorId && role !== "owner") {
        await this.requireAnotherOwner(workspaceId, actorId, sql);
      }
      const rows = await sql`
        UPDATE workspace_members m SET role = ${role}
        FROM actors a
        WHERE m.workspace_id = ${workspaceId} AND m.actor_id = ${targetId}
          AND a.id = m.actor_id AND a.kind = 'human'
        RETURNING m.actor_id
      `;
      if (rows.length === 0) throw new ApiError(404, "MEMBER_NOT_FOUND", "no such human workspace member");
      await appendAccessEvent(sql, workspaceId, actorId, "workspace.member_role_changed", {
        actorId: targetId,
        role,
      });
    });
  }

  async removeMember(workspaceId: string, targetId: string, actorId: string): Promise<void> {
    const self = targetId === actorId;
    if (!self) await this.requireOwner(workspaceId, actorId);
    await this.sql.begin(async (tx) => {
      const sql = tx as unknown as Sql;
      const [target] = await sql<{ role: WorkspaceRole; kind: "human" | "agent" }[]>`
        SELECT m.role, a.kind
        FROM workspace_members m
        JOIN actors a ON a.id = m.actor_id
        WHERE m.workspace_id = ${workspaceId} AND m.actor_id = ${targetId}
        FOR UPDATE
      `;
      if (!target) throw new ApiError(404, "MEMBER_NOT_FOUND", "no such workspace member");
      if (target.kind !== "human") {
        throw new ApiError(409, "AGENT_MEMBER", "remove agents through the agent settings flow");
      }
      if (target.role === "owner") await this.requireAnotherOwner(workspaceId, targetId, sql);
      await sql`
        DELETE FROM workspace_members WHERE workspace_id = ${workspaceId} AND actor_id = ${targetId}
      `;
      await appendAccessEvent(sql, workspaceId, actorId, "workspace.member_removed", {
        actorId: targetId,
      });
    });
  }

  private async requireOwner(workspaceId: string, actorId: string): Promise<void> {
    if ((await this.accounts.role(workspaceId, actorId)) !== "owner") {
      throw new ApiError(403, "OWNER_ONLY", "only workspace owners can do that");
    }
  }

  private async requireAnotherOwner(
    workspaceId: string,
    actorId: string,
    sql: Sql = this.sql,
  ): Promise<void> {
    const rows = await sql<{ actor_id: string }[]>`
      SELECT actor_id FROM workspace_members
      WHERE workspace_id = ${workspaceId} AND role = 'owner'
      FOR UPDATE
    `;
    if (!rows.some((row) => row.actor_id !== actorId)) {
      throw new ApiError(409, "LAST_OWNER", "add another owner before removing the last owner");
    }
  }
}

interface AccessRequestRow {
  id: string;
  workspace_id: string;
  requester_id: string;
  message: string | null;
  status: WorkspaceAccessRequestStatus;
  created_at: number;
  resolved_by: string | null;
  resolved_at: number | null;
}

interface JoinedAccessRequestRow extends AccessRequestRow {
  workspace_name: string;
  requester_name: string;
}

interface InviteRow {
  id: string;
  workspace_id: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  consumed_by: string | null;
  consumed_at: number | null;
  revoked_at: number | null;
}

interface InvitePreviewRow {
  workspace_id: string;
  workspace_name: string;
  inviter_name: string;
  expires_at: number;
}

interface InviteAcceptStateRow {
  workspace_id: string;
  name: string;
  public_code: string;
  consumed_by: string | null;
  consumed_at: number | null;
  revoked_at: number | null;
  expires_at: number;
}

function workspaceName(raw: string): string {
  const name = raw.trim();
  if (!WORKSPACE_NAME_PATTERN.test(name)) {
    throw new ApiError(400, "BAD_WORKSPACE_NAME", "workspace names are 1-80 visible characters");
  }
  return name;
}

function optionalMessage(raw?: string): string | null {
  const message = raw?.trim() ?? "";
  if (message.length > 500) throw new ApiError(400, "MESSAGE_TOO_LONG", "access request messages are limited to 500 characters");
  return message || null;
}

function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

function publicCode(): string {
  return `CV-${randomBytes(5).toString("hex").toUpperCase()}`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toAccessRequest(
  row: AccessRequestRow,
  workspaceName: string,
  requesterName: string,
): WorkspaceAccessRequest {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName,
    requesterId: row.requester_id,
    requesterName,
    message: row.message,
    status: row.status,
    createdAt: row.created_at,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
  };
}

function toInvite(row: InviteRow): WorkspaceInvite {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedBy: row.consumed_by,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
  };
}

async function appendAccessEvent(
  sql: Sql,
  workspaceId: string,
  actorId: string,
  kind: string,
  payload: Record<string, JsonValue>,
): Promise<void> {
  await sql`
    INSERT INTO thread_events (
      id, workspace_id, actor_id, kind, payload, created_at
    ) VALUES (
      ${randomUUID()}, ${workspaceId}, ${actorId}, ${kind}, ${sql.json(payload)}, ${Date.now()}
    )
  `;
}
