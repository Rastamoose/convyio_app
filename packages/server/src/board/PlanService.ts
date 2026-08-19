import { randomUUID } from "node:crypto";
import type {
  Actor,
  BoardPlan,
  EcosystemImpact,
  ParticipantKind,
  PlanChange,
  PlanEventEnvelope,
  PlanEventType,
  PlanStatus,
} from "@workspace/shared";
import { IMPACT_SURFACES, emptyImpactMap, isCompleteImpactMap } from "@workspace/shared";
import type { Sql, WorkspaceDb } from "../db";
import type { ThreadEventStore } from "../chat/ThreadEventStore";
import type { Channels } from "../chat/Channels";
import { ApiError } from "./BoardService";

export interface PlanInput {
  title: string;
  objective: string;
  outline: string[];
  impactMap?: EcosystemImpact;
  constraints?: string[];
  decisions?: string[];
  acceptanceCriteria?: string[];
  clarifications?: string[];
  channel?: string | null;
  assumedOwnerId?: string | null;
  assumedProjectId?: string | null;
}

/**
 * First-class planning records. Acceptance is a human coordination decision
 * and never authorizes world mutation.
 */
export class PlanService {
  onEvent: ((envelope: PlanEventEnvelope) => void) | null = null;

  constructor(
    private store: WorkspaceDb,
    private threadEvents: ThreadEventStore,
    private channels?: Channels,
  ) {}

  async list(workspaceId: string): Promise<BoardPlan[]> {
    const rows = await this.store.sql<PlanRow[]>`
      ${selectPlan(this.store.sql)}
      WHERE p.workspace_id = ${workspaceId}
      ORDER BY p.created_at DESC
    `;
    return rows.map(toPlan);
  }

  async find(workspaceId: string, idOrRef: string): Promise<BoardPlan | null> {
    const [row] = await this.store.sql<PlanRow[]>`
      ${selectPlan(this.store.sql)}
      WHERE p.workspace_id = ${workspaceId} AND (p.id = ${idOrRef} OR p.ref = ${idOrRef})
    `;
    return row ? toPlan(row) : null;
  }

  async create(actor: Actor, input: PlanInput): Promise<BoardPlan> {
    const fields = normalizePlanInput(input);
    const origin = await this.resolveOrigin(input.channel);
    if (fields.assumedOwnerId) await this.requireMember(fields.assumedOwnerId);
    if (fields.assumedProjectId) await this.requireProject(actor.workspaceId, fields.assumedProjectId);
    const human = actor.kind === "human";
    const now = Date.now();
    const id = randomUUID();
    return this.mutate(actor, human ? "plan.proposed" : "plan.created", async (sql) => {
      const ref = await this.store.nextPlanRef(sql, actor.workspaceId);
      await sql`
        INSERT INTO board_plans (
          id, workspace_id, ref, title, objective, outline, impact_map, constraints,
          decisions, acceptance_criteria, clarifications, status, created_by,
          accepted_by, created_at, accepted_at, origin_channel_id, assumed_owner_id,
          assumed_project_id, change_log
        ) VALUES (
          ${id}, ${actor.workspaceId}, ${ref}, ${fields.title}, ${fields.objective},
          ${sql.json(fields.outline)}, ${sql.json(JSON.parse(JSON.stringify(fields.impactMap)))},
          ${sql.json(fields.constraints)}, ${sql.json(fields.decisions)},
          ${sql.json(fields.acceptanceCriteria)}, ${sql.json(fields.clarifications)},
          ${"proposed"}, ${actor.id}, NULL, ${now}, NULL, ${origin?.id ?? null},
          ${fields.assumedOwnerId}, ${fields.assumedProjectId}, ${sql.json([])}
        )
      `;
      return { id, channelId: origin?.id ?? null };
    });
  }

