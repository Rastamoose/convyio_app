import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  Actor,
  FolderAccessMode,
  MountCleanliness,
  Project,
  ProjectKind,
  ProjectMount,
  ToolmanInstallation,
  ToolmanNodeSummary,
  ToolmanPairing,
  ToolmanPairingResponse,
} from "@workspace/shared";
import { sanitizeRemoteUrl } from "@workspace/shared";
import { ApiError } from "../board/BoardService";
import type { ThreadEventStore } from "../chat/ThreadEventStore";
import type { Sql, WorkspaceDb } from "../db";
const TOKEN_BYTES = 32;
const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;
const NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Machine-level Toolman identity: pairing codes, durable node tokens, and
 * the project mounts those nodes advertise. Live health stays in memory.
 */
export class ToolmanNodes {
  constructor(
    private store: WorkspaceDb,
    private events: ThreadEventStore,
    private pairingTtlMs = DEFAULT_PAIRING_TTL_MS,
  ) {}

  async createPairing(actor: Actor, nodeName: string): Promise<ToolmanPairingResponse> {
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can pair Toolman nodes");
    const name = nodeName.trim();
    if (!NODE_NAME.test(name)) {
      throw new ApiError(400, "BAD_NAME", "node names are 1-80 letters, digits, dots, - or _");
    }
    const pairingCode = randomBytes(TOKEN_BYTES).toString("hex");
    const now = Date.now();
    const pairing = await this.store.transaction(async (sql) => {
      const [collision] = await sql<{ id: string }[]>`
        SELECT id FROM toolman_nodes
        WHERE workspace_id = ${this.store.workspaceId}
          AND name = ${name}
          AND created_by <> ${actor.id}
      `;
      const [pendingCollision] = await sql<{ id: string }[]>`
        SELECT id FROM toolman_pairings
        WHERE workspace_id = ${this.store.workspaceId}
          AND node_name = ${name}
          AND created_by <> ${actor.id}
          AND consumed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > ${now}
      `;
      if (collision || pendingCollision) {
        throw new ApiError(409, "NAME_TAKEN", `another member already paired a device named ${name}`);
      }
      await sql`
        UPDATE toolman_pairings
        SET revoked_at = ${now}
        WHERE workspace_id = ${this.store.workspaceId}
          AND node_name = ${name}
          AND created_by = ${actor.id}
          AND consumed_at IS NULL
          AND revoked_at IS NULL
      `;
      const [row] = await sql<PairingRow[]>`
        INSERT INTO toolman_pairings (
          id, workspace_id, node_name, token_hash, created_by, created_at, expires_at
        ) VALUES (
          ${randomUUID()}, ${this.store.workspaceId}, ${name}, ${hashToken(pairingCode)},
          ${actor.id}, ${now}, ${now + this.pairingTtlMs}
        )
        RETURNING *
      `;
      return toPairing(row);
    });
    return { pairing, pairingCode };
  }

