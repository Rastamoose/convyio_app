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
      await sql`
        UPDATE toolman_pairings
        SET revoked_at = ${now}
        WHERE workspace_id = ${this.store.workspaceId}
          AND node_name = ${name}
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
          AND n.revoked_at IS NULL
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
          SET token_hash = ${hashToken(installationToken)}, last_connected_at = ${now}
          WHERE id = ${nodeRow.id}
        `;
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

  async revokeInstallation(token: string): Promise<boolean> {
    const rows = await this.store.sql`
      UPDATE toolman_nodes SET revoked_at = ${Date.now()}
      WHERE token_hash = ${hashToken(token)} AND revoked_at IS NULL
      RETURNING id
    `;
    return rows.length > 0;
  }

  async revoke(actor: Actor, nodeId: string): Promise<ToolmanNodeSummary> {
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can revoke Toolman nodes");
    const now = Date.now();
    return this.store.transaction(async (sql) => {
      const [row] = await sql<NodeRow[]>`
        UPDATE toolman_nodes SET revoked_at = ${now}
        WHERE id = ${nodeId} AND workspace_id = ${this.store.workspaceId} AND revoked_at IS NULL
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
        SELECT * FROM project_mounts WHERE node_id = ${nodeId} AND mount_key = ${report.mountKey}
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

  async findMountById(mountId: string): Promise<ProjectMount | null> {
    return this.findMount(this.store.sql, mountId);
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
      WHERE p.workspace_id = ${this.store.workspaceId} AND p.name = ${name} AND p.archived_at IS NULL
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
