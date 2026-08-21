export type ResourceKind =
  | "board"
  | "workspace_guidance"
  | "agent_notebook"
  | "channel"
  | "git_project"
  | "local_project"
  | "workspace_file";

export type ProtectedResourceKind = Extract<
  ResourceKind,
  "channel" | "git_project" | "local_project" | "workspace_file"
>;

export type ResourceAccessState = "default" | "granted" | "pending" | "none";
export type ResourceAccessStatus = "pending" | "approved" | "denied";
export type ContextNoteScope = "workspace" | "agent";

export interface ContextNote {
  id: string;
  workspaceId: string;
  scope: ContextNoteScope;
  agentId: string | null;
  body: string;
  createdBy: string;
  createdByName?: string;
  createdAt: number;
  supersededBy: string | null;
}

export interface ResourceManifestEntry {
  id: string;
  kind: ResourceKind;
  name: string;
  ownerId: string | null;
  ownerName?: string;
  status: "active" | "archived" | "offline";
  access: ResourceAccessState;
  updatedAt: number;
}

export interface AgentResourceManifest {
  workspaceId: string;
  seq: number;
  generatedAt: number;
  resources: ResourceManifestEntry[];
}

export interface AgentResourceGrant {
  id: string;
  workspaceId: string;
  agentId: string;
  resourceKind: ProtectedResourceKind;
  resourceId: string;
  grantedBy: string;
  grantedByName?: string;
  reason: string;
  createdAt: number;
  revokedBy: string | null;
  revokedByName?: string;
  revokedAt: number | null;
}

export interface AgentResourceAccessRequest {
  id: string;
  workspaceId: string;
  agentId: string;
  agentName?: string;
  resourceKind: ProtectedResourceKind;
  resourceId: string;
  resourceName?: string;
  reason: string;
  status: ResourceAccessStatus;
  originChannelId: string | null;
  createdAt: number;
  resolvedBy: string | null;
  resolvedByName?: string;
  resolvedAt: number | null;
}
