import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  Actor,
  BoardEventEnvelope,
  ChatMessage,
  Participant,
  PlanEventEnvelope,
  WorkCapability,
} from "@workspace/shared";
import { emptyImpactMap } from "@workspace/shared";
import type { EcosystemImpact, ImpactSurface } from "@workspace/shared";
import type { WorkspaceDb } from "../db";
import type { Hub } from "../hub";
import type { Roster } from "../roster";
import type { BoardService } from "../board/BoardService";
import type { PlanService } from "../board/PlanService";
import type { Toolman } from "../board/Toolman";
import type { DemoScript } from "./script";

const DEFAULT_STEP_DELAY_MS = 3_000;
const AGENT_TIMEOUT_MS = 90_000;
const WORK_TIMEOUT_MS = 180_000;

export interface DemoRun {
  channel: string;
  script: DemoScript;
  mode: "live" | "walkthrough";
  generation: number;
  startedBy: string;
  stage: string;
  progressMessage: string;
  progressLabel?: string;
  paused: boolean;
  cancelled: boolean;
  stepIndex: number;
  planRef?: string;
  ticketRef?: string;
}

export interface DemoProgress {
  channel: string;
  stage: string;
  message: string;
  paused: boolean;
  running: boolean;
  label?: string;
}

export class DemoOrchestrator {
  private generation = 0;
  private run: DemoRun | null = null;
  private resolveAgentReply: (() => void) | null = null;
  private gateResolve: (() => void) | null = null;
  private gateType: string | null = null;
  private latestProposalRef: string | null = null;
  private latestPlanRef: string | null = null;
  private readonly demoRefs = new Set<string>();
  private readonly demoPlanRefs = new Set<string>();
  private readonly actors = new Map<string, Actor>();
  private readonly participants = new Map<string, Participant>();

  constructor(
    private hub: Hub,
    private roster: Roster,
    private db: WorkspaceDb,
    private service: BoardService,
    private plans: PlanService,
    private toolman: Toolman,
    private workspaceDir: string,
    private seedRoot: string,
    private scripts: Map<string, DemoScript>,
    private stepDelayMs = DEFAULT_STEP_DELAY_MS,
  ) {
    hub.onDemoStart = (channel, mode, actorId) => void this.start(channel, mode, actorId);
    hub.onDemoControl = (channel, action, actorId) => void this.control(channel, action, actorId);
    hub.onMessagePosted = (message) => this.onMessagePosted(message);
    hub.onBoardEvent = (envelope) => this.onBoardEvent(envelope);
    hub.onPlanEvent = (envelope) => this.onPlanEvent(envelope);
  }

  progress(channel: string): DemoProgress {
    const run = this.run;
    if (run && run.channel === channel) {
      return {
        channel: run.channel,
        stage: run.stage,
        message: run.progressMessage,
        paused: run.paused,
        running: !run.cancelled,
        ...(run.progressLabel ? { label: run.progressLabel } : {}),
      };
    }
    return { channel, stage: "idle", message: "No demo running.", paused: false, running: false };
  }

  private async start(channel: string, mode: "live" | "walkthrough" | undefined, startedBy: string): Promise<void> {
    const script = this.scripts.get(channel);
    if (!script) {
      console.warn(`[demo] no script for ${channel}`);
      return;
    }
    if (this.run) {
      await this.abortRun();
    }
    const gen = ++this.generation;
    const resolvedMode = mode ?? script.mode ?? "live";
    this.run = {
      channel,
      script,
      mode: resolvedMode,
      generation: gen,
      startedBy,
      stage: "intro",
      progressMessage: "The work starts in the shared conversation.",
      progressLabel: "Shared request",
      paused: false,
      cancelled: false,
      stepIndex: 0,
    };
    this.broadcastProgress(this.run.progressMessage);

    try {
      await this.prepare(channel, script, startedBy);
      if (resolvedMode === "walkthrough") {
        await this.runWalkthrough(channel, script, startedBy, gen);
      } else {
        await this.runLive(channel, script, startedBy, gen);
      }
    } catch (err) {
      if (this.generation !== gen) return;
      console.error("[demo] run failed:", err instanceof Error ? err.message : err);
      this.setStage("failed", err instanceof Error ? err.message : "Demo failed");
      await this.cleanupParticipants();
    }
  }

  private async abortRun(): Promise<void> {
    if (this.run) {
      this.run.cancelled = true;
      this.resolveGate();
      this.resolveAgentReply?.();
      this.resolveAgentReply = null;
      await this.cleanupParticipants();
    }
  }

