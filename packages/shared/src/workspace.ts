export type WorkspaceRole = "owner" | "member";

export interface WorkspaceSummary {
  id: string;
  name: string;
  publicCode: string;
  role: WorkspaceRole;
  joinedAt: number;
}

export type AccountSession =
  | { status: "needs_username" }
  | { status: "ok"; username: string; workspaces: WorkspaceSummary[] };

export type WorkspaceAccessRequestStatus = "pending" | "approved" | "denied";

export interface WorkspaceAccessRequest {
  id: string;
  workspaceId: string;
  workspaceName: string;
  requesterId: string;
  requesterName: string;
  message: string | null;
  status: WorkspaceAccessRequestStatus;
  createdAt: number;
  resolvedBy: string | null;
  resolvedAt: number | null;
}

export interface WorkspaceInvite {
  id: string;
  workspaceId: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  consumedBy: string | null;
  consumedAt: number | null;
  revokedAt: number | null;
}

export interface WorkspaceInvitePreview {
  workspace: { id: string; name: string };
  inviterName: string;
  expiresAt: number;
}

export interface WorkspaceMember {
  actorId: string;
  displayName: string;
  kind: "human" | "agent";
  role: WorkspaceRole;
  joinedAt: number;
}
