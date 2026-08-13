import { randomUUID } from "node:crypto";
import type {
  Actor,
  BoardEventEnvelope,
  BoardEventPayload,
  BoardEventType,
  BoardItem,
  BoardItemEvent,
  ItemStatus,
  ThreadEventPayload,
  WorkCapability,
} from "@workspace/shared";
import { WORK_CAPABILITIES } from "@workspace/shared";
import type { Sql, WorkspaceDb } from "../db";
import type { ThreadEventStore } from "../chat/ThreadEventStore";
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

const selectItem = (sql: Sql) => sql`
  SELECT i.*, c.display_name AS created_by_name, a.display_name AS approved_by_name,
         o.display_name AS owner_name
  FROM board_items i
  JOIN actors c ON c.id = i.created_by
  LEFT JOIN actors a ON a.id = i.approved_by
  LEFT JOIN actors o ON o.id = i.owner
`;

/**
 * All board state changes flow through here. Each transition mutates
 * board_items and appends one compatibility board_events row plus one
 * canonical thread event in the same transaction, then fans out.
 */
export class BoardService {
  /** Realtime fan-out hook; invoked after the transaction commits. */
  onEvent: ((envelope: BoardEventEnvelope) => void) | null = null;

  constructor(
    private store: WorkspaceDb,
    private threadEvents: ThreadEventStore,
  ) {}

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  async list(
    workspaceId: string,
    opts: { status?: ItemStatus; includeDeleted?: boolean } = {},
  ): Promise<BoardItem[]> {
    const sql = this.store.sql;
    const statusFilter = opts.status
      ? sql`AND i.status = ${opts.status}`
      // Default view excludes denied alongside deleted.
      : opts.includeDeleted
        ? sql``
        : sql`AND i.status != 'denied'`;
    const deletedFilter = opts.includeDeleted ? sql`` : sql`AND i.deleted_at IS NULL`;
    const rows = await sql<ItemRow[]>`
      ${selectItem(sql)}
      WHERE i.workspace_id = ${workspaceId} ${statusFilter} ${deletedFilter}
      ORDER BY i.created_at DESC
    `;
    return rows.map(toItem);
  }

  /** Look up by uuid or ref within a workspace. Includes deleted rows. */
  async find(workspaceId: string, idOrRef: string): Promise<BoardItem | null> {
    const sql = this.store.sql;
    const rows = await sql<ItemRow[]>`
      ${selectItem(sql)} WHERE i.workspace_id = ${workspaceId} AND (i.id = ${idOrRef} OR i.ref = ${idOrRef})
    `;
    return rows[0] ? toItem(rows[0]) : null;
  }

  /** Cross-workspace lookup used by authz to distinguish WRONG_SERVER. */
  async findAnywhere(idOrRef: string): Promise<BoardItem | null> {
    const sql = this.store.sql;
    const rows = await sql<ItemRow[]>`${selectItem(sql)} WHERE i.id = ${idOrRef} OR i.ref = ${idOrRef}`;
    return rows[0] ? toItem(rows[0]) : null;
  }