  private async control(channel: string, action: string, _actorId: string): Promise<void> {
    if (!this.run || this.run.channel !== channel) {
      console.warn(`[demo] control ${action} for ${channel} but no matching run`);
      return;
    }
    switch (action) {
      case "pause":
        this.run.paused = true;
        this.broadcastProgress("Paused.");
        break;
      case "resume":
        this.resume();
        break;
      case "continue":
        if (this.gateType === "continue") {
          this.setStage("continuing", "Continuing the shared workflow.");
          this.resolveGate();
        }
        break;
      case "skip":
        this.run.cancelled = true;
        this.setStage("idle", "Skipped.");
        this.resolveGate();
        await this.cleanupParticipants();
        break;
      case "replay":
        await this.start(channel, this.run.mode, this.run.startedBy);
        break;
    }
  }

  private resume(): void {
    if (!this.run) return;
    this.run.paused = false;
    this.broadcastProgress("Resumed.");
  }

  private async prepare(channel: string, script: DemoScript, startedBy: string): Promise<void> {
    this.actors.clear();
    this.participants.clear();
    await this.cleanupOldDemoWork();
    for (const name of script.personas) await this.requireActor(name, "human");
    for (const name of script.agents) await this.requireActor(name, "agent");
    await this.hub.clearChannel(startedBy, channel, true);
    await this.purgeDemoChannelWork(channel);
    if (script.seedDir) {
      await this.seedWorkspace(script.seedDir);
    }
  }

  private async cleanupOldDemoWork(): Promise<void> {
    const human = await this.requireActor("maya", "human");
    for (const ref of [...this.demoPlanRefs]) {
      try {
        await this.plans.cancel(human, ref);
      } catch {
        // Already terminal or gone.
      }
    }
    this.demoPlanRefs.clear();
    for (const ref of [...this.demoRefs]) {
      try {
        await this.service.softDelete(human, ref);
      } catch {
        // Already gone.
      }
    }
    this.demoRefs.clear();
  }

  private async purgeDemoChannelWork(channel: string): Promise<void> {
    const [row] = await this.db.sql<{ id: string }[]>`
      SELECT id FROM channels
      WHERE workspace_id = ${this.db.workspaceId} AND lower(name) = lower(${channel}) AND is_demo = true
    `;
    if (!row) throw new Error(`${channel} is not a demo channel`);
    await this.db.transaction(async (sql) => {
      await sql`
        DELETE FROM context_entries
        WHERE workspace_id = ${this.db.workspaceId} AND (
          (scope = 'channel' AND subject_id = ${row.id}) OR
          (scope = 'plan' AND subject_id IN (
            SELECT id FROM board_plans WHERE workspace_id = ${this.db.workspaceId} AND origin_channel_id = ${row.id}
          )) OR
          (scope = 'ticket' AND subject_id IN (
            SELECT id FROM board_items
            WHERE workspace_id = ${this.db.workspaceId} AND (
              origin_channel_id = ${row.id} OR plan_id IN (
                SELECT id FROM board_plans WHERE workspace_id = ${this.db.workspaceId} AND origin_channel_id = ${row.id}
              )
            )
          ))
        )
      `;
      await sql`
        DELETE FROM interaction_requests
        WHERE workspace_id = ${this.db.workspaceId} AND (
          channel_id = ${row.id} OR board_item_ref IN (
            SELECT ref FROM board_items
            WHERE workspace_id = ${this.db.workspaceId} AND (
              origin_channel_id = ${row.id} OR plan_id IN (
                SELECT id FROM board_plans WHERE workspace_id = ${this.db.workspaceId} AND origin_channel_id = ${row.id}
              )
            )
          )
        )
      `;
      await sql`
        DELETE FROM agent_resource_access_requests
        WHERE workspace_id = ${this.db.workspaceId} AND origin_channel_id = ${row.id}
      `;
      await sql`
        DELETE FROM thread_events
        WHERE workspace_id = ${this.db.workspaceId} AND channel_id = ${row.id}
      `;
      await sql`
        DELETE FROM board_events
        WHERE workspace_id = ${this.db.workspaceId} AND item_id IN (
          SELECT id FROM board_items
          WHERE workspace_id = ${this.db.workspaceId} AND (
            origin_channel_id = ${row.id} OR plan_id IN (
              SELECT id FROM board_plans WHERE workspace_id = ${this.db.workspaceId} AND origin_channel_id = ${row.id}
            )
          )
        )
      `;
      await sql`
        DELETE FROM board_items
        WHERE workspace_id = ${this.db.workspaceId} AND (
          origin_channel_id = ${row.id} OR plan_id IN (
            SELECT id FROM board_plans WHERE workspace_id = ${this.db.workspaceId} AND origin_channel_id = ${row.id}
          )
        )
      `;
      await sql`
        DELETE FROM board_plans
        WHERE workspace_id = ${this.db.workspaceId} AND origin_channel_id = ${row.id}
      `;
      await sql`
        DELETE FROM agent_conversations
        WHERE workspace_id = ${this.db.workspaceId} AND channel_id = ${row.id}
      `;
    });
    this.demoRefs.clear();
    this.demoPlanRefs.clear();
  }

