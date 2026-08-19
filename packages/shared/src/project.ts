/**
 * A shared folder attached to a workspace. The folder is the resource;
 * a registered device is only the transport that can reach it. Concrete
 * paths stay on the Toolman node and are identified here only by opaque keys.
 */

export type ProjectKind = "git" | "directory";
export type CheckoutStatus = "pending" | "ready" | "error" | "offline";
export type ProjectAccessStatus = "pending" | "approved" | "denied";
export type MountCleanliness = "clean" | "dirty" | "unknown";
export type FolderAccessMode = "ask" | "always" | "deny";

export const FOLDER_ACCESS_MODES: readonly FolderAccessMode[] = ["ask", "always", "deny"];

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  kind: ProjectKind;
  remoteUrl: string | null;
  defaultBranch: string | null;
  createdBy: string;
  createdByName?: string;
  createdAt: number;
  archivedAt: number | null;
  /** Owner policy for local-folder operations. Conversation modes cannot widen this. */
  accessMode: FolderAccessMode;
}

export interface ProjectAssignment {
  projectId: string;
  agentId: string;
  agentName?: string;
  mountId: string | null;
  assignedBy: string;
  assignedByName?: string;
  assignedAt: number;
  checkoutKey: string;
  branch: string | null;
  baseRevision: string | null;
  status: CheckoutStatus;
  lastError: string | null;
  updatedAt: number;
}

export interface ProjectAccessRequest {
  id: string;
  workspaceId: string;
  projectId: string;
  projectName?: string;
  agentId: string;
  agentName?: string;
  reason: string;
  status: ProjectAccessStatus;
  createdAt: number;
  resolvedBy: string | null;
  resolvedByName?: string;
  resolvedAt: number | null;
}

export interface AgentProjectAccess {
  project: Project;
  assignment: ProjectAssignment | null;
  request: ProjectAccessRequest | null;
}

export interface ProjectMount {
  id: string;
  projectId: string;
  nodeId: string;
  mountKey: string;
  headRevision: string | null;
  branch: string | null;
  cleanliness: MountCleanliness;
  createdAt: number;
  updatedAt: number;
}
