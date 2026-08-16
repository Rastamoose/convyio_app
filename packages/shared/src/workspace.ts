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

export const WORKSPACE_INVITE_MAX_AGE_SECONDS = [1_800, 3_600, 21_600, 43_200, 86_400, 604_800] as const;
export const WORKSPACE_INVITE_MAX_USES = [0, 1, 5, 10, 25, 50, 100] as const;
export type WorkspaceInviteMaxAgeSeconds = (typeof WORKSPACE_INVITE_MAX_AGE_SECONDS)[number];
export type WorkspaceInviteMaxUses = (typeof WORKSPACE_INVITE_MAX_USES)[number];

export const DEFAULT_WORKSPACE_INVITE_OPTIONS = {
  maxAgeSeconds: 604_800,
  maxUses: 0,
} as const satisfies WorkspaceInviteOptions;

export interface WorkspaceInviteOptions {
  maxAgeSeconds: WorkspaceInviteMaxAgeSeconds;
  maxUses: WorkspaceInviteMaxUses;
}

export interface WorkspaceInvite {
  id: string;
  workspaceId: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  uses: number;
  maxUses: number;
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
