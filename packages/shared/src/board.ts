import type { ParticipantKind } from "./participant";

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
  serverId: string;
}

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
  serverId: string;
  /** Human-friendly reference, unique per server, e.g. "task-14". */
  ref: string;
  title: string;
  description: string | null;
  status: ItemStatus;
  /** Who first raised it. */
  origin: ParticipantKind;
  createdBy: string;
  approvedBy: string | null;
  owner: string | null;
  /** Proposal fields, only populated when origin = "agent". */
  proposalWhy: string | null;
  proposalEffect: string | null;
  /**
   * Workspace-relative paths this item authorizes mutations under. An entry
   * ending in "/" grants the subtree; otherwise it grants that exact file.
   * Required on agent proposals; null on human items means unrestricted.
   */
  scopePaths: string[] | null;
  createdAt: number;
  approvedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  deletedAt: number | null;
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
  server_id: string;
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
  | "SCOPE_VIOLATION"; // action path falls outside the item's scope_paths

export type AuthzResult =
  | { allow: true; item: BoardItem }
  | { allow: false; code: AuthzDenyCode; message: string };

export type ToolmanAction =
  | { kind: "read_file"; path: string }
  | { kind: "list_files"; path?: string }
  | { kind: "write_file"; path: string; content: string }
  | { kind: "append_file"; path: string; content: string };