  async exchangePairing(pairingCode: string): Promise<{
    node: ToolmanNodeSummary;
    installation: ToolmanInstallation;
    installationToken: string;
  } | null> {
    const installationToken = randomBytes(TOKEN_BYTES).toString("hex");
    const now = Date.now();
    return this.store.transaction(async (sql) => {
      const [consumed] = await sql<PairingRow[]>`
        UPDATE toolman_pairings
        SET consumed_at = ${now}
        WHERE token_hash = ${hashToken(pairingCode)}
          AND workspace_id = ${this.store.workspaceId}
          AND consumed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > ${now}
        RETURNING *
      `;
      if (!consumed) return null;
      const existing = await sql<NodeRow[]>`
        SELECT n.*, a.display_name AS created_by_name
        FROM toolman_nodes n
        JOIN actors a ON a.id = n.created_by
        WHERE n.workspace_id = ${this.store.workspaceId}
          AND n.name = ${consumed.node_name}
          AND n.created_by = ${consumed.created_by}
        FOR UPDATE
      `;
      let nodeRow = existing[0];
      if (!nodeRow) {
        const id = randomUUID();
        await sql`
          INSERT INTO toolman_nodes (
            id, workspace_id, name, token_hash, created_by, created_at, last_connected_at
          ) VALUES (
            ${id}, ${this.store.workspaceId}, ${consumed.node_name}, ${hashToken(installationToken)},
            ${consumed.created_by}, ${now}, ${now}
          )
        `;
        nodeRow = (await sql<NodeRow[]>`
          SELECT n.*, a.display_name AS created_by_name
          FROM toolman_nodes n JOIN actors a ON a.id = n.created_by
          WHERE n.id = ${id}
        `)[0];
      } else {
        await sql`
          UPDATE toolman_nodes
          SET token_hash = ${hashToken(installationToken)},
              last_connected_at = ${now},
              revoked_at = NULL
          WHERE id = ${nodeRow.id}
        `;
        nodeRow = (await sql<NodeRow[]>`
          SELECT n.*, a.display_name AS created_by_name
          FROM toolman_nodes n JOIN actors a ON a.id = n.created_by
          WHERE n.id = ${nodeRow.id}
        `)[0];
      }
      await this.events.append(sql, {
        workspaceId: this.store.workspaceId,
        actorId: consumed.created_by,
        kind: "toolman.node.paired",
        subjectId: nodeRow.id,
        payload: { nodeId: nodeRow.id, name: nodeRow.name },
        createdAt: now,
      });
      return {
        node: toNode(nodeRow, "checking"),
        installation: { id: nodeRow.id, nodeId: nodeRow.id, createdAt: now },
        installationToken,
      };
    });
  }

  async resolveInstallation(token: string): Promise<{ node: ToolmanNodeSummary } | null> {
    const now = Date.now();
    const [row] = await this.store.sql<NodeRow[]>`
      UPDATE toolman_nodes n
      SET last_connected_at = ${now}
      FROM actors a
      WHERE n.token_hash = ${hashToken(token)}
        AND n.workspace_id = ${this.store.workspaceId}
        AND n.revoked_at IS NULL
        AND a.id = n.created_by
      RETURNING n.*, a.display_name AS created_by_name
    `;
    return row ? { node: toNode(row, "ready") } : null;
  }

  async revokeInstallation(token: string): Promise<string | null> {
    const [row] = await this.store.sql<{ id: string }[]>`
      UPDATE toolman_nodes SET revoked_at = ${Date.now()}
      WHERE token_hash = ${hashToken(token)} AND revoked_at IS NULL
      RETURNING id
    `;
    return row?.id ?? null;
  }

  async revoke(actor: Actor, nodeId: string): Promise<ToolmanNodeSummary> {
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can revoke Toolman nodes");
    const now = Date.now();
    return this.store.transaction(async (sql) => {
      const [row] = await sql<NodeRow[]>`
        UPDATE toolman_nodes SET revoked_at = ${now}
        WHERE id = ${nodeId}
          AND workspace_id = ${this.store.workspaceId}
          AND created_by = ${actor.id}
          AND revoked_at IS NULL
        RETURNING *
      `;
      if (!row) throw new ApiError(404, "NOT_FOUND", "no such Toolman node");
      await this.events.append(sql, {
        workspaceId: this.store.workspaceId,
        actorId: actor.id,
        kind: "toolman.node.revoked",
        subjectId: nodeId,
        payload: { nodeId },
        createdAt: now,
      });
      return toNode({ ...row, created_by_name: actor.displayName }, "revoked");
    });
  }