  private async cleanupParticipants(): Promise<void> {
    for (const name of [...this.participants.keys()]) {
      const participant = this.participants.get(name)!;
      if (participant.kind === "human") {
        this.roster.removeHuman(participant.id);
      } else {
        this.roster.setOnline(participant.id, false);
      }
    }
    this.participants.clear();
    this.actors.clear();
  }

  // -------------------------------------------------------------------------
  // Walkthrough
  // -------------------------------------------------------------------------

  private async runWalkthrough(channel: string, script: DemoScript, _startedBy: string, gen: number): Promise<void> {
    for (let i = 0; i < script.steps.length; i++) {
      if (!this.isCurrent(gen)) return;
      this.run!.stepIndex = i;
      await this.waitIfPaused();
      if (!this.isCurrent(gen)) return;
      const step = script.steps[i];
      try {
        if (step.kind === "message") {
          const text = this.replaceAgent(step.say!, script);
          await this.postAs(step.author!, text, channel);
          if (step.note) this.setStage(`step_${i}`, step.note, step.label);
          if (step.await === "agent_reply") {
            await this.waitForAgentReply(channel, AGENT_TIMEOUT_MS);
          }
        } else if (step.kind === "gate") {
          await this.pauseAtGate(step.gate!, step.prompt, step.label);
        } else if (step.kind === "action") {
          await this.runAction(step.action!, step.actor, step.constraint, channel, script);
          if (step.note) this.setStage(`step_${i}`, step.note, step.label);
        }
      } catch (err) {
        throw err;
      }
      if (step.kind !== "gate") await this.delay(this.stepDelayMs === 0 ? 0 : step.holdMs ?? this.stepDelayMs);
    }
    if (this.isCurrent(gen)) {
      this.setStage("completed", "Everything stayed in one thread.", "Reviewable result");
      await this.cleanupParticipants();
    }
  }

  private async runAction(
    action: string,
    actorName: string | undefined,
    constraint: string | undefined,
    channel: string,
    _script: DemoScript,
  ): Promise<void> {
    switch (action) {
      case "propose_plan":
        await this.proposePlan(channel);
        break;
      case "add_constraint":
        await this.addConstraint(actorName ?? "tom", constraint ?? "Keep owner_name working for one release; do not change the mobile client");
        break;
      case "correct_plan":
        await this.correctPlan(actorName ?? "noodle");
        break;
      case "propose_ticket":
        await this.proposeTicket(channel);
        break;
      case "execute":
        await this.executeTicket(this.run!.ticketRef!);
        break;
      default:
        console.warn(`[demo] unknown walkthrough action ${action}`);
    }
  }

  private async proposePlan(channel: string): Promise<void> {
    const noodle = await this.requireActor("noodle", "agent");
    const plan = await this.plans.create(noodle, {
      title: "Ship the owner field without breaking clients",
      objective: "Add owner to the project API while existing clients using owner_name continue working.",
      outline: [
        "Add owner while preserving owner_name for one release",
        "Update the web client to read owner",
        "Leave the mobile client unchanged",
        "Run the API contract check for old and new clients",
      ],
      constraints: ["New API clients can read owner"],
      clarifications: [
        "Noodle reviewed the backend response; Hermes checked the web and mobile consumers",
      ],
      acceptanceCriteria: [
        "API returns owner and owner_name",
        "web reads owner and mobile still reads owner_name",
        "api-contract/check.ts passes",
      ],
      impactMap: completeImpactMap({ tests: "api-contract/check.ts verifies old and new clients" }),
      channel,
      assumedOwnerId: noodle.id,
    });
    this.run!.planRef = plan.ref;
    this.demoPlanRefs.add(plan.ref);
    this.setStage("plan_proposed", "Backend and client findings are now one shared Plan.");
  }

