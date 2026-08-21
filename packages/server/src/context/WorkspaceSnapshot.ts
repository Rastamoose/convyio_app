import type { Actor, WorkspaceSnapshot } from "@workspace/shared";
import type { WorkspaceDb } from "../db";
import type { BoardService } from "../board/BoardService";
import type { PlanService } from "../board/PlanService";
import type { ContextStore } from "./ContextStore";
import type { ProjectStore } from "../projects/ProjectStore";
import type { ResourceAccessStore } from "./ResourceAccessStore";

/**
 * Builds a cursor-bearing workspace projection. `seq` is the highest
 * thread_events.seq included; callers treat live events at or below it as
 * already represented.
 */
export class WorkspaceSnapshotBuilder {
  constructor(
    private store: WorkspaceDb,
    private board: BoardService,
    private plans: PlanService,
    private context: ContextStore,
    private projects?: ProjectStore,
  ) {}

  async build(): Promise<WorkspaceSnapshot> {
    // Capture seq first. Events after it arrive live; events at or below it
    // are represented here. Taking seq last would let an intervening event
    // land in the cursor but miss the projection.
    const [seqRow] = await this.store.sql<{ seq: number | null }[]>`
      SELECT max(seq) AS seq FROM thread_events
      WHERE workspace_id = ${this.store.workspaceId}
    `;
    const [items, plans, context, members, projects] = await Promise.all([
      this.board.list(this.store.workspaceId, { includeDeleted: true }),
      this.plans.list(this.store.workspaceId),
      this.context.listActive(),
      this.store.listMembers(),
      this.projects?.list() ?? Promise.resolve([]),
    ]);
    return {
      seq: seqRow?.seq ?? 0,
      generatedAt: Date.now(),
      items: items.filter((item) => item.deletedAt == null),
      plans,
      context,
      members,
      projects,
    };
  }

  async buildFor(actor: Actor, access?: ResourceAccessStore | null): Promise<WorkspaceSnapshot> {
    const snapshot = await this.build();
    if (actor.kind !== "agent" || !access) return snapshot;
    const grants = await access.grantsForAgent(actor.id);
    const channelIds = new Set(
      grants.filter((grant) => grant.resourceKind === "channel").map((grant) => grant.resourceId),
    );
    const globallyPublished = new Set(["approved", "in_progress", "blocked", "done"]);
    const items = snapshot.items.filter(
      (item) =>
        globallyPublished.has(item.status) ||
        (item.originChannelId !== null && item.originChannelId !== undefined && channelIds.has(item.originChannelId)),
    );
    const plans = snapshot.plans.filter(
      (plan) => plan.originChannelId !== null && plan.originChannelId !== undefined && channelIds.has(plan.originChannelId),
    );
    const itemIds = new Set(items.map((item) => item.id));
    const planIds = new Set(plans.map((plan) => plan.id));
    const context = snapshot.context.filter(
      (entry) =>
        entry.scope === "workspace" ||
        (entry.scope === "channel" && entry.subjectId !== null && channelIds.has(entry.subjectId)) ||
        (entry.scope === "plan" && entry.subjectId !== null && planIds.has(entry.subjectId)) ||
        (entry.scope === "ticket" && entry.subjectId !== null && itemIds.has(entry.subjectId)),
    );
    return { ...snapshot, items, plans, context, projects: [] };
  }
}
