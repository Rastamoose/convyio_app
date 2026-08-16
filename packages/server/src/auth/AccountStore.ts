import type { Actor, WorkspaceMember, WorkspaceRole, WorkspaceSummary } from "@workspace/shared";
import type { Sql } from "../db";

export interface AccountIdentity {
  id: string;
  kind: "human";
  displayName: string;
  email: string | null;
}

export class AccountStore {
  constructor(readonly sql: Sql) {}

  async getHuman(id: string): Promise<AccountIdentity | null> {
    const [row] = await this.sql<IdentityRow[]>`
      SELECT id, kind, display_name, email
      FROM actors
      WHERE id = ${id} AND kind = 'human'
    `;
    return row ? toIdentity(row) : null;
  }

  async findHumanByName(displayName: string): Promise<AccountIdentity | null> {
    const [row] = await this.sql<IdentityRow[]>`
      SELECT id, kind, display_name, email
      FROM actors
      WHERE kind = 'human' AND lower(display_name) = lower(${displayName})
    `;
    return row ? toIdentity(row) : null;
  }

  async createHuman(id: string, displayName: string, email: string | null): Promise<AccountIdentity> {
    const [row] = await this.sql<IdentityRow[]>`
      INSERT INTO actors (id, kind, display_name, email)
      VALUES (${id}, 'human', ${displayName}, ${email})
      RETURNING id, kind, display_name, email
    `;
    return toIdentity(row);
  }

  async listWorkspaces(actorId: string): Promise<WorkspaceSummary[]> {
    const rows = await this.sql<WorkspaceSummaryRow[]>`
      SELECT w.id, w.name, w.public_code, m.role, m.joined_at
      FROM workspace_members m
      JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.actor_id = ${actorId}
      ORDER BY m.joined_at ASC, w.name ASC
    `;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      publicCode: row.public_code,
      role: row.role,
      joinedAt: row.joined_at,
    }));
  }

  async actorForWorkspace(actorId: string, workspaceId: string): Promise<Actor | null> {
    const [row] = await this.sql<IdentityRow[]>`
      SELECT a.id, a.kind, a.display_name, a.email
      FROM workspace_members m
      JOIN actors a ON a.id = m.actor_id
      WHERE m.workspace_id = ${workspaceId} AND m.actor_id = ${actorId} AND a.kind = 'human'
    `;
    return row
      ? { id: row.id, kind: row.kind, displayName: row.display_name, workspaceId }
      : null;
  }

  async role(workspaceId: string, actorId: string): Promise<WorkspaceRole | null> {
    const [row] = await this.sql<{ role: WorkspaceRole }[]>`
      SELECT role FROM workspace_members
      WHERE workspace_id = ${workspaceId} AND actor_id = ${actorId}
    `;
    return row?.role ?? null;
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    const rows = await this.sql<MemberRow[]>`
      SELECT a.id AS actor_id, a.display_name, a.kind, m.role, m.joined_at
      FROM workspace_members m
      JOIN actors a ON a.id = m.actor_id
      WHERE m.workspace_id = ${workspaceId}
      ORDER BY lower(a.display_name), a.id
    `;
    return rows.map((row) => ({
      actorId: row.actor_id,
      displayName: row.display_name,
      kind: row.kind,
      role: row.role,
      joinedAt: row.joined_at,
    }));
  }
}

interface IdentityRow {
  id: string;
  kind: "human";
  display_name: string;
  email: string | null;
}

interface WorkspaceSummaryRow {
  id: string;
  name: string;
  public_code: string;
  role: WorkspaceRole;
  joined_at: number;
}

interface MemberRow {
  actor_id: string;
  display_name: string;
  kind: "human" | "agent";
  role: WorkspaceRole;
  joined_at: number;
}

function toIdentity(row: IdentityRow): AccountIdentity {
  return { id: row.id, kind: "human", displayName: row.display_name, email: row.email };
}