  async accept(actor: Actor, idOrRef: string): Promise<BoardPlan> {
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "humans only");
    const plan = await this.mustFind(actor.workspaceId, idOrRef);
    if (plan.status !== "proposed" && plan.status !== "draft") {
      throw new ApiError(409, "INVALID_TRANSITION", `${plan.ref} is ${plan.status}; expected proposed`);
    }
    requireAcceptable(plan);
    const now = Date.now();
    return this.mutate(actor, "plan.accepted", async (sql) => {
      const [updated] = await sql<{ id: string }[]>`
        UPDATE board_plans
        SET status = 'accepted', accepted_by = ${actor.id}, accepted_at = ${now}
        WHERE id = ${plan.id} AND status IN ('proposed', 'draft')
        RETURNING id
      `;
      if (!updated) throw new ApiError(409, "ALREADY_CHANGED", "plan was already changed");
      return { id: updated.id, channelId: plan.originChannelId ?? null };
    });
  }

  async complete(actor: Actor, idOrRef: string): Promise<BoardPlan> {
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "humans only");
    const plan = await this.mustFind(actor.workspaceId, idOrRef);
    if (plan.status !== "accepted") {
      throw new ApiError(409, "INVALID_TRANSITION", `${plan.ref} is ${plan.status}; expected accepted`);
    }
    const now = Date.now();
    return this.mutate(actor, "plan.completed", async (sql) => {
      const [updated] = await sql<{ id: string }[]>`
        UPDATE board_plans SET status = 'completed', completed_at = ${now}
        WHERE id = ${plan.id} AND status = 'accepted'
        RETURNING id
      `;
      if (!updated) throw new ApiError(409, "ALREADY_CHANGED", "plan was already changed");
      return { id: updated.id, channelId: plan.originChannelId ?? null };
    });
  }

  async cancel(actor: Actor, idOrRef: string): Promise<BoardPlan> {
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "humans only");
    const plan = await this.mustFind(actor.workspaceId, idOrRef);
    if (plan.status === "completed" || plan.status === "cancelled") {
      throw new ApiError(409, "INVALID_TRANSITION", `${plan.ref} is already ${plan.status}`);
    }
    return this.mutate(actor, "plan.cancelled", async (sql) => {
      const [updated] = await sql<{ id: string }[]>`
        UPDATE board_plans SET status = 'cancelled'
        WHERE id = ${plan.id} AND status NOT IN ('completed', 'cancelled')
        RETURNING id
      `;
      if (!updated) throw new ApiError(409, "ALREADY_CHANGED", "plan was already changed");
      return { id: updated.id, channelId: plan.originChannelId ?? null };
    });
  }

  async appendDecision(actor: Actor, idOrRef: string, decision: string): Promise<BoardPlan> {
    const plan = await this.mustFind(actor.workspaceId, idOrRef);
    if (plan.status !== "accepted") {
      throw new ApiError(409, "PLAN_NOT_ACCEPTED", `${plan.ref} is ${plan.status}`);
    }
    const text = decision.trim();
    if (!text) throw new ApiError(400, "EMPTY_DECISION", "decision is required");
    const change = changeEntry(actor, Date.now(), "decisions", `Recorded decision: ${text}`);
    return this.mutate(actor, "plan.edited", async (sql) => {
      await sql`
        UPDATE board_plans
        SET decisions = COALESCE(decisions, '[]'::jsonb) || ${sql.json([text])}::jsonb,
            change_log = COALESCE(change_log, '[]'::jsonb) || ${sql.json([JSON.parse(JSON.stringify(change))])}::jsonb
        WHERE id = ${plan.id}
      `;
      return { id: plan.id, channelId: plan.originChannelId ?? null };
    });
  }

  async appendConstraint(actor: Actor, idOrRef: string, constraint: string): Promise<BoardPlan> {
    const plan = await this.mustFind(actor.workspaceId, idOrRef);
    if (plan.status === "completed" || plan.status === "cancelled") {
      throw new ApiError(409, "INVALID_TRANSITION", `${plan.ref} is already ${plan.status}`);
    }
    const text = constraint.trim();
    if (!text) throw new ApiError(400, "EMPTY_CONSTRAINT", "constraint is required");
    if (plan.constraints.includes(text)) return plan;
    const change = changeEntry(actor, Date.now(), "constraints", `Changed before execution: ${text}`);
    return this.mutate(actor, "plan.edited", async (sql) => {
      await sql`
        UPDATE board_plans
        SET constraints = COALESCE(constraints, '[]'::jsonb) || ${sql.json([text])}::jsonb,
            change_log = COALESCE(change_log, '[]'::jsonb) || ${sql.json([JSON.parse(JSON.stringify(change))])}::jsonb
        WHERE id = ${plan.id}
      `;
      return { id: plan.id, channelId: plan.originChannelId ?? null };
    });
  }

  private async mustFind(workspaceId: string, idOrRef: string): Promise<BoardPlan> {
    const plan = await this.find(workspaceId, idOrRef);
    if (!plan) throw new ApiError(404, "PLAN_NOT_FOUND", `no plan ${idOrRef}`);
    return plan;
  }

  private async resolveOrigin(channel?: string | null) {
    return this.channels?.resolve(channel) ?? null;
  }

  private async requireMember(actorId: string): Promise<void> {
    const owner = await this.store.getActor(actorId);
    if (!owner || !(await this.store.isMember(owner.id))) {
      throw new ApiError(400, "OWNER_NOT_FOUND", "proposed owner must be a workspace member");
    }
  }

  private async requireProject(workspaceId: string, projectId: string): Promise<void> {
    const [project] = await this.store.sql<{ id: string }[]>`
      SELECT id FROM projects
      WHERE id = ${projectId} AND workspace_id = ${workspaceId} AND archived_at IS NULL
    `;
    if (!project) throw new ApiError(400, "PROJECT_NOT_FOUND", "proposed resource must be an attached project");
  }

  private async mutate(
    actor: Actor,
    type: PlanEventType,
    apply: (sql: Sql) => Promise<{ id: string; channelId: string | null }>,
  ): Promise<BoardPlan> {
    const id = await this.store.transaction(async (sql) => {
      const applied = await apply(sql);
      const [{ ref }] = await sql<{ ref: string }[]>`SELECT ref FROM board_plans WHERE id = ${applied.id}`;
      const event = await this.threadEvents.append(sql, {
        workspaceId: actor.workspaceId,
        channelId: applied.channelId,
        actorId: actor.id,
        kind: type,
        subjectId: applied.id,
        payload: { planId: applied.id, planRef: ref },
      });
      if (type === "plan.created" || type === "plan.proposed") {
        await sql`
          UPDATE board_plans
          SET origin_event_id = COALESCE(origin_event_id, ${event.id})
          WHERE id = ${applied.id}
        `;
      }
      return applied.id;
    });
    const plan = (await this.find(actor.workspaceId, id))!;
    this.onEvent?.({
      channel: "plan",
      type,
      workspace_id: actor.workspaceId,
      actor: { id: actor.id, kind: actor.kind, display_name: actor.displayName },
      plan,
      ts: new Date().toISOString(),
    });
    return plan;
  }
}

