import type {
  Actor,
  AgentResourceManifest,
  ProtectedResourceKind,
  ResourceAccessState,
  ResourceManifestEntry,
} from "@workspace/shared";
import type { WorkspaceDb } from "../db";
import type { ResourceAccessStore } from "./ResourceAccessStore";

interface ChannelRow {
  id: string;
  name: string;
  created_by: string | null;
  owner_name: string | null;
  created_at: number;
  archived_at: number | null;
}

interface ProjectRow {
  id: string;
  name: string;
  kind: "git" | "directory";
  created_by: string;
  owner_name: string;
  created_at: number;
  archived_at: number | null;
}

export class ResourceManifestBuilder {
  constructor(
    private store: WorkspaceDb,
    private access: ResourceAccessStore,
  ) {}

  async build(actor: Actor): Promise<AgentResourceManifest> {
    if (actor.kind !== "agent") throw new Error("resource manifests are agent-scoped");
    const [seqRow, channels, projects, grants, requests, assignments, projectRequests] = await Promise.all([
      this.store.sql<{ seq: number | null }[]>`
        SELECT max(seq) AS seq FROM thread_events WHERE workspace_id = ${this.store.workspaceId}
      `,
      this.store.sql<ChannelRow[]>`
        SELECT c.id, c.name, c.created_by, owner.display_name AS owner_name,
          c.created_at, c.archived_at
        FROM channels c
        LEFT JOIN actors owner ON owner.id = c.created_by
        WHERE c.workspace_id = ${this.store.workspaceId}
        ORDER BY c.created_at ASC, c.seq ASC
      `,
      this.store.sql<ProjectRow[]>`
        SELECT p.id, p.name, p.kind, p.created_by, owner.display_name AS owner_name,
          p.created_at, p.archived_at
        FROM projects p
        JOIN actors owner ON owner.id = p.created_by
        WHERE p.workspace_id = ${this.store.workspaceId}
        ORDER BY p.created_at ASC
      `,
      this.access.grantsForAgent(actor.id),
      this.access.requestsForAgent(actor.id),
      this.store.sql<{ project_id: string; kind: "git" | "directory" }[]>`
        SELECT a.project_id, p.kind
        FROM project_assignments a
        JOIN projects p ON p.id = a.project_id
        WHERE p.workspace_id = ${this.store.workspaceId} AND a.agent_id = ${actor.id}
      `,
      this.store.sql<{ project_id: string; kind: "git" | "directory" }[]>`
        SELECT r.project_id, p.kind
        FROM project_access_requests r
        JOIN projects p ON p.id = r.project_id
        WHERE r.workspace_id = ${this.store.workspaceId} AND r.agent_id = ${actor.id} AND r.status = 'pending'
      `,
    ]);
    const granted = new Set(grants.map((grant) => key(grant.resourceKind, grant.resourceId)));
    for (const assignment of assignments) {
      granted.add(key(assignment.kind === "git" ? "git_project" : "local_project", assignment.project_id));
    }
    const pending = new Set(
      requests
        .filter((request) => request.status === "pending")
        .map((request) => key(request.resourceKind, request.resourceId)),
    );
    for (const request of projectRequests) {
      pending.add(key(request.kind === "git" ? "git_project" : "local_project", request.project_id));
    }
    const state = (kind: ProtectedResourceKind, id: string): ResourceAccessState =>
      granted.has(key(kind, id)) ? "granted" : pending.has(key(kind, id)) ? "pending" : "none";
    const resources: ResourceManifestEntry[] = [
      defaultEntry("board", "Canonical Board", actor.id),
      defaultEntry("workspace_guidance", "Workspace guidance", actor.id),
      defaultEntry("agent_notebook", `${actor.displayName} notebook`, actor.id),
      ...channels.map((channel): ResourceManifestEntry => ({
        id: channel.id,
        kind: "channel",
        name: channel.name,
        ownerId: channel.created_by,
        ...(channel.owner_name ? { ownerName: channel.owner_name } : {}),
        status: channel.archived_at === null ? "active" : "archived",
        access: state("channel", channel.id),
        updatedAt: channel.archived_at ?? channel.created_at,
      })),
      ...projects.map((project): ResourceManifestEntry => {
        const kind = project.kind === "git" ? "git_project" : "local_project";
        return {
          id: project.id,
          kind,
          name: project.name,
          ownerId: project.created_by,
          ownerName: project.owner_name,
          status: project.archived_at === null ? "active" : "archived",
          access: state(kind, project.id),
          updatedAt: project.archived_at ?? project.created_at,
        };
      }),
    ];
    return {
      workspaceId: this.store.workspaceId,
      seq: seqRow[0]?.seq ?? 0,
      generatedAt: Date.now(),
      resources,
    };
  }
}

function defaultEntry(
  kind: "board" | "workspace_guidance" | "agent_notebook",
  name: string,
  agentId: string,
): ResourceManifestEntry {
  return {
    id: kind === "agent_notebook" ? agentId : kind,
    kind,
    name,
    ownerId: kind === "agent_notebook" ? agentId : null,
    status: "active",
    access: "default",
    updatedAt: 0,
  };
}

function key(kind: ProtectedResourceKind, id: string): string {
  return `${kind}:${id}`;
}
