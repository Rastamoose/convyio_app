import { randomUUID } from "node:crypto";
import type {
  Actor,
  BoardEventEnvelope,
  BoardEventPayload,
  BoardEventType,
  BoardItem,
  BoardItemEvent,
  ItemStatus,
} from "@workspace/shared";
import type { WorkspaceDb } from "../db";
import { validateScopePaths } from "./scope";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * All board state changes flow through here. Each transition mutates
 * board_items and appends exactly one board_events row in the same
 * transaction (I5), then hands the envelope to the fan-out hook.
 */
export class BoardService {
  /** Realtime fan-out hook; invoked after the transaction commits. */
  onEvent: ((envelope: BoardEventEnvelope) => void) | null = null;

  constructor(private store: WorkspaceDb) {}

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  list(
    serverId: string,
    opts: { status?: ItemStatus; includeDeleted?: boolean } = {},
  ): BoardItem[] {
    const clauses = ["i.server_id = ?"];
    const params: (string | number)[] = [serverId];
    if (opts.status) {
      clauses.push("i.status = ?");
      params.push(opts.status);
    } else if (!opts.includeDeleted) {
      // Default view excludes denied alongside deleted.
      clauses.push("i.status != 'denied'");
    }
    if (!opts.includeDeleted) clauses.push("i.deleted_at IS NULL");
    const rows = this.store.db
      .prepare(`${SELECT_ITEM} WHERE ${clauses.join(" AND ")} ORDER BY i.created_at DESC`)
      .all(...params) as unknown as ItemRow[];
    return rows.map(toItem);
  }

  /** Look up by uuid or ref within a server. Includes deleted rows. */
  find(serverId: string, idOrRef: string): BoardItem | null {
    const row = this.store.db
      .prepare(`${SELECT_ITEM} WHERE i.server_id = ? AND (i.id = ? OR i.ref = ?)`)
      .get(serverId, idOrRef, idOrRef) as ItemRow | undefined;
    return row ? toItem(row) : null;
  }

  /** Cross-server lookup used by authz to distinguish WRONG_SERVER. */
  findAnywhere(idOrRef: string): BoardItem | null {
    const row = this.store.db
      .prepare(`${SELECT_ITEM} WHERE i.id = ? OR i.ref = ?`)
      .get(idOrRef, idOrRef) as ItemRow | undefined;
    return row ? toItem(row) : null;
  }