function selectPlan(sql: Sql) {
  return sql`
    SELECT p.*, c.display_name AS created_by_name, a.display_name AS accepted_by_name,
           o.display_name AS assumed_owner_name, j.name AS assumed_project_name,
           ch.name AS origin_channel_name
    FROM board_plans p
    JOIN actors c ON c.id = p.created_by
    LEFT JOIN actors a ON a.id = p.accepted_by
    LEFT JOIN actors o ON o.id = p.assumed_owner_id
    LEFT JOIN projects j ON j.id = p.assumed_project_id
    LEFT JOIN channels ch ON ch.id = p.origin_channel_id
  `;
}

interface PlanRow {
  id: string;
  workspace_id: string;
  ref: string;
  title: string;
  objective: string;
  outline: unknown;
  impact_map: unknown;
  constraints: unknown;
  decisions: unknown;
  acceptance_criteria: unknown;
  clarifications: unknown;
  status: PlanStatus;
  created_by: string;
  accepted_by: string | null;
  created_at: number;
  accepted_at: number | null;
  completed_at: number | null;
  origin_channel_id?: string | null;
  origin_event_id?: string | null;
  assumed_owner_id?: string | null;
  assumed_project_id?: string | null;
  change_log?: unknown;
  created_by_name: string;
  accepted_by_name: string | null;
  assumed_owner_name?: string | null;
  assumed_project_name?: string | null;
  origin_channel_name?: string | null;
}

