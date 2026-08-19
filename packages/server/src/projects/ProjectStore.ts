import { randomUUID } from "node:crypto";
import type {
  Actor,
  AgentProjectAccess,
  CheckoutStatus,
  FolderAccessMode,
  Project,
  ProjectAccessRequest,
  ProjectAccessStatus,
  ProjectAssignment,
  ProjectKind,
} from "@workspace/shared";
import { sanitizeRemoteUrl } from "@workspace/shared";
import { ApiError } from "../board/BoardService";
import type { ThreadEventStore } from "../chat/ThreadEventStore";
import type { Sql, WorkspaceDb } from "../db";

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/**
 * Logical workspace projects and the explicit agent assignments that grant
 * access to a concrete checkout. Paths stay on the Toolman node.
 */
export class ProjectStore {
  constructor(
    private store: WorkspaceDb,
    private events: ThreadEventStore,
  ) {}

  async list(): Promise<Project[]> {
    const rows = await this.store.sql<ProjectRow[]>`
      ${selectProject(this.store.sql)}
      WHERE p.workspace_id = ${this.store.workspaceId} AND p.archived_at IS NULL
      ORDER BY p.created_at DESC
    `;
    return rows.map(toProject);
  }

  async find(id: string): Promise<Project | null> {
    const [row] = await this.store.sql<ProjectRow[]>`
      ${selectProject(this.store.sql)}
      WHERE p.id = ${id} AND p.workspace_id = ${this.store.workspaceId}
    `;
    return row ? toProject(row) : null;
  }

