import type { AuthzDenyCode, Project } from "@workspace/shared";

export type FolderConsent =
  | { allow: true }
  | { allow: false; code: AuthzDenyCode; message: string }
  | { prompt: true };

/**
 * Layer 3 for local folders. The board and conversation mode never widen this:
 * deny refuses, always is durable consent, and ask requires the owner online.
 */
export function folderConsent(project: Project, ownerOnline: boolean): FolderConsent {
  if (project.accessMode === "deny") {
    return {
      allow: false,
      code: "FOLDER_DENIED",
      message: `${project.name}'s owner has denied local access`,
    };
  }
  if (project.accessMode === "always") return { allow: true };
  if (!ownerOnline) {
    return {
      allow: false,
      code: "OWNER_OFFLINE",
      message: `${project.name} is unavailable because its owner is offline`,
    };
  }
  return { prompt: true };
}