function toPlan(row: PlanRow): BoardPlan {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ref: row.ref,
    title: row.title,
    objective: row.objective,
    outline: asStringArray(row.outline),
    impactMap: asImpact(row.impact_map),
    constraints: asStringArray(row.constraints),
    decisions: asStringArray(row.decisions),
    acceptanceCriteria: asStringArray(row.acceptance_criteria),
    clarifications: asStringArray(row.clarifications),
    status: row.status,
    createdBy: row.created_by,
    acceptedBy: row.accepted_by,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    completedAt: row.completed_at,
    originChannelId: row.origin_channel_id ?? null,
    originChannelName: row.origin_channel_name ?? undefined,
    originEventId: row.origin_event_id ?? null,
    assumedOwnerId: row.assumed_owner_id ?? null,
    assumedOwnerName: row.assumed_owner_name ?? undefined,
    assumedProjectId: row.assumed_project_id ?? null,
    assumedProjectName: row.assumed_project_name ?? undefined,
    changeLog: asChangeLog(row.change_log),
    createdByName: row.created_by_name,
    acceptedByName: row.accepted_by_name ?? undefined,
  };
}

function normalizePlanInput(input: PlanInput) {
  const title = input.title.trim();
  const objective = input.objective.trim();
  if (!title) throw new ApiError(400, "TITLE_REQUIRED", "title is required");
  if (!objective) throw new ApiError(400, "OBJECTIVE_REQUIRED", "objective is required");
  const outline = input.outline.map((line) => line.trim()).filter(Boolean);
  if (outline.length === 0) throw new ApiError(400, "OUTLINE_REQUIRED", "outline is required");
  return {
    title,
    objective,
    outline,
    impactMap: input.impactMap ?? emptyImpactMap(),
    constraints: (input.constraints ?? []).map((line) => line.trim()).filter(Boolean),
    decisions: (input.decisions ?? []).map((line) => line.trim()).filter(Boolean),
    acceptanceCriteria: (input.acceptanceCriteria ?? []).map((line) => line.trim()).filter(Boolean),
    clarifications: (input.clarifications ?? []).map((line) => line.trim()).filter(Boolean),
    assumedOwnerId: input.assumedOwnerId?.trim() || null,
    assumedProjectId: input.assumedProjectId?.trim() || null,
  };
}

function requireAcceptable(plan: BoardPlan): void {
  if (plan.outline.length === 0) throw new ApiError(400, "OUTLINE_REQUIRED", "outline is required");
  if (plan.clarifications.length === 0) {
    throw new ApiError(400, "CLARIFICATION_REQUIRED", "accepted plans must record at least one clarification");
  }
  if (!isCompleteImpactMap(plan.impactMap)) {
    throw new ApiError(400, "IMPACT_REQUIRED", "accepted plans must assess every ecosystem surface");
  }
}

function changeEntry(actor: Actor, at: number, field: string, summary: string): PlanChange {
  return { at, actorId: actor.id, actorName: actor.displayName, field, summary };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function asChangeLog(value: unknown): PlanChange[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const raw = entry as Record<string, unknown>;
    if (typeof raw.at !== "number" || typeof raw.actorId !== "string" || typeof raw.field !== "string" || typeof raw.summary !== "string") {
      return [];
    }
    return [{
      at: raw.at,
      actorId: raw.actorId,
      actorName: typeof raw.actorName === "string" ? raw.actorName : undefined,
      field: raw.field,
      summary: raw.summary,
    }];
  });
}

function asImpact(value: unknown): EcosystemImpact {
  const base = emptyImpactMap();
  if (!value || typeof value !== "object") return base;
  const raw = value as Record<string, unknown>;
  for (const surface of IMPACT_SURFACES) {
    if (raw[surface] === "affected" || raw[surface] === "na") base[surface] = raw[surface];
  }
  if (raw.notes && typeof raw.notes === "object") {
    for (const [key, note] of Object.entries(raw.notes as Record<string, unknown>)) {
      if (typeof note === "string") base.notes[key] = note;
    }
  }
  return base;
}

export type { ParticipantKind };