  async create(
    actor: Actor,
    input: {
      name: string;
      kind: ProjectKind;
      remoteUrl?: string | null;
      defaultBranch?: string | null;
    },
  ): Promise<Project> {
    this.assertHuman(actor);
    const name = input.name.trim();
    if (!PROJECT_NAME.test(name)) {
      throw new ApiError(400, "BAD_NAME", "project names are 1-80 letters, digits, dots, - or _");
    }
    const now = Date.now();
    const id = randomUUID();
    const remoteUrl = input.remoteUrl ? sanitizeRemoteUrl(input.remoteUrl) : null;
    try {
      return await this.store.transaction(async (sql) => {
        await sql`
          INSERT INTO projects (
            id, workspace_id, name, kind, remote_url, default_branch, created_by, created_at, archived_at
          ) VALUES (
            ${id}, ${this.store.workspaceId}, ${name}, ${input.kind}, ${remoteUrl},
            ${input.defaultBranch ?? null}, ${actor.id}, ${now}, NULL
          )
        `;
        await this.events.append(sql, {
          workspaceId: this.store.workspaceId,
          actorId: actor.id,
          kind: "project.created",
          subjectId: id,
          payload: { projectId: id, name, kind: input.kind },
          createdAt: now,
        });
        return (await this.findIn(sql, id))!;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ApiError(409, "NAME_TAKEN", `project ${name} already exists`);
      throw err;
    }
  }

  async archive(actor: Actor, id: string): Promise<Project> {
    this.assertHuman(actor);
    await this.requireOwner(actor, id);
    const now = Date.now();
    return this.store.transaction(async (sql) => {
      const [row] = await sql<ProjectRow[]>`
        UPDATE projects SET archived_at = ${now}
        WHERE id = ${id} AND workspace_id = ${this.store.workspaceId} AND archived_at IS NULL
        RETURNING *
      `;
      if (!row) throw new ApiError(404, "NOT_FOUND", "no such project");
      await this.events.append(sql, {
        workspaceId: this.store.workspaceId,
        actorId: actor.id,
        kind: "project.archived",
        subjectId: id,
        payload: { projectId: id },
        createdAt: now,
      });
      return (await this.findIn(sql, id))!;
    });
  }

  async setAccessMode(actor: Actor, projectId: string, accessMode: FolderAccessMode): Promise<Project> {
    this.assertHuman(actor);
    const now = Date.now();
    return this.store.transaction(async (sql) => {
      const existing = await this.findIn(sql, projectId);
      if (!existing || existing.archivedAt) throw new ApiError(404, "NOT_FOUND", "no such project");
      if (existing.createdBy !== actor.id) {
        throw new ApiError(403, "OWNER_ONLY", "only the folder owner can change its access mode");
      }
      await sql`
        UPDATE projects SET access_mode = ${accessMode}
        WHERE id = ${projectId} AND workspace_id = ${this.store.workspaceId}
      `;
      await this.events.append(sql, {
        workspaceId: this.store.workspaceId,
        actorId: actor.id,
        kind: "project.access_mode.updated",
        subjectId: projectId,
        payload: { projectId, accessMode },
        createdAt: now,
      });
      return (await this.findIn(sql, projectId))!;
    });
  }

  async requestAccess(actor: Actor, projectId: string, reason: string): Promise<ProjectAccessRequest> {
    if (actor.kind !== "agent") throw new ApiError(403, "AGENT_ONLY", "only agents can request project access");
    const trimmed = reason.trim();
    if (!trimmed) throw new ApiError(400, "REASON_REQUIRED", "a reason is required");
    const project = await this.find(projectId);
    if (!project || project.archivedAt) throw new ApiError(404, "NOT_FOUND", "no such project");
    const existing = await this.assignment(projectId, actor.id);
    if (existing) throw new ApiError(409, "ALREADY_ASSIGNED", "agent already has access to this project");
    const now = Date.now();
    const id = randomUUID();
    try {
      return await this.store.transaction(async (sql) => {
        const [row] = await sql<AccessRow[]>`
          INSERT INTO project_access_requests (
            id, workspace_id, project_id, agent_id, reason, status, created_at
          ) VALUES (
            ${id}, ${this.store.workspaceId}, ${projectId}, ${actor.id}, ${trimmed}, 'pending', ${now}
          )
          RETURNING *
        `;
        await this.events.append(sql, {
          workspaceId: this.store.workspaceId,
          actorId: actor.id,
          kind: "project.access.requested",
          subjectId: id,
          payload: { requestId: id, projectId, agentId: actor.id },
          createdAt: now,
        });
        return toAccess(row, actor.displayName);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ApiError(409, "ALREADY_PENDING", "an access request is already pending");
      throw err;
    }
  }

  async resolveAccess(
    actor: Actor,
    requestId: string,
    decision: "approved" | "denied",
    mountId?: string | null,
  ): Promise<ProjectAccessRequest> {
    this.assertHuman(actor);
    const now = Date.now();
    return this.store.transaction(async (sql) => {
      const [pending] = await sql<{ created_by: string }[]>`
        SELECT p.created_by
        FROM project_access_requests r
        JOIN projects p ON p.id = r.project_id
        WHERE r.id = ${requestId}
          AND r.workspace_id = ${this.store.workspaceId}
          AND r.status = 'pending'
      `;
      if (!pending) throw new ApiError(404, "NOT_FOUND", "no pending access request");
      if (pending.created_by !== actor.id) {
        throw new ApiError(403, "OWNER_ONLY", "only the folder owner can resolve its access requests");
      }
      const [row] = await sql<AccessRow[]>`
        UPDATE project_access_requests
        SET status = ${decision}, resolved_by = ${actor.id}, resolved_at = ${now}
        WHERE id = ${requestId} AND workspace_id = ${this.store.workspaceId} AND status = 'pending'
        RETURNING *
      `;
      if (!row) throw new ApiError(404, "NOT_FOUND", "no pending access request");
      if (decision === "approved") {
        await this.insertAssignment(sql, {
          projectId: row.project_id,
          agentId: row.agent_id,
          mountId: mountId ?? null,
          assignedBy: actor.id,
          assignedAt: now,
        });
      }
      await this.events.append(sql, {
        workspaceId: this.store.workspaceId,
        actorId: actor.id,
        kind: "project.access.resolved",
        subjectId: requestId,
        payload: { requestId, decision, projectId: row.project_id, agentId: row.agent_id },
        createdAt: now,
      });
      return toAccess(row);
    });
  }

  async assign(
    actor: Actor,
    input: { projectId: string; agentId: string; mountId?: string | null },
  ): Promise<ProjectAssignment> {
    this.assertHuman(actor);
    await this.requireOwner(actor, input.projectId);
    const now = Date.now();
    return this.store.transaction(async (sql) => {
      const assignment = await this.insertAssignment(sql, {
        ...input,
        assignedBy: actor.id,
        assignedAt: now,
      });
      await this.events.append(sql, {
        workspaceId: this.store.workspaceId,
        actorId: actor.id,
        kind: "project.assignment.granted",
        subjectId: input.projectId,
        payload: { projectId: input.projectId, agentId: input.agentId, mountId: input.mountId },
        createdAt: now,
      });
      return assignment;
    });
  }

  async revoke(actor: Actor, projectId: string, agentId: string): Promise<void> {
    this.assertHuman(actor);
    await this.requireOwner(actor, projectId);
    const now = Date.now();
    await this.store.transaction(async (sql) => {
      const rows = await sql`
        DELETE FROM project_assignments
        WHERE project_id = ${projectId} AND agent_id = ${agentId}
        RETURNING project_id
      `;
      if (rows.length === 0) throw new ApiError(404, "NOT_FOUND", "no such assignment");
      await this.events.append(sql, {
        workspaceId: this.store.workspaceId,
        actorId: actor.id,
        kind: "project.assignment.revoked",
        subjectId: projectId,
        payload: { projectId, agentId },
        createdAt: now,
      });
    });
  }

  async assignment(projectId: string, agentId: string): Promise<ProjectAssignment | null> {
    const [row] = await this.store.sql<AssignmentRow[]>`
      ${selectAssignment(this.store.sql)}
      WHERE a.project_id = ${projectId} AND a.agent_id = ${agentId}
    `;
    return row ? toAssignment(row) : null;
  }

  async assignmentsForAgent(agentId: string): Promise<ProjectAssignment[]> {
    const rows = await this.store.sql<AssignmentRow[]>`
      ${selectAssignment(this.store.sql)}
      WHERE a.agent_id = ${agentId}
      ORDER BY a.assigned_at DESC
    `;
    return rows.map(toAssignment);
  }

  async listAssignments(projectId: string): Promise<ProjectAssignment[]> {
    const rows = await this.store.sql<AssignmentRow[]>`
      ${selectAssignment(this.store.sql)}
      WHERE a.project_id = ${projectId}
      ORDER BY a.assigned_at DESC
    `;
    return rows.map(toAssignment);
  }

  async agentAccess(actor: Actor): Promise<AgentProjectAccess[]> {
    if (actor.kind !== "agent") throw new ApiError(403, "AGENT_ONLY", "only agents have project access records");
    const [projects, assignments, requests] = await Promise.all([
      this.list(),
      this.assignmentsForAgent(actor.id),
      this.pendingAccess(actor),
    ]);
    const assignmentByProject = new Map(assignments.map((assignment) => [assignment.projectId, assignment]));
    const requestByProject = new Map(requests.map((request) => [request.projectId, request]));
    return projects.map((project) => ({
      project,
      assignment: assignmentByProject.get(project.id) ?? null,
      request: requestByProject.get(project.id) ?? null,
    }));
  }

  async pendingAccess(actor: Actor): Promise<ProjectAccessRequest[]> {
    const rows = await this.store.sql<NamedAccessRow[]>`
      SELECT r.*, p.name AS project_name, ag.display_name AS agent_name, res.display_name AS resolved_by_name
      FROM project_access_requests r
      JOIN projects p ON p.id = r.project_id
      JOIN actors ag ON ag.id = r.agent_id
      LEFT JOIN actors res ON res.id = r.resolved_by
      WHERE r.workspace_id = ${this.store.workspaceId}
        AND r.status = 'pending'
        AND ${actor.kind === "human" ? this.store.sql`p.created_by = ${actor.id}` : this.store.sql`r.agent_id = ${actor.id}`}
      ORDER BY r.created_at ASC
    `;
    return rows.map((row) => toAccess(row, row.agent_name, row.resolved_by_name, row.project_name));
  }

  async updateCheckout(
    projectId: string,
    agentId: string,
    patch: {
      checkoutKey?: string;
      branch?: string | null;
      baseRevision?: string | null;
      status: CheckoutStatus;
      lastError?: string | null;
    },
  ): Promise<ProjectAssignment> {
    const now = Date.now();
    return this.store.transaction(async (sql) => {
      const [row] = await sql<AssignmentRow[]>`
        UPDATE project_assignments
        SET checkout_key = COALESCE(${patch.checkoutKey ?? null}, checkout_key),
            branch = COALESCE(${patch.branch ?? null}, branch),
            base_revision = COALESCE(${patch.baseRevision ?? null}, base_revision),
            status = ${patch.status},
            last_error = ${patch.lastError ?? null},
            updated_at = ${now}
        WHERE project_id = ${projectId} AND agent_id = ${agentId}
        RETURNING *
      `;
      if (!row) throw new ApiError(404, "NOT_FOUND", "no such assignment");
      await this.events.append(sql, {
        workspaceId: this.store.workspaceId,
        actorId: agentId,
        kind: "toolman.checkout.updated",
        subjectId: projectId,
        payload: { projectId, agentId, status: patch.status },
        createdAt: now,
      });
      return (await this.findAssignmentIn(sql, projectId, agentId))!;
    });
  }

  async requireOwner(actor: Actor, projectId: string): Promise<Project> {
    this.assertHuman(actor);
    const project = await this.find(projectId);
    if (!project || project.archivedAt) throw new ApiError(404, "NOT_FOUND", "no such project");
    if (project.createdBy !== actor.id) {
      throw new ApiError(403, "OWNER_ONLY", "only the project owner can manage it");
    }
    return project;
  }

  private async insertAssignment(
    sql: Sql,
    input: { projectId: string; agentId: string; mountId?: string | null; assignedBy: string; assignedAt: number },
  ): Promise<ProjectAssignment> {
    if (input.mountId) {
      const mount = await sql<{ id: string; project_id: string }[]>`
        SELECT id, project_id FROM project_mounts WHERE id = ${input.mountId}
      `;
      if (!mount[0] || mount[0].project_id !== input.projectId) {
        throw new ApiError(400, "BAD_MOUNT", "mount does not belong to this project");
      }
    } else {
      const managed = await sql<{ project_id: string }[]>`
        SELECT project_id FROM git_repositories
        WHERE project_id = ${input.projectId} AND workspace_id = ${this.store.workspaceId}
      `;
      if (!managed[0]) throw new ApiError(400, "MOUNT_REQUIRED", "assigning a local folder requires a project mount");
    }
    const agent = await sql<{ id: string; kind: string }[]>`
      SELECT a.id, a.kind FROM actors a
      JOIN workspace_members m ON m.actor_id = a.id AND m.workspace_id = ${this.store.workspaceId}
      WHERE a.id = ${input.agentId}
    `;
    if (!agent[0] || agent[0].kind !== "agent") {
      throw new ApiError(400, "BAD_AGENT", "assignments require a workspace agent");
    }
    try {
      await sql`
        INSERT INTO project_assignments (
          project_id, agent_id, mount_id, assigned_by, assigned_at, checkout_key, status, updated_at
        ) VALUES (
          ${input.projectId}, ${input.agentId}, ${input.mountId ?? null}, ${input.assignedBy},
          ${input.assignedAt}, ${randomUUID()}, 'ready', ${input.assignedAt}
        )
      `;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ApiError(409, "ALREADY_ASSIGNED", "agent already has access to this project");
      throw err;
    }
    return (await this.findAssignmentIn(sql, input.projectId, input.agentId))!;
  }

  private async findAssignmentIn(sql: Sql, projectId: string, agentId: string): Promise<ProjectAssignment | null> {
    const [row] = await sql<AssignmentRow[]>`
      ${selectAssignment(sql)}
      WHERE a.project_id = ${projectId} AND a.agent_id = ${agentId}
    `;
    return row ? toAssignment(row) : null;
  }

  private async findIn(sql: Sql, id: string): Promise<Project | null> {
    const [row] = await sql<ProjectRow[]>`
      ${selectProject(sql)}
      WHERE p.id = ${id} AND p.workspace_id = ${this.store.workspaceId}
    `;
    return row ? toProject(row) : null;
  }

  private assertHuman(actor: Actor): void {
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can manage projects");
  }
}

function selectProject(sql: Sql) {
  return sql`
    SELECT p.*, a.display_name AS created_by_name
    FROM projects p
    JOIN actors a ON a.id = p.created_by
  `;
}

function selectAssignment(sql: Sql) {
  return sql`
    SELECT a.*, ag.display_name AS agent_name, hb.display_name AS assigned_by_name
    FROM project_assignments a
    JOIN actors ag ON ag.id = a.agent_id
    JOIN actors hb ON hb.id = a.assigned_by
  `;
}

interface ProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  kind: ProjectKind;
  remote_url: string | null;
  default_branch: string | null;
  created_by: string;
  created_at: number;
  archived_at: number | null;
  access_mode: FolderAccessMode;
  created_by_name: string;
}

interface AssignmentRow {
  project_id: string;
  agent_id: string;
  mount_id: string | null;
  assigned_by: string;
  assigned_at: number;
  checkout_key: string;
  branch: string | null;
  base_revision: string | null;
  status: CheckoutStatus;
  last_error: string | null;
  updated_at: number;
  agent_name: string;
  assigned_by_name: string;
}

interface AccessRow {
  id: string;
  workspace_id: string;
  project_id: string;
  agent_id: string;
  reason: string;
  status: ProjectAccessStatus;
  created_at: number;
  resolved_by: string | null;
  resolved_at: number | null;
}

interface NamedAccessRow extends AccessRow {
  project_name: string;
  agent_name: string;
  resolved_by_name: string | null;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    kind: row.kind,
    remoteUrl: row.remote_url,
    defaultBranch: row.default_branch,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    accessMode: row.access_mode,
  };
}

function toAssignment(row: AssignmentRow): ProjectAssignment {
  return {
    projectId: row.project_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    mountId: row.mount_id,
    assignedBy: row.assigned_by,
    assignedByName: row.assigned_by_name,
    assignedAt: row.assigned_at,
    checkoutKey: row.checkout_key,
    branch: row.branch,
    baseRevision: row.base_revision,
    status: row.status,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

function toAccess(
  row: AccessRow,
  agentName?: string,
  resolvedByName?: string | null,
  projectName?: string,
): ProjectAccessRequest {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    projectName,
    agentId: row.agent_id,
    agentName,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    resolvedBy: row.resolved_by,
    resolvedByName: resolvedByName ?? undefined,
    resolvedAt: row.resolved_at,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "23505";
}
