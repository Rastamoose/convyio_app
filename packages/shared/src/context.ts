import type { Actor, BoardItem } from "./board";
import type { Project } from "./project";

export type PlanStatus = "draft" | "proposed" | "accepted" | "completed" | "cancelled";

export type ImpactAssessment = "affected" | "na";

export interface EcosystemImpact {
  protocol: ImpactAssessment;
  server: ImpactAssessment;
  client: ImpactAssessment;
  agent: ImpactAssessment;
  database: ImpactAssessment;
  security: ImpactAssessment;
  deploy: ImpactAssessment;
  tests: ImpactAssessment;
  demos: ImpactAssessment;
  docs: ImpactAssessment;
  notes: Record<string, string>;
}

export const IMPACT_SURFACES = [
  "protocol",
  "server",
  "client",
  "agent",
  "database",
  "security",
  "deploy",
  "tests",
  "demos",
  "docs",
] as const;

export type ImpactSurface = (typeof IMPACT_SURFACES)[number];

export interface PlanChange {
  at: number;
  actorId: string;
  actorName?: string;
  field: string;
  summary: string;
}

export interface BoardPlan {
  id: string;
  workspaceId: string;
  ref: string;
  title: string;
  objective: string;
  outline: string[];
  impactMap: EcosystemImpact;
  constraints: string[];
  decisions: string[];
  acceptanceCriteria: string[];
  clarifications: string[];
  status: PlanStatus;
  createdBy: string;
  acceptedBy: string | null;
  createdAt: number;
  acceptedAt: number | null;
  completedAt: number | null;
  originChannelId?: string | null;
  originChannelName?: string;
  originEventId?: string | null;
  assumedOwnerId?: string | null;
  assumedOwnerName?: string;
  assumedProjectId?: string | null;
  assumedProjectName?: string;
  changeLog?: PlanChange[];
  createdByName?: string;
  acceptedByName?: string;
}

export type ContextKind = "decision" | "constraint" | "fact" | "blocker" | "handoff" | "summary";
export type ContextScope = "workspace" | "plan" | "ticket" | "channel";

export interface ContextEntry {
  id: string;
  workspaceId: string;
  kind: ContextKind;
  scope: ContextScope;
  subjectId: string | null;
  body: string;
  createdBy: string;
  createdByName?: string;
  supersededBy: string | null;
  createdAt: number;
}

export interface ContextCursor {
  workspaceId: string;
  actorId: string;
  acknowledgedSeq: number;
  acknowledgedAt: number;
  lastEnvelopeId: string | null;
}

/**
 * Cursor-bearing projection of the workspace. `seq` is the highest
 * thread_events.seq included in this snapshot; live events at or below it
 * are already represented and must not be applied as unseen.
 */
export interface WorkspaceSnapshot {
  seq: number;
  generatedAt: number;
  items: BoardItem[];
  plans: BoardPlan[];
  context: ContextEntry[];
  members: Actor[];
  projects: Project[];
}

export function emptyImpactMap(): EcosystemImpact {
  return {
    protocol: "na",
    server: "na",
    client: "na",
    agent: "na",
    database: "na",
    security: "na",
    deploy: "na",
    tests: "na",
    demos: "na",
    docs: "na",
    notes: {},
  };
}

export function isCompleteImpactMap(value: EcosystemImpact): boolean {
  return IMPACT_SURFACES.every((surface) => {
    const assessment = value[surface];
    if (assessment !== "affected" && assessment !== "na") return false;
    return assessment === "affected" ? Boolean(value.notes[surface]?.trim()) : true;
  });
}

export type PlanEventType =
  | "plan.created"
  | "plan.proposed"
  | "plan.accepted"
  | "plan.completed"
  | "plan.cancelled"
  | "plan.edited";

export interface PlanEventEnvelope {
  channel: "plan";
  type: PlanEventType;
  workspace_id: string;
  actor: { id: string; kind: "human" | "agent"; display_name: string };
  plan: BoardPlan;
  ts: string;
}

export function isPlanEnvelope(event: unknown): event is PlanEventEnvelope {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as { channel?: unknown }).channel === "plan"
  );
}

/** Merge a snapshot with events that arrived while it was loading. */
export function mergeLiveItems<T extends { id: string; deletedAt?: number | null }>(
  snapshot: readonly T[],
  live: readonly T[],
): T[] {
  const map = new Map<string, T>();
  for (const item of snapshot) {
    if (item.deletedAt == null) map.set(item.id, item);
  }
  for (const item of live) {
    if (item.deletedAt != null) map.delete(item.id);
    else map.set(item.id, item);
  }
  return [...map.values()];
}
