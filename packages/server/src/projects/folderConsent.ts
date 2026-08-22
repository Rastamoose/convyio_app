import type { AuthzDenyCode, Project } from "@workspace/shared";

export type FolderConsent =
  | { allow: true }
  | { allow: false; code: AuthzDenyCode; message: string }
  | { prompt: true };

/**
 * Layer 3 for local folders. The board and conversation mode never widen this:
 * deny refuses, always is durable consent, and ask prompts the owner.
 *
 * "ask" used to hard-fail with OWNER_OFFLINE unless the owner's websocket was
 * connected at the exact moment of the request — a stricter, synchronous-only
 * bar than every other approval in the system, which durably waits up to
 * APPROVAL_TIMEOUT_MS for anyone to respond. That mismatch was a real source
 * of "unavailable because owner is offline" failures for actions that would
 * have succeeded a minute later. Prompting always and letting the normal
 * interaction-approval wait handle timing out is consistent with the rest of
 * the gate, and a mount that's genuinely unreachable still fails clearly at
 * execution time with CHECKOUT_UNAVAILABLE.
 */
export function folderConsent(project: Project): FolderConsent {
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