  private async addConstraint(actorName: string, text: string): Promise<void> {
    const actor = await this.requireActor(actorName);
    if (!this.run?.planRef) throw new Error("no plan to add constraint to");
    await this.plans.appendConstraint(actor, this.run.planRef, text);
    this.setStage("constraint_added", "Plan updated with a new constraint before execution.");
  }

  private async correctPlan(actorName: string): Promise<void> {
    const actor = await this.requireActor(actorName);
    if (!this.run?.planRef) throw new Error("no plan to correct");
    await this.plans.appendDecision(
      actor,
      this.run.planRef,
      "Rollout corrected: add owner, preserve owner_name for one release, update web, and leave mobile unchanged.",
    );
    this.setStage("plan_corrected", "Plan corrected before execution.");
  }

  private async proposeTicket(channel: string): Promise<void> {
    const noodle = await this.requireActor("noodle", "agent");
    if (!this.run?.planRef) throw new Error("no plan for ticket");
    const ticket = await this.service.create(noodle, {
      title: "Add the compatible owner API field",
      why: "The backend wants owner, but existing web and mobile consumers still depend on owner_name.",
      effect: "New clients can read owner while existing clients keep working through owner_name.",
      planId: this.run.planRef,
      owner: noodle.id,
      scopePaths: [
        "api-contract/server/project-response.ts",
        "api-contract/web/project-card.ts",
      ],
      capabilities: ["file_write", "shell_repo"] as WorkCapability[],
      acceptanceCriteria: [
        "API returns owner and owner_name",
        "web reads owner",
        "mobile remains unchanged",
        "api-contract/check.ts passes",
      ],
      impactMap: completeImpactMap({ tests: "api-contract/check.ts verifies old and new clients" }),
      channel,
    });
    this.run.ticketRef = ticket.ref;
    this.demoRefs.add(ticket.ref);
    this.setStage("ticket_proposed", "Ticket proposed. Approve it to authorize the changes.");
  }

  private async executeTicket(ticketRef: string): Promise<void> {
    this.setStage("executing", "Running the authorized changes.");
    const noodle = await this.requireActor("noodle", "agent");
    const fixtureDir = path.join(this.workspaceDir, "api-contract");
    const mobileBefore = await fs.readFile(path.join(fixtureDir, "mobile/project-client.ts"), "utf8");

    await this.service.start(noodle, ticketRef);

    const serverContent = `export interface Project {
  id: string;
  ownerName: string;
}

export function projectResponse(project: Project) {
  return {
    id: project.id,
    owner: project.ownerName,
    owner_name: project.ownerName,
  };
}
`;

    const webContent = `export function projectOwner(project: { owner: string; owner_name?: string }): string {
  return project.owner;
}
`;

    await this.toolFileWrite(noodle, ticketRef, "api-contract/server/project-response.ts", serverContent);
    await this.toolFileWrite(noodle, ticketRef, "api-contract/web/project-card.ts", webContent);

    const mobileAfter = await fs.readFile(path.join(fixtureDir, "mobile/project-client.ts"), "utf8");
    const mobileUnchanged = mobileBefore === mobileAfter;

    let checkOutput = "";
    try {
      const result = await this.toolman.execute(
        noodle,
        { kind: "run_shell", command: "tsx api-contract/check.ts" },
        ticketRef,
      );
      checkOutput = result.ok ? result.output ?? "" : result.error ?? "check failed";
    } catch (err) {
      checkOutput = `verification check error: ${err instanceof Error ? err.message : String(err)}`;
    }

    const evidence = [
      "Changed: API response and web client",
      `Mobile preserved: ${mobileUnchanged ? "yes — mobile client is byte-identical" : "no — mobile client changed"}`,
      "",
      "Verification:",
      checkOutput,
    ].join("\n");

    await this.service.complete(noodle, ticketRef, evidence);
  }

  private async toolFileWrite(actor: Actor, ticketRef: string, filePath: string, content: string): Promise<string> {
    const result = await this.toolman.execute(actor, { kind: "write_file", path: filePath, content }, ticketRef);
    if (!result.ok) throw new Error(`write ${filePath} failed: ${result.error}`);
    return result.output ?? `wrote ${filePath}`;
  }