  async removeNode(actor: Actor, nodeId: string): Promise<ToolmanNodeSummary> {
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can remove Toolman nodes");
    const now = Date.now();
    return this.store.transaction(async (sql) => {
      const [node] = await sql<NodeRow[]>`
        SELECT n.*, a.display_name AS created_by_name
        FROM toolman_nodes n
        JOIN actors a ON a.id = n.created_by
        WHERE n.id = ${nodeId}
          AND n.workspace_id = ${this.store.workspaceId}
          AND n.created_by = ${actor.id}
        FOR UPDATE
      `;
      if (!node) throw new ApiError(404, "NOT_FOUND", "no such Toolman node");
      if (!node.revoked_at) {
        throw new ApiError(409, "NODE_NOT_REVOKED", "revoke the device before deleting it");
      }
      const mounts = await sql<OwnedMountRow[]>`
        SELECT m.*, p.created_by, p.kind AS project_kind
        FROM project_mounts m
        JOIN projects p ON p.id = m.project_id
        WHERE m.node_id = ${nodeId}
          AND p.workspace_id = ${this.store.workspaceId}
        ORDER BY m.created_at
        FOR UPDATE
      `;
      for (const mount of mounts) await this.removeMountIn(sql, mount, actor.id, now);
      await sql`UPDATE tool_executions SET node_id = NULL WHERE node_id = ${nodeId}`;
      await sql`DELETE FROM toolman_nodes WHERE id = ${nodeId}`;
      await this.events.append(sql, {
        workspaceId: this.store.workspaceId,
        actorId: actor.id,
        kind: "toolman.node.removed",
        subjectId: nodeId,
        payload: { nodeId, removedMounts: mounts.length },
        createdAt: now,
      });
      return toNode(node, "revoked");
    });
  }

  async list(): Promise<ToolmanNodeSummary[]> {
    const rows = await this.store.sql<NodeRow[]>`
      SELECT n.*, a.display_name AS created_by_name
      FROM toolman_nodes n JOIN actors a ON a.id = n.created_by
      WHERE n.workspace_id = ${this.store.workspaceId}
      ORDER BY n.created_at DESC
    `;
    return rows.map((row) => toNode(row, row.revoked_at ? "revoked" : "offline"));
  }

  async registerMount(
    nodeId: string,
    report: {
      mountKey: string;
      projectName: string;
      kind: ProjectKind;
      remoteUrl?: string | null;
      defaultBranch?: string | null;
      headRevision?: string | null;
      branch?: string | null;
      cleanliness?: MountCleanliness;
    },
  ): Promise<{ project: Project; mount: ProjectMount }> {
    const node = await this.requireActiveNode(nodeId);
    const now = Date.now();
    return this.store.transaction(async (sql) => {
      let project = await this.findProjectByName(sql, report.projectName);
      if (project && (project.createdBy !== node.createdBy || project.kind !== report.kind)) {
        throw new ApiError(409, "NAME_TAKEN", `another project already uses the name ${report.projectName}`);
      }
      if (project?.archivedAt) {
        await sql`
          UPDATE projects SET archived_at = NULL
          WHERE id = ${project.id} AND workspace_id = ${this.store.workspaceId}
        `;
        await this.events.append(sql, {
          workspaceId: this.store.workspaceId,
          actorId: node.createdBy,
          kind: "project.reactivated",
          subjectId: project.id,
          payload: { projectId: project.id, name: project.name },
          createdAt: now,
        });
        project = await this.findProjectByName(sql, report.projectName);
      }
      if (!project) {
        const projectId = randomUUID();
        const remoteUrl = report.remoteUrl ? sanitizeRemoteUrl(report.remoteUrl) : null;
        await sql`
          INSERT INTO projects (
            id, workspace_id, name, kind, remote_url, default_branch, created_by, created_at
          ) VALUES (
            ${projectId}, ${this.store.workspaceId}, ${report.projectName}, ${report.kind},
            ${remoteUrl}, ${report.defaultBranch ?? null}, ${node.createdBy}, ${now}
          )
        `;
        await this.events.append(sql, {
          workspaceId: this.store.workspaceId,
          actorId: node.createdBy,
          kind: "project.created",
          subjectId: projectId,
          payload: { projectId, name: report.projectName, kind: report.kind },
          createdAt: now,
        });
        project = (await this.findProjectByName(sql, report.projectName))!;
      }
      const existing = await sql<MountRow[]>`
        SELECT * FROM project_mounts WHERE node_id = ${nodeId} AND project_id = ${project.id}
      `;
      let mountId = existing[0]?.id;
      if (mountId) {
        await sql`
          UPDATE project_mounts
          SET head_revision = ${report.headRevision ?? null},
              branch = ${report.branch ?? null},
              cleanliness = ${report.cleanliness ?? "unknown"},
              updated_at = ${now}
          WHERE id = ${mountId}
        `;
      } else {
        mountId = randomUUID();
        await sql`
          INSERT INTO project_mounts (
            id, project_id, node_id, mount_key, head_revision, branch, cleanliness, created_at, updated_at
          ) VALUES (
            ${mountId}, ${project.id}, ${nodeId}, ${report.mountKey}, ${report.headRevision ?? null},
            ${report.branch ?? null}, ${report.cleanliness ?? "unknown"}, ${now}, ${now}
          )
        `;
      }
      await this.events.append(sql, {
        workspaceId: this.store.workspaceId,
        actorId: node.createdBy,
        kind: existing[0] ? "toolman.mount.updated" : "toolman.mount.registered",
        subjectId: mountId,
        payload: { mountId, projectId: project.id, nodeId },
        createdAt: now,
      });
      const mount = (await this.findMount(sql, mountId))!;
      return { project, mount };
    });
  }

