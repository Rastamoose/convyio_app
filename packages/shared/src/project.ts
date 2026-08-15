/**
 * Logical workspace resources an agent can be assigned. A project is not a
 * checkout: concrete paths stay on a Toolman node and are identified here
 * only by opaque keys.
 */

export type ProjectKind = "git" | "directory";
export type CheckoutStatus = "pending" | "ready" | "error" | "offline";
export type ProjectAccessStatus = "pending" | "approved" | "denied";
export type MountCleanliness = "clean" | "dirty" | "unknown";

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
}

export interface ProjectAssignment {
  projectId: string;
  agentId: string;
  agentName?: string;
  mountId: string;
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
  agentId: string;
  agentName?: string;
  reason: string;
  status: ProjectAccessStatus;
  createdAt: number;
  resolvedBy: string | null;
  resolvedByName?: string;
  resolvedAt: number | null;
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