  // -------------------------------------------------------------------------
  // Live mode (legacy script-driven demo with one connected agent)
  // -------------------------------------------------------------------------

  private async runLive(channel: string, script: DemoScript, _startedBy: string, gen: number): Promise<void> {
    for (const step of script.steps) {
      if (!this.isCurrent(gen)) return;
      if (step.kind !== "message") continue;
      const text = this.replaceAgent(step.say!, script);
      await this.postAs(step.author!, text, channel);
      if (step.await === "agent_reply") {
        await this.waitForAgentReply(channel, AGENT_TIMEOUT_MS);
      } else if (step.await === "approve_proposal") {
        await this.waitForProposal(channel, WORK_TIMEOUT_MS);
        await this.approveLatestProposal(channel);
      } else if (step.await === "accept_plan") {
        await this.waitForPlan(channel, WORK_TIMEOUT_MS);
        await this.acceptLatestPlan(channel);
      }
      await this.delay(this.stepDelayMs);
    }
    if (this.isCurrent(gen)) {
      this.setStage("completed", "Demo complete.");
      await this.cleanupParticipants();
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async requireActor(name: string, kind?: "human" | "agent"): Promise<Actor> {
    const cached = this.actors.get(name);
    if (cached) return cached;
    const resolvedKind = kind ?? (this.run?.script.agents.includes(name) ? "agent" : "human");
    let actor: Actor;
    if (resolvedKind === "agent" && name === "noodle") {
      const managed = await this.db.findManagedAgent("noodle");
      actor = managed ?? (await this.db.upsertActor("agent", "noodle"));
    } else if (resolvedKind === "agent") {
      const rows = await this.db.sql<{ id: string; display_name: string }[]>`
        SELECT id, display_name FROM actors WHERE kind = 'agent' AND lower(display_name) = lower(${name})
      `;
      if (rows[0]) {
        actor = {
          id: rows[0].id,
          kind: "agent",
          displayName: rows[0].display_name,
          workspaceId: this.db.workspaceId,
        };
      } else {
        const id = randomUUID();
        await this.db.sql`INSERT INTO actors (id, kind, display_name) VALUES (${id}, 'agent', ${name})`;
        actor = { id, kind: "agent", displayName: name, workspaceId: this.db.workspaceId };
      }
    } else {
      actor = await this.db.upsertActor("human", name);
    }
    this.actors.set(name, actor);
    await this.joinParticipant(actor);
    return actor;
  }

  private async joinParticipant(actor: Actor): Promise<Participant> {
    const cached = this.participants.get(actor.displayName);
    if (cached) return cached;
    const participant = await this.roster.join(actor.kind, actor.displayName, actor.id);
    this.participants.set(actor.displayName, participant);
    return participant;
  }

  private async postAs(name: string, content: string, channel: string): Promise<void> {
    const actor = await this.requireActor(name);
    const participant = await this.joinParticipant(actor);
    await this.hub.postMessage(participant, content, channel);
  }

  private async seedWorkspace(seedDir: string): Promise<void> {
    const source = path.join(this.seedRoot, seedDir);
    const dest = path.join(this.workspaceDir, seedDir);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.cp(source, dest, { recursive: true, force: true });
  }

  private replaceAgent(text: string, script: DemoScript): string {
    const agentName = script.agents[0] ?? this.roster.onlineAgentName() ?? "noodle";
    return text.replaceAll("{agent}", agentName);
  }

  private async waitForAgentReply(channel: string, timeout: number): Promise<void> {
    await this.waitFor(() => this.resolveAgentReply, timeout, `agent reply on ${channel}`);
  }

  private async waitForProposal(channel: string, timeout: number): Promise<void> {
    await this.waitFor(() => (this.latestProposalRef ? this.resolveAgentReply : null), timeout, `proposal on ${channel}`);
  }

  private async waitForPlan(channel: string, timeout: number): Promise<void> {
    await this.waitFor(() => (this.latestPlanRef ? this.resolveAgentReply : null), timeout, `plan on ${channel}`);
  }

  private async waitFor(getResolver: () => (() => void) | null, timeout: number, label: string): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const resolver = getResolver();
      if (resolver) {
        resolver();
        this.resolveAgentReply = null;
        return;
      }
      await this.delay(500);
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  private async approveLatestProposal(channel: string): Promise<void> {
    const ref = this.latestProposalRef;
    if (!ref) return;
    const human = await this.requireActor("maya", "human");
    await this.service.approve(human, ref);
    await this.hub.postMessage(await this.participantFor("maya"), `approved ${ref}`, channel);
  }

  private async acceptLatestPlan(channel: string): Promise<void> {
    const ref = this.latestPlanRef;
    if (!ref) return;
    const human = await this.requireActor("maya", "human");
    await this.plans.accept(human, ref);
    await this.hub.postMessage(await this.participantFor("maya"), `accepted ${ref}`, channel);
  }

  private async participantFor(name: string): Promise<Participant> {
    const actor = await this.requireActor(name);
    return this.joinParticipant(actor);
  }

  private onMessagePosted(message: ChatMessage): void {
    if (!this.run || message.channel !== this.run.channel) return;
    if (message.authorKind === "agent" && this.resolveAgentReply) {
      this.resolveAgentReply();
      this.resolveAgentReply = null;
    }
  }

  private onBoardEvent(envelope: BoardEventEnvelope): Promise<void> {
    if (!this.run || envelope.item.originChannelName !== this.run.channel) return Promise.resolve();
    if (envelope.type === "item.proposed") {
      this.latestProposalRef = envelope.item.ref;
      this.demoRefs.add(envelope.item.ref);
      if (this.resolveAgentReply) {
        this.resolveAgentReply();
        this.resolveAgentReply = null;
      }
    } else if (envelope.type === "item.approved" && this.gateType === "approve_ticket") {
      if (this.run.ticketRef && envelope.item.ref === this.run.ticketRef) {
        this.setStage("assigned", "Ticket approved. Starting execution.");
        this.resolveGate();
      }
    }
    return Promise.resolve();
  }

  private onPlanEvent(envelope: PlanEventEnvelope): Promise<void> {
    if (!this.run || envelope.plan.originChannelName !== this.run.channel) return Promise.resolve();
    if (envelope.type === "plan.created" || envelope.type === "plan.proposed") {
      this.latestPlanRef = envelope.plan.ref;
      this.demoPlanRefs.add(envelope.plan.ref);
      if (this.resolveAgentReply) {
        this.resolveAgentReply();
        this.resolveAgentReply = null;
      }
    } else if (envelope.type === "plan.accepted" && this.gateType === "accept_plan") {
      if (this.run.planRef && envelope.plan.ref === this.run.planRef) {
        this.setStage("planning", "Plan accepted. Proposing the bounded ticket.");
        this.resolveGate();
      }
    }
    return Promise.resolve();
  }

  private resolveGate(): void {
    if (this.gateResolve) {
      this.gateResolve();
      this.gateResolve = null;
      this.gateType = null;
    }
  }

  private async pauseAtGate(
    gateFor: "continue" | "accept_plan" | "approve_ticket",
    prompt?: string,
    label?: string,
  ): Promise<void> {
    this.gateType = gateFor;
    const message = prompt ?? (gateFor === "continue"
      ? "Continue when you are ready."
      : gateFor === "accept_plan"
        ? "Waiting for you to accept the plan."
        : "Waiting for you to approve the ticket.");
    await new Promise<void>((resolve) => {
      this.gateResolve = resolve;
      this.setStage(`waiting_${gateFor}`, message, label);
    });
  }

  private waitIfPaused(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.run?.paused) {
        resolve();
        return;
      }
      const check = () => {
        if (!this.run?.paused) {
          resolve();
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });
  }

  private isCurrent(gen: number): boolean {
    return this.run !== null && this.run.generation === gen && !this.run.cancelled;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private setStage(stage: string, message: string, label?: string): void {
    if (!this.run) return;
    this.run.stage = stage;
    this.run.progressMessage = message;
    this.run.progressLabel = label;
    this.broadcastProgress(message);
  }

  private broadcastProgress(message: string): void {
    if (!this.run) return;
    this.hub.broadcastDemoProgress({
      type: "demo_progress",
      channel: this.run.channel,
      stage: this.run.stage,
      message,
      paused: this.run.paused,
      ...(this.run.progressLabel ? { label: this.run.progressLabel } : {}),
    });
  }
}

function completeImpactMap(notes: Partial<Record<ImpactSurface, string>>): EcosystemImpact {
  const map = emptyImpactMap();
  for (const [surface, note] of Object.entries(notes)) {
    if (note) {
      map[surface as ImpactSurface] = "affected";
      map.notes[surface as ImpactSurface] = note;
    }
  }
  return map;
}