  /** An item's audit trail, oldest first (the events table is append-only). */
  events(serverId: string, idOrRef: string): BoardItemEvent[] {
    const item = this.find(serverId, idOrRef);
    if (!item) throw new ApiError(404, "ITEM_NOT_FOUND", `no board item ${idOrRef}`);
    const rows = this.store.db
      .prepare(
        `SELECT e.id, e.type, e.actor_id, e.payload, e.created_at,
                a.display_name AS actor_name, a.kind AS actor_kind
         FROM board_events e JOIN actors a ON a.id = e.actor_id
         WHERE e.item_id = ? ORDER BY e.id ASC`,
      )
      .all(item.id) as unknown as {
      id: number;
      type: BoardItemEvent["type"];
      actor_id: string;
      payload: string;
      created_at: number;
      actor_name: string;
      actor_kind: BoardItemEvent["actorKind"];
    }[];
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      actorId: r.actor_id,
      actorName: r.actor_name,
      actorKind: r.actor_kind,
      payload: JSON.parse(r.payload) as BoardEventPayload,
      createdAt: r.created_at,
    }));
  }

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  /** Human create (approved by construction) or agent proposal (I2). */
  create(
    actor: Actor,
    input: {
      title: string;
      description?: string;
      why?: string;
      effect?: string;
      scopePaths?: string[];
    },
  ): BoardItem {
    const human = actor.kind === "human";
    if (!human && (!input.why || !input.effect)) {
      throw new ApiError(400, "PROPOSAL_FIELDS_REQUIRED", "agent proposals require why and effect");
    }
    // Agent proposals must name the paths they intend to touch, so approval
    // grants a bounded scope instead of unrestricted workspace access.
    if (!human && (!input.scopePaths || input.scopePaths.length === 0)) {
      throw new ApiError(400, "SCOPE_REQUIRED", "agent proposals require non-empty scope_paths");
    }
    const scopePaths = this.normalizedScope(input.scopePaths);
    const now = Date.now();
    const id = randomUUID();
    return this.mutate(actor, human ? "item.created" : "item.proposed", () => {
      const ref = this.store.nextRef(actor.serverId);
      this.store.db
        .prepare(
          `INSERT INTO board_items
             (id, server_id, ref, title, description, status, origin, created_by,
              approved_by, owner, proposal_why, proposal_effect, scope_paths,
              created_at, approved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          actor.serverId,
          ref,
          input.title,
          input.description ?? null,
          human ? "approved" : "proposed",
          actor.kind,
          actor.id,
          human ? actor.id : null,
          null,
          human ? null : input.why!,
          human ? null : input.effect!,
          scopePaths ? JSON.stringify(scopePaths) : null,
          now,
          human ? now : null,
        );
      return id;
    });
  }

  approve(actor: Actor, idOrRef: string): BoardItem {
    this.assertHuman(actor, "AGENT_CANNOT_APPROVE");
    const item = this.mustFind(actor.serverId, idOrRef);
    this.assertStatus(item, ["proposed"]);
    return this.mutate(actor, "item.approved", () => {
      this.store.db
        .prepare(`UPDATE board_items SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?`)
        .run(actor.id, Date.now(), item.id);
      return item.id;
    });
  }

  deny(actor: Actor, idOrRef: string, reason?: string): BoardItem {
    this.assertHuman(actor, "AGENT_CANNOT_APPROVE");
    const item = this.mustFind(actor.serverId, idOrRef);
    this.assertStatus(item, ["proposed"]);
    return this.mutate(actor, "item.denied", () => {
      this.store.db
        .prepare(`UPDATE board_items SET status = 'denied' WHERE id = ?`)
        .run(item.id);
      return item.id;
    }, reason ? { reason } : {});
  }

  start(actor: Actor, idOrRef: string): BoardItem {
    const item = this.mustFind(actor.serverId, idOrRef);
    this.assertStatus(item, ["approved"]);
    return this.mutate(actor, "item.started", () => {
      this.store.db
        .prepare(
          `UPDATE board_items SET status = 'in_progress', started_at = ?,
             owner = COALESCE(owner, ?) WHERE id = ?`,
        )
        .run(Date.now(), actor.id, item.id);
      return item.id;
    });
  }

  complete(actor: Actor, idOrRef: string): BoardItem {
    const item = this.mustFind(actor.serverId, idOrRef);
    this.assertStatus(item, ["in_progress", "blocked"]);
    return this.mutate(actor, "item.completed", () => {
      this.store.db
        .prepare(`UPDATE board_items SET status = 'done', completed_at = ? WHERE id = ?`)
        .run(Date.now(), item.id);
      return item.id;
    });
  }

  block(actor: Actor, idOrRef: string, reason: string): BoardItem {
    const item = this.mustFind(actor.serverId, idOrRef);
    this.assertStatus(item, ["in_progress"]);
    return this.mutate(actor, "item.blocked", () => {
      this.store.db
        .prepare(`UPDATE board_items SET status = 'blocked' WHERE id = ?`)
        .run(item.id);
      return item.id;
    }, { reason });
  }

  unblock(actor: Actor, idOrRef: string): BoardItem {
    const item = this.mustFind(actor.serverId, idOrRef);
    this.assertStatus(item, ["blocked"]);
    return this.mutate(actor, "item.unblocked", () => {
      this.store.db
        .prepare(`UPDATE board_items SET status = 'in_progress' WHERE id = ?`)
        .run(item.id);
      return item.id;
    });
  }

  edit(
    actor: Actor,
    idOrRef: string,
    fields: {
      title?: string;
      description?: string | null;
      owner?: string | null;
      scopePaths?: string[] | null;
    },
  ): BoardItem {
    this.assertHuman(actor, "HUMAN_ONLY");
    const item = this.mustFind(actor.serverId, idOrRef);
    if (fields.owner != null) {
      const owner = this.store.getActor(fields.owner);
      if (!owner || owner.serverId !== actor.serverId) {
        throw new ApiError(400, "OWNER_NOT_FOUND", "owner must be an actor on this server");
      }
    }
    const scopePaths =
      fields.scopePaths === undefined
        ? undefined
        : this.normalizedScope(fields.scopePaths ?? undefined) ?? null;
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of ["title", "description", "owner"] as const) {
      if (fields[key] !== undefined && fields[key] !== item[key]) {
        changed[key] = { from: item[key], to: fields[key] };
      }
    }
    if (scopePaths !== undefined && JSON.stringify(scopePaths) !== JSON.stringify(item.scopePaths)) {
      changed.scopePaths = { from: item.scopePaths, to: scopePaths };
    }
    if (Object.keys(changed).length === 0) return item;
    return this.mutate(actor, "item.edited", () => {
      this.store.db
        .prepare(
          `UPDATE board_items SET
             title = ?, description = ?, owner = ?, scope_paths = ?
           WHERE id = ?`,
        )
        .run(
          fields.title !== undefined ? fields.title : item.title,
          fields.description !== undefined ? fields.description : item.description,
          fields.owner !== undefined ? fields.owner : item.owner,
          scopePaths !== undefined
            ? scopePaths && JSON.stringify(scopePaths)
            : item.scopePaths && JSON.stringify(item.scopePaths),
          item.id,
        );
      return item.id;
    }, { changed });
  }

  /** Soft delete. Halts in-progress work: authz fails afterwards (I4). */
  softDelete(actor: Actor, idOrRef: string): BoardItem {
    this.assertHuman(actor, "HUMAN_ONLY");
    const item = this.mustFind(actor.serverId, idOrRef);
    if (item.deletedAt) throw new ApiError(409, "ALREADY_DELETED", `${item.ref} is already deleted`);
    return this.mutate(actor, "item.deleted", () => {
      this.store.db
        .prepare(`UPDATE board_items SET deleted_at = ? WHERE id = ?`)
        .run(Date.now(), item.id);
      return item.id;
    });
  }

  reopen(actor: Actor, idOrRef: string): BoardItem {
    this.assertHuman(actor, "HUMAN_ONLY");
    const item = this.mustFind(actor.serverId, idOrRef);
    this.assertStatus(item, ["done"]);
    return this.mutate(actor, "item.reopened", () => {
      this.store.db
        .prepare(`UPDATE board_items SET status = 'approved', completed_at = NULL WHERE id = ?`)
        .run(item.id);
      return item.id;
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Run a mutation and its audit row in one transaction (I5), then fan out
   * the envelope after commit.
   */
  private mutate(
    actor: Actor,
    type: BoardEventType,
    apply: () => string,
    payload: BoardEventPayload = {},
  ): BoardItem {
    const itemId = this.store.transaction(() => {
      const id = apply();
      this.store.db
        .prepare(
          `INSERT INTO board_events (server_id, item_id, type, actor_id, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(actor.serverId, id, type, actor.id, JSON.stringify(payload), Date.now());
      return id;
    });
    const item = this.find(actor.serverId, itemId)!;
    this.onEvent?.({
      channel: "board",
      type,
      server_id: actor.serverId,
      actor: { id: actor.id, kind: actor.kind, display_name: actor.displayName },
      item,
      payload,
      ts: new Date().toISOString(),
    });
    return item;
  }

  /** Validate + normalize scope entries, or undefined when none given. */
  private normalizedScope(entries: string[] | undefined): string[] | undefined {
    if (entries === undefined) return undefined;
    const result = validateScopePaths(entries);
    if ("error" in result) throw new ApiError(400, "BAD_SCOPE", result.error);
    return result.paths;
  }

  private mustFind(serverId: string, idOrRef: string): BoardItem {
    const item = this.find(serverId, idOrRef);
    if (!item) throw new ApiError(404, "ITEM_NOT_FOUND", `no board item ${idOrRef}`);
    if (item.deletedAt) throw new ApiError(409, "ITEM_DELETED", `${item.ref} is deleted`);
    return item;
  }

  /** I1: approval authority is asserted against the connection identity. */
  private assertHuman(actor: Actor, code: string): void {
    if (actor.kind !== "human") {
      throw new ApiError(403, code, "humans only");
    }
  }

  private assertStatus(item: BoardItem, allowed: ItemStatus[]): void {
    if (!allowed.includes(item.status)) {
      throw new ApiError(
        409,
        "INVALID_TRANSITION",
        `${item.ref} is ${item.status}; expected ${allowed.join(" or ")}`,
      );
    }
  }
}

const SELECT_ITEM = `
  SELECT i.*, c.display_name AS created_by_name, a.display_name AS approved_by_name,
         o.display_name AS owner_name
  FROM board_items i
  JOIN actors c ON c.id = i.created_by
  LEFT JOIN actors a ON a.id = i.approved_by
  LEFT JOIN actors o ON o.id = i.owner`;

interface ItemRow {
  id: string;
  server_id: string;
  ref: string;
  title: string;
  description: string | null;
  status: ItemStatus;
  origin: "human" | "agent";
  created_by: string;
  approved_by: string | null;
  owner: string | null;
  proposal_why: string | null;
  proposal_effect: string | null;
  scope_paths: string | null;
  created_at: number;
  approved_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  deleted_at: number | null;
  created_by_name: string;
  approved_by_name: string | null;
  owner_name: string | null;
}

function toItem(row: ItemRow): BoardItem {
  return {
    id: row.id,
    serverId: row.server_id,
    ref: row.ref,
    title: row.title,
    description: row.description,
    status: row.status,
    origin: row.origin,
    createdBy: row.created_by,
    approvedBy: row.approved_by,
    owner: row.owner,
    proposalWhy: row.proposal_why,
    proposalEffect: row.proposal_effect,
    scopePaths: row.scope_paths ? (JSON.parse(row.scope_paths) as string[]) : null,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    deletedAt: row.deleted_at,
    createdByName: row.created_by_name,
    approvedByName: row.approved_by_name ?? undefined,
    ownerName: row.owner_name ?? undefined,
  };
}