  async removeMount(
    actor: Actor,
    projectId: string,
    mountId: string,
  ): Promise<{ mount: ProjectMount; projectArchived: boolean }> {
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can remove folders");
    const now = Date.now();
    return this.store.transaction(async (sql) => {
      const [row] = await sql<OwnedMountRow[]>`
        SELECT m.*, p.created_by, p.kind AS project_kind
        FROM project_mounts m
        JOIN projects p ON p.id = m.project_id
        WHERE m.id = ${mountId}
          AND m.project_id = ${projectId}
          AND p.workspace_id = ${this.store.workspaceId}
        FOR UPDATE
      `;
      if (!row) throw new ApiError(404, "NOT_FOUND", "no such folder mount");
      if (row.created_by !== actor.id) {
        throw new ApiError(403, "OWNER_ONLY", "only the folder owner can remove it");
      }
      return this.removeMountIn(sql, row, actor.id, now);
    });
  }

  async removeMountFromNode(
    nodeId: string,
    mountKey: string,
  ): Promise<{ mount: ProjectMount; projectArchived: boolean }> {
    const node = await this.requireActiveNode(nodeId);
    const now = Date.now();
    return this.store.transaction(async (sql) => {
      const [row] = await sql<OwnedMountRow[]>`
        SELECT m.*, p.created_by, p.kind AS project_kind
        FROM project_mounts m
        JOIN projects p ON p.id = m.project_id
        WHERE m.node_id = ${nodeId}
          AND m.mount_key = ${mountKey}
          AND p.workspace_id = ${this.store.workspaceId}
        FOR UPDATE
      `;
      if (!row) throw new ApiError(404, "NOT_FOUND", "no such folder mount");
      if (row.created_by !== node.createdBy) {
        throw new ApiError(403, "OWNER_ONLY", "the node does not own this folder");
      }
      return this.removeMountIn(sql, row, node.createdBy, now);
    });
  }

  async findMountById(mountId: string): Promise<ProjectMount | null> {
    return this.findMount(this.store.sql, mountId);
  }

  async findActiveMountById(mountId: string): Promise<ProjectMount | null> {
    const [row] = await this.store.sql<MountRow[]>`
      SELECT m.*
      FROM project_mounts m
      JOIN projects p ON p.id = m.project_id
      JOIN toolman_nodes n ON n.id = m.node_id
      WHERE m.id = ${mountId}
        AND p.workspace_id = ${this.store.workspaceId}
        AND n.workspace_id = ${this.store.workspaceId}
        AND p.archived_at IS NULL
        AND n.revoked_at IS NULL
    `;
    return row ? toMount(row) : null;
  }

  async mountsForProject(projectId: string): Promise<ProjectMount[]> {
    const rows = await this.store.sql<MountRow[]>`
      SELECT * FROM project_mounts WHERE project_id = ${projectId}
      ORDER BY created_at DESC
    `;
    return rows.map(toMount);
  }

  async mountsForNode(nodeId: string): Promise<ProjectMount[]> {
    const rows = await this.store.sql<MountRow[]>`
      SELECT * FROM project_mounts WHERE node_id = ${nodeId}
      ORDER BY created_at DESC
    `;
    return rows.map(toMount);
  }

