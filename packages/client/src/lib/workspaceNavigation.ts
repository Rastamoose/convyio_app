import type { WorkspaceSummary } from "@workspace/shared";

export const LAST_WORKSPACE_KEY = "convyio:last-workspace";
export const PENDING_INVITE_KEY = "convyio:pending-invite";

export function workspaceIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/w\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function inviteTokenFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/invite\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function pendingInviteToken(pathname: string, storage: Storage): string | null {
  const routeToken = inviteTokenFromPath(pathname);
  if (routeToken) {
    storage.setItem(PENDING_INVITE_KEY, routeToken);
    return routeToken;
  }
  return pathname === "/" ? storage.getItem(PENDING_INVITE_KEY) : null;
}

export function chooseInitialWorkspace(
  workspaces: WorkspaceSummary[],
  pathname: string,
  lastWorkspaceId: string | null,
): string | null {
  const routeId = workspaceIdFromPath(pathname);
  if (routeId) return workspaces.some((workspace) => workspace.id === routeId) ? routeId : null;
  if (workspaces.length === 1) return workspaces[0].id;
  if (lastWorkspaceId && workspaces.some((workspace) => workspace.id === lastWorkspaceId)) {
    return lastWorkspaceId;
  }
  return null;
}

export function workspacePath(workspaceId: string): string {
  return `/w/${encodeURIComponent(workspaceId)}`;
}

export function invitePath(token: string): string {
  return `/invite/${encodeURIComponent(token)}`;
}
