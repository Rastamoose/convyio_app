import type { AuthzDenyCode, Project } from "@workspace/shared";

export type FolderConsent =
  | { allow: true }
  | { allow: false; code: AuthzDenyCode; message: string }
  | { prompt: true };

/**
 * Layer 3 for local folders. The board and conversation mode never widen this:
 * the folder owner must be online, and their mode decides whether Toolman asks.
 */
export function folderConsent(project: Project, ownerOnline: boolean): FolderConsent {
  if (!ownerOnline) {
    return {
      allow: false,
      code: "OWNER_OFFLINE",
      message: `${project.name} is unavailable because its owner is offline`,
    };
  }
  if (project.accessMode === "deny") {
    return {
      allow: false,
      code: "FOLDER_DENIED",
      message: `${project.name}'s owner has denied local access`,
    };
  }
  if (project.accessMode === "always") return { allow: true };
  return { prompt: true };
}