  private async removeMountIn(
    sql: Sql,
    row: OwnedMountRow,
    actorId: string,
    now: number,
  ): Promise<{ mount: ProjectMount; projectArchived: boolean }> {
    await sql`UPDATE tool_executions SET mount_id = NULL WHERE mount_id = ${row.id}`;
    await sql`DELETE FROM project_mounts WHERE id = ${row.id}`;
    const [remaining] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM project_mounts WHERE project_id = ${row.project_id}
    `;
    const projectArchived = remaining.count === 0 && row.project_kind === "directory";
    if (projectArchived) {
      await sql`
        UPDATE projects SET archived_at = ${now}
        WHERE id = ${row.project_id} AND workspace_id = ${this.store.workspaceId}
      `;
      await sql`
        UPDATE project_access_requests
        SET status = 'denied', resolved_by = ${actorId}, resolved_at = ${now}
        WHERE project_id = ${row.project_id}
          AND workspace_id = ${this.store.workspaceId}
          AND status = 'pending'
      `;
    }
    await this.events.append(sql, {
      workspaceId: this.store.workspaceId,
      actorId,
      kind: "toolman.mount.removed",
      subjectId: row.id,
      payload: {
        mountId: row.id,
        projectId: row.project_id,
        nodeId: row.node_id,
        projectArchived,
      },
      createdAt: now,
    });
    return { mount: toMount(row), projectArchived };
  }

  private async requireActiveNode(nodeId: string): Promise<ToolmanNodeSummary> {
    const [row] = await this.store.sql<NodeRow[]>`
      SELECT n.*, a.display_name AS created_by_name
      FROM toolman_nodes n JOIN actors a ON a.id = n.created_by
      WHERE n.id = ${nodeId} AND n.workspace_id = ${this.store.workspaceId} AND n.revoked_at IS NULL
    `;
    if (!row) throw new ApiError(401, "UNAUTHENTICATED", "Toolman node is not active");
    return toNode(row, "ready");
  }

  private async findProjectByName(sql: Sql, name: string): Promise<Project | null> {
    const [row] = await sql<ProjectRow[]>`
      SELECT p.*, a.display_name AS created_by_name
      FROM projects p JOIN actors a ON a.id = p.created_by
      WHERE p.workspace_id = ${this.store.workspaceId} AND p.name = ${name}
    `;
    return row
      ? {
          id: row.id,
          workspaceId: row.workspace_id,
          name: row.name,
          kind: row.kind,
          remoteUrl: row.remote_url ? sanitizeRemoteUrl(row.remote_url) : null,
          defaultBranch: row.default_branch,
          createdBy: row.created_by,
          createdByName: row.created_by_name,
          createdAt: row.created_at,
          archivedAt: row.archived_at,
          accessMode: row.access_mode,
        }
      : null;
  }

  private async findMount(sql: Sql, id: string): Promise<ProjectMount | null> {
    const [row] = await sql<MountRow[]>`SELECT * FROM project_mounts WHERE id = ${id}`;
    return row ? toMount(row) : null;
  }
}

interface PairingRow {
  id: string;
  workspace_id: string;
  node_name: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
  revoked_at: number | null;
}

interface NodeRow {
  id: string;
  workspace_id: string;
  name: string;
  created_by: string;
  created_at: number;
  last_connected_at: number | null;
  revoked_at: number | null;
  created_by_name: string;
}

interface MountRow {
  id: string;
  project_id: string;
  node_id: string;
  mount_key: string;
  head_revision: string | null;
  branch: string | null;
  cleanliness: MountCleanliness;
  created_at: number;
  updated_at: number;
}

interface OwnedMountRow extends MountRow {
  created_by: string;
  project_kind: ProjectKind;
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

function toPairing(row: PairingRow): ToolmanPairing {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    nodeName: row.node_name,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
  };
}

function toNode(row: NodeRow, health: ToolmanNodeSummary["health"]): ToolmanNodeSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    lastConnectedAt: row.last_connected_at,
    revokedAt: row.revoked_at,
    health,
  };
}

function toMount(row: MountRow): ProjectMount {
  return {
    id: row.id,
    projectId: row.project_id,
    nodeId: row.node_id,
    mountKey: row.mount_key,
    headRevision: row.head_revision,
    branch: row.branch,
    cleanliness: row.cleanliness,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