  /** An item's audit trail, oldest first (the events table is append-only). */
  async events(workspaceId: string, idOrRef: string): Promise<BoardItemEvent[]> {
    const item = await this.find(workspaceId, idOrRef);
    if (!item) throw new ApiError(404, "ITEM_NOT_FOUND", `no board item ${idOrRef}`);
    const rows = await this.store.sql<
      {
        id: number;
        type: BoardItemEvent["type"];
        actor_id: string;
        payload: string;
        created_at: number;
        actor_name: string;
        actor_kind: BoardItemEvent["actorKind"];
      }[]
    >`
      SELECT e.id, e.type, e.actor_id, e.payload, e.created_at,
             a.display_name AS actor_name, a.kind AS actor_kind
      FROM board_events e JOIN actors a ON a.id = e.actor_id
      WHERE e.item_id = ${item.id} ORDER BY e.id ASC
    `;
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
  async create(
    actor: Actor,
    input: {
      title: string;
      description?: string;
      why?: string;
      effect?: string;
      scopePaths?: string[];
      capabilities?: WorkCapability[];
    },
  ): Promise<BoardItem> {
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
    // Unrequested capabilities are never granted; an empty ask stays NULL and
    // means file writes only.
    const capabilities = input.capabilities?.length
      ? [...new Set(input.capabilities.filter((c) => WORK_CAPABILITIES.includes(c)))]
      : null;
    const now = Date.now();
    const id = randomUUID();
    return this.mutate(actor, human ? "item.created" : "item.proposed", async (sql) => {
      const ref = await this.store.nextRef(sql, actor.workspaceId);
      await sql`
        INSERT INTO board_items
          (id, workspace_id, ref, title, description, status, origin, created_by,
           approved_by, owner, proposal_why, proposal_effect, scope_paths,
           capabilities, created_at, approved_at)
        VALUES (
          ${id}, ${actor.workspaceId}, ${ref}, ${input.title}, ${input.description ?? null},
          ${human ? "approved" : "proposed"}, ${actor.kind}, ${actor.id},
          ${human ? actor.id : null}, ${null},
          ${human ? null : input.why!}, ${human ? null : input.effect!},
          ${scopePaths ? JSON.stringify(scopePaths) : null},
          ${capabilities ? JSON.stringify(capabilities) : null},
          ${now}, ${human ? now : null}
        )
      `;
      return id;
    });
  }

  async approve(actor: Actor, idOrRef: string): Promise<BoardItem> {
    this.assertHuman(actor, "AGENT_CANNOT_APPROVE");
    const item = await this.mustFind(actor.workspaceId, idOrRef);
    this.assertStatus(item, ["proposed"]);
    return this.mutate(actor, "item.approved", async (sql) => {
      const [updated] = await sql<{ id: string }[]>`
        UPDATE board_items SET status = 'approved', approved_by = ${actor.id}, approved_at = ${Date.now()}
        WHERE id = ${item.id} AND status = 'proposed'
        RETURNING id
      `;
      if (!updated) throw new ApiError(409, "ALREADY_CHANGED", "item was already changed");
      return updated.id;
    });
  }

  async deny(actor: Actor, idOrRef: string, reason?: string): Promise<BoardItem> {
    this.assertHuman(actor, "AGENT_CANNOT_APPROVE");
    const item = await this.mustFind(actor.workspaceId, idOrRef);
    this.assertStatus(item, ["proposed"]);
    return this.mutate(
      actor,
      "item.denied",
      async (sql) => {
        const [updated] = await sql<{ id: string }[]>`
          UPDATE board_items SET status = 'denied' WHERE id = ${item.id} AND status = 'proposed' RETURNING id
        `;
        if (!updated) throw new ApiError(409, "ALREADY_CHANGED", "item was already changed");
        return updated.id;
      },
      reason ? { reason } : {},
    );
  }

  async start(actor: Actor, idOrRef: string): Promise<BoardItem> {
    const item = await this.mustFind(actor.workspaceId, idOrRef);
    this.assertStatus(item, ["approved"]);
    return this.mutate(actor, "item.started", async (sql) => {
      const [updated] = await sql<{ id: string }[]>`
        UPDATE board_items SET status = 'in_progress', started_at = ${Date.now()},
          owner = COALESCE(owner, ${actor.id})
        WHERE id = ${item.id} AND status = 'approved'
        RETURNING id
      `;
      if (!updated) throw new ApiError(409, "ALREADY_CHANGED", "item was already changed");
      return updated.id;
    });
  }

  async complete(actor: Actor, idOrRef: string): Promise<BoardItem> {
    const item = await this.mustFind(actor.workspaceId, idOrRef);
    this.assertStatus(item, ["in_progress", "blocked"]);
    return this.mutate(actor, "item.completed", async (sql) => {
      const [updated] = await sql<{ id: string }[]>`
        UPDATE board_items SET status = 'done', completed_at = ${Date.now()}
        WHERE id = ${item.id} AND (status = 'in_progress' OR status = 'blocked')
        RETURNING id
      `;
      if (!updated) throw new ApiError(409, "ALREADY_CHANGED", "item was already changed");
      return updated.id;
    });
  }

  async block(actor: Actor, idOrRef: string, reason: string): Promise<BoardItem> {
    const item = await this.mustFind(actor.workspaceId, idOrRef);
    this.assertStatus(item, ["in_progress"]);
    return this.mutate(
      actor,
      "item.blocked",
      async (sql) => {
        const [updated] = await sql<{ id: string }[]>`
          UPDATE board_items SET status = 'blocked'
          WHERE id = ${item.id} AND status = 'in_progress'
          RETURNING id
        `;
        if (!updated) throw new ApiError(409, "ALREADY_CHANGED", "item was already changed");
        return updated.id;
      },
      { reason },
    );
  }

  async unblock(actor: Actor, idOrRef: string): Promise<BoardItem> {
    const item = await this.mustFind(actor.workspaceId, idOrRef);
    this.assertStatus(item, ["blocked"]);
    return this.mutate(actor, "item.unblocked", async (sql) => {
      const [updated] = await sql<{ id: string }[]>`
        UPDATE board_items SET status = 'in_progress'
        WHERE id = ${item.id} AND status = 'blocked'
        RETURNING id
      `;
      if (!updated) throw new ApiError(409, "ALREADY_CHANGED", "item was already changed");
      return updated.id;
    });
  }

  async edit(
    actor: Actor,
    idOrRef: string,
    fields: {
      title?: string;
      description?: string | null;
      owner?: string | null;
      scopePaths?: string[] | null;
    },
  ): Promise<BoardItem> {
    this.assertHuman(actor, "HUMAN_ONLY");
    const item = await this.mustFind(actor.workspaceId, idOrRef);
    if (fields.owner != null) {
      // Only workspace members can be assigned as owner (getActor stamps
      // this db's own workspaceId, so an id comparison would be vacuous).
      const owner = await this.store.getActor(fields.owner);
      if (!owner || !(await this.store.isMember(owner.id))) {
        throw new ApiError(400, "OWNER_NOT_FOUND", "owner must be an actor on this server");
      }
    }
    const scopePaths =
      fields.scopePaths === undefined
        ? undefined
        : (this.normalizedScope(fields.scopePaths ?? undefined) ?? null);
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
    return this.mutate(
      actor,
      "item.edited",
      async (sql) => {
        await sql`
          UPDATE board_items SET
            title = ${fields.title !== undefined ? fields.title : item.title},
            description = ${fields.description !== undefined ? fields.description : item.description},
            owner = ${fields.owner !== undefined ? fields.owner : item.owner},
            scope_paths = ${
              scopePaths !== undefined
                ? scopePaths && JSON.stringify(scopePaths)
                : item.scopePaths && JSON.stringify(item.scopePaths)
            }
          WHERE id = ${item.id}
        `;
        return item.id;
      },
      { changed },
    );
  }

  /** Soft delete. Halts in-progress work: authz fails afterwards (I4). */
  async softDelete(actor: Actor, idOrRef: string): Promise<BoardItem> {
    this.assertHuman(actor, "HUMAN_ONLY");
    const item = await this.mustFind(actor.workspaceId, idOrRef);
    if (item.deletedAt) throw new ApiError(409, "ALREADY_DELETED", `${item.ref} is already deleted`);
    return this.mutate(actor, "item.deleted", async (sql) => {
      const [updated] = await sql<{ id: string }[]>`
        UPDATE board_items SET deleted_at = ${Date.now()}
        WHERE id = ${item.id} AND deleted_at IS NULL
        RETURNING id
      `;
      if (!updated) throw new ApiError(409, "ALREADY_CHANGED", "item was already changed");
      return updated.id;
    });
  }

  async reopen(actor: Actor, idOrRef: string): Promise<BoardItem> {
    this.assertHuman(actor, "HUMAN_ONLY");
    const item = await this.mustFind(actor.workspaceId, idOrRef);
    this.assertStatus(item, ["done"]);
    return this.mutate(actor, "item.reopened", async (sql) => {
      const [updated] = await sql<{ id: string }[]>`
        UPDATE board_items SET status = 'approved', completed_at = NULL
        WHERE id = ${item.id} AND status = 'done'
        RETURNING id
      `;
      if (!updated) throw new ApiError(409, "ALREADY_CHANGED", "item was already changed");
      return updated.id;
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Run a mutation and both event rows in one transaction, then fan out the
   * compatibility envelope after commit. `apply` receives the transaction's
   * own `sql` — every query inside it (including a nested `nextRef` call) must use
   * that `sql`, not `this.store.sql`, to stay inside the same transaction.
   */
  private async mutate(
    actor: Actor,
    type: BoardEventType,
    apply: (sql: Sql) => Promise<string>,
    payload: BoardEventPayload = {},
  ): Promise<BoardItem> {
    const itemId = await this.store.transaction(async (sql) => {
      const id = await apply(sql);
      const createdAt = Date.now();
      const [{ ref }] = await sql<{ ref: string }[]>`
        SELECT ref FROM board_items WHERE id = ${id}
      `;
      await sql`
        INSERT INTO board_events (workspace_id, item_id, type, actor_id, payload, created_at)
        VALUES (${actor.workspaceId}, ${id}, ${type}, ${actor.id}, ${JSON.stringify(payload)}, ${createdAt})
      `;
      await this.threadEvents.append(sql, {
        workspaceId: actor.workspaceId,
        actorId: actor.id,
        kind: type,
        subjectId: id,
        payload: { itemId: id, itemRef: ref, ...payload } as ThreadEventPayload,
        createdAt,
      });
      return id;
    });
    const item = (await this.find(actor.workspaceId, itemId))!;
    this.onEvent?.({
      channel: "board",
      type,
      workspace_id: actor.workspaceId,
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

  private async mustFind(workspaceId: string, idOrRef: string): Promise<BoardItem> {
    const item = await this.find(workspaceId, idOrRef);
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

interface ItemRow {
  id: string;
  workspace_id: string;
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
  capabilities: string | null;
  created_at: number;
  approved_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  deleted_at: number | null;
  created_by_name: string;
  approved_by_name: string | null;
  owner_name: string | null;
}

/** Unknown entries are dropped rather than trusted — grants fail closed. */
function parseCapabilities(raw: string | null): WorkCapability[] | null {
  if (!raw) return null;
  const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(parsed)) return null;
  const kept = parsed.filter((c): c is WorkCapability =>
    WORK_CAPABILITIES.includes(c as WorkCapability),
  );
  return kept.length ? kept : null;
}

function toItem(row: ItemRow): BoardItem {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
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
    capabilities: parseCapabilities(row.capabilities),
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
