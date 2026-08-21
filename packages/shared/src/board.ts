import type { ManagedAgent, ParticipantKind } from "./participant";
import type { ProjectAction } from "./toolman";

/**
 * The canonical board. Items authorize scopes of work, not steps. Every item
 * is created or approved by a human; agents may only propose. The toolman
 * refuses mutating actions that lack a backing workable item, which makes the
 * board a permission boundary rather than a tracker.
 */

export interface Actor {
  id: string;
  kind: ParticipantKind;
  displayName: string;
  workspaceId: string;
  managedAgent?: ManagedAgent;
}

/**
 * What a board item lets an agent do, beyond where it may do it. `file_write`
 * is bounded by scopePaths; `shell_repo` cannot be (a shell command's writes
 * are not statically knowable), so it is a deliberate coarse grant over the
 * whole sandboxed workspace; `network` is separate because installs and pushes
 * reach outside the machine.
 */
export type WorkCapability = "file_write" | "shell_repo" | "network";

export const WORK_CAPABILITIES: readonly WorkCapability[] = [
  "file_write",
  "shell_repo",
  "network",
];

/** Legacy items predate capabilities and authorized file writes only. */
export const DEFAULT_CAPABILITIES: readonly WorkCapability[] = ["file_write"];

export type ItemStatus =
  | "proposed" // agent-raised, inert, awaiting human decision
  | "denied" // terminal, retained for audit
  | "approved" // workable, not yet started
  | "in_progress" // agent actively executing
  | "blocked" // agent halted, waiting on a human
  | "done";

/** Statuses under which the toolman authorizes mutating work. */
export const WORKABLE_STATUSES: ReadonlySet<ItemStatus> = new Set([
  "approved",
  "in_progress",
]);

export interface BoardItem {
  id: string;
  workspaceId: string;
  /** Human-friendly reference, unique per workspace, e.g. "task-14". */
  ref: string;
  title: string;
  description: string | null;
  status: ItemStatus;
  /** Who first raised it. */
  origin: ParticipantKind;
  createdBy: string;
  approvedBy: string | null;
  owner: string | null;
  planId: string | null;
  acceptanceCriteria: string[];
  verificationEvidence: string | null;
  impactMap: import("./context").EcosystemImpact | null;
  /** Proposal fields, only populated when origin = "agent". */
  proposalWhy: string | null;
  proposalEffect: string | null;
  /**
   * Workspace-relative paths this item authorizes mutations under. An entry
   * ending in "/" grants the subtree; otherwise it grants that exact file.
   * Required on agent proposals; null on human items means unrestricted.
   * Paths are relative to the item's project root when `projectId` is set.
   */
  scopePaths: string[] | null;
  /**
   * Project this item authorizes. Required for Toolman project mutations;
   * null on existing items and demos that are not project-scoped.
   */
  projectId: string | null;
  /**
   * Classes of mutation this item authorizes. Paths alone cannot bound a shell
   * command, so coarse capabilities sit beside the path scope. null means the
   * legacy default of file writes only — never shell or network.
   */
  capabilities: WorkCapability[] | null;
  createdAt: number;
  approvedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  deletedAt: number | null;
  originChannelId?: string | null;
  originChannelName?: string;
  originEventId?: string | null;
  /** Denormalized display names for rendering. */
  createdByName?: string;
  approvedByName?: string;
  ownerName?: string;
}

// ---------------------------------------------------------------------------
// Board events: append-only audit trail and realtime feed both.
// ---------------------------------------------------------------------------

export type BoardEventType =
  | "item.created"
  | "item.proposed"
  | "item.approved"
  | "item.denied"
  | "item.started"
  | "item.blocked"
  | "item.unblocked"
  | "item.completed"
  | "item.edited"
  | "item.deleted"
  | "item.reopened";

/** Reason a human gave when denying or blocking an item. */
export interface ReasonPayload {
  reason?: string;
}

/** Field-level diff attached to item.edited events. */
export interface EditedPayload {
  changed: Record<string, { from: unknown; to: unknown }>;
}

export type BoardEventPayload = ReasonPayload | EditedPayload | Record<string, never>;

export interface BoardEventEnvelope {
  channel: "board";
  type: BoardEventType;
  workspace_id: string;
  actor: { id: string; kind: ParticipantKind; display_name: string };
  item: BoardItem;
  payload: BoardEventPayload;
  ts: string;
}

/** One row of an item's audit trail, as served by the activity endpoint. */
export interface BoardItemEvent {
  id: number;
  type: BoardEventType;
  actorId: string;
  actorName: string;
  actorKind: ParticipantKind;
  payload: BoardEventPayload;
  createdAt: number;
}

export function isBoardEnvelope(event: unknown): event is BoardEventEnvelope {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as { channel?: unknown }).channel === "board"
  );
}

// ---------------------------------------------------------------------------
// Toolman authorization contract.
// ---------------------------------------------------------------------------

export type AuthzDenyCode =
  | "NO_BOARD_REF" // agent supplied no board_item_ref
  | "ITEM_NOT_FOUND"
  | "ITEM_WRONG_SERVER"
  | "ITEM_NOT_WORKABLE" // status not approved | in_progress
  | "ITEM_DELETED"
  | "SCOPE_VIOLATION" // action path falls outside the item's scope_paths
  | "OWNER_MISMATCH" // acting agent is not the ticket owner
  | "CAPABILITY_MISSING" // item's grant does not cover this class of action
  | "PROJECT_REQUIRED" // mutating project action has no project
  | "PROJECT_MISMATCH" // action project is not the item's project
  | "PROJECT_UNASSIGNED" // agent has no assignment for the project
  | "CHECKOUT_UNAVAILABLE" // assigned checkout is not ready or its node is offline
  | "OWNER_OFFLINE" // folder owner is not online; local access is unavailable
  | "FOLDER_DENIED" // folder owner set the folder to deny
  | "UNKNOWN_ACTION" // action is not classified and therefore ungrantable
  | "PLAN_MODE" // conversation is in plan mode; nothing may mutate
  | "APPROVAL_DENIED" // a human declined the permission request
  | "APPROVAL_UNAVAILABLE" // approval could not be recorded — fail closed
  | "HUMAN_ONLY"; // this class of action is structurally human-only, regardless of granted capability

export type AuthzResult =
  | { allow: true; item?: BoardItem }
  | { allow: false; code: AuthzDenyCode; message: string };

export type ToolmanAction =
  | { kind: "read_file"; path: string }
  | { kind: "list_files"; path?: string }
  | { kind: "write_file"; path: string; content: string }
  | { kind: "append_file"; path: string; content: string }
  | { kind: "run_shell"; command: string }
  | { kind: "search_files"; query: string; path?: string }
  | ProjectAction;

/**
 * Which capability each action class consumes. Absent from this map = mutating
 * and ungrantable, so new tools fail closed until they are classified.
 */
export const ACTION_CAPABILITY: Readonly<Record<string, WorkCapability>> = {
  write_file: "file_write",
  append_file: "file_write",
  run_shell: "shell_repo",
  project_write_file: "file_write",
  project_edit_file: "file_write",
  project_delete_file: "file_write",
  project_move_file: "file_write",
  project_run_command: "shell_repo",
  project_git_fetch: "shell_repo",
  project_git_pull: "shell_repo",
  project_git_push: "shell_repo",
  project_git_branch: "shell_repo",
  project_git_commit: "shell_repo",
};
