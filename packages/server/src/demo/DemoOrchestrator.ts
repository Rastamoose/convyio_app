import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  Actor,
  BoardEventEnvelope,
  ChatMessage,
  DemoFocusTarget,
  Participant,
  PlanEventEnvelope,
} from "@workspace/shared";
import type { WorkspaceDb } from "../db";
import type { Hub } from "../hub";
import type { Roster } from "../roster";
import type { Attachments } from "../chat/Attachments";
import type { BoardService } from "../board/BoardService";
import type { PlanService } from "../board/PlanService";
import type { DemoScript, DemoStep } from "./script";

const DEFAULT_STEP_DELAY_MS = 3_000;
const AGENT_TIMEOUT_MS = 90_000;
const WORK_TIMEOUT_MS = 180_000;

// ponytail: content doesn't matter here, only that it's long enough to land
// as a real text-file attachment instead of a wall of inline chat text.
const ONE_PAGER_CONTEXT_DOC = `# Living Brief — one-pager context

## Problem
Hackathon teams generate context faster than they can organize it: Slack
threads, shared docs, whiteboard photos, half-written notes. By the time a
second person needs that context, it is scattered across four tools and one
person's memory. Nobody has time during a hackathon to write a real spec, but
someone still has to hold the whole picture.

## Core user
A 2-4 person hackathon team, mid-build, trying to keep everyone pointed at
the same target without a standup every hour.

## MVP scope
- Accept a pasted blob of text: chat logs, doc exports, raw notes, anything.
- Split it into three labeled sections: Problem, Users, MVP scope.
- Render the result as one page anyone on the team can open.
- No accounts, no login, no setup. Paste in, get a page out.

## Out of scope for this build
- Authentication or multi-tenant accounts.
- Billing or any payment flow.
- Live sync between multiple editors.
- Rich formatting beyond plain sections and lists.

## Notes from the whiteboard session
- The team agreed the biggest failure mode is not lack of ideas, it's that
  the ideas live in five places and nobody reads all five.
- Whoever writes the first draft should not have to become the team's
  full-time forwarder of context. That's the whole point of this build.
- Judges care more about a working paste-to-page loop than a polished UI.
  Skip styling until the ingestion works end to end.
- Stretch goal, not MVP: let a second paste update the same page instead of
  creating a new one. Only build this if the core loop works with time to
  spare.

## Acceptance check
Paste a sample doc dump in, get back a page with problem, users, and MVP
scope filled in, and nothing crashes on a blob with weird line breaks or
stray HTML from a copy-paste.
`;

/** Typed exactly, case-insensitively: a real message that starts the scripted demo in whatever channel it was sent. */
const DEMO_TRIGGER_PHRASE = "@noodle what's the update";
/** Which registered script supplies the content a trigger phrase plays, regardless of which channel it fires in. */
const DEMO_TRIGGER_SCRIPT_KEY = "demo";

export interface DemoRun {
  channel: string;
  script: DemoScript;
  mode: "live" | "walkthrough";
  generation: number;
  startedBy: string;
  stage: string;
  progressMessage?: string;
  paused: boolean;
  cancelled: boolean;
  stepIndex: number;
  planRef?: string;
  ticketRef?: string;
  focus?: DemoFocusTarget;
  /** False for a chat-triggered run: it plays inside whatever channel asked for it, so it must never touch that channel's real history. */
  wipe: boolean;
}

export interface DemoProgress {
  channel: string;
  stage: string;
  message?: string;
  paused: boolean;
  running: boolean;
  focus?: DemoFocusTarget;
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
    private attachments: Attachments,
    private workspaceDir: string,
    private seedRoot: string,
    private scripts: Map<string, DemoScript>,
    private stepDelayMs = DEFAULT_STEP_DELAY_MS,
  ) {
    hub.onDemoStart = (channel, mode, actorId) => void this.start(channel, mode, actorId);
    hub.onDemoControl = (channel, action, actorId) => void this.control(channel, action, actorId);
    hub.onDemoTrigger = (content) => this.isTriggerPhrase(content);
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
        paused: run.paused,
        running: !run.cancelled,
        ...(run.progressMessage ? { message: run.progressMessage } : {}),
        ...(run.focus ? { focus: run.focus } : {}),
      };
    }
    return { channel, stage: "idle", paused: false, running: false };
  }

  private async start(
    channel: string,
    mode: "live" | "walkthrough" | undefined,
    startedBy: string,
    options: { script?: DemoScript; wipe?: boolean } = {},
  ): Promise<void> {
    const script = options.script ?? this.scripts.get(channel);
    if (!script) {
      console.warn(`[demo] no script for ${channel}`);
      return;
    }
    const wipe = options.wipe ?? true;
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
      paused: false,
      cancelled: false,
      stepIndex: 0,
      wipe,
    };
    this.broadcastProgress();

    try {
      await this.prepare(channel, script, startedBy, wipe);
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
        this.broadcastProgress();
        break;
      case "resume":
        this.resume();
        break;
      case "continue":
        if (this.gateType === "continue") {
          this.setStage("continuing");
          this.resolveGate();
        } else if (this.gateType === "accept_plan") {
          await this.autoAcceptPlan();
        } else if (this.gateType === "approve_ticket") {
          await this.autoApproveTicket();
        }
        break;
      case "skip":
        this.run.cancelled = true;
        this.setStage("idle");
        this.resolveGate();
        await this.cleanupParticipants();
        break;
      case "replay":
        await this.start(channel, this.run.mode, this.run.startedBy, { script: this.run.script, wipe: this.run.wipe });
        break;
    }
  }

  private resume(): void {
    if (!this.run) return;
    this.run.paused = false;
    this.broadcastProgress();
  }

  private async prepare(channel: string, script: DemoScript, startedBy: string, wipe: boolean): Promise<void> {
    this.actors.clear();
    this.participants.clear();
    await this.cleanupOldDemoWork();
    for (const name of script.personas) await this.requireActor(name, "human");
    for (const name of script.agents) await this.requireActor(name, "agent");
    // A chat-triggered run plays inside a channel someone else owns; it must
    // never wipe real history the way the dedicated demo channel does.
    if (wipe) {
      await this.hub.clearChannel(startedBy, channel, true);
      await this.purgeDemoChannelWork(channel);
    }
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
          if (step.await === "agent_reply") {
            await this.waitForAgentReply(channel, AGENT_TIMEOUT_MS);
          }
        } else if (step.kind === "gate") {
          await this.pauseAtGate(step.gate!, step.prompt, step.focus);
        } else if (step.kind === "action") {
          await this.runAction(step, channel);
        }
      } catch (err) {
        throw err;
      }
      if (step.kind !== "gate") await this.delay(this.stepDelayMs === 0 ? 0 : step.holdMs ?? this.stepDelayMs);
    }
    if (this.isCurrent(gen)) {
      this.setStage("completed");
      await this.cleanupParticipants();
    }
  }

  private async runAction(step: DemoStep, channel: string): Promise<void> {
    switch (step.action) {
      case "request_permission":
        await this.requestPermission(step, channel);
        break;
      case "generate_document":
        await this.generateDocument(step, channel);
        break;
      default:
        console.warn(`[demo] unknown walkthrough action ${step.action}`);
    }
  }

  /**
   * A scripted permission checkpoint: the agent asks, the named human grants
   * it moments later. Uses the same durable interaction-request record and
   * broadcast a live tool call would produce, so the PermissionCard in the
   * transcript is real — it just isn't gating a real pending tool call.
   */
  private async requestPermission(step: DemoStep, channel: string): Promise<void> {
    const agentName = step.actor ?? "hermes";
    const agent = await this.requireActor(agentName, "agent");
    const capability = step.capability ?? "file_write";
    const summary = step.permissionSummary ?? "proceed with the approved work";
    const request = await this.hub.raiseDemoInteraction({ channel, agentId: agent.id, capability, summary });
    await this.delay(this.stepDelayMs === 0 ? 0 : 2_500);
    const human = await this.requireActor(step.grantedBy ?? "maya", "human");
    await this.hub.resolveDemoInteraction(request.id, "approved", human.id);
  }

  /**
   * The forwarding pain the demo is built to show: instead of a chat wall or
   * a doc someone has to paste around, the agent writes the shared context
   * once as a real attachment. The chat line stays short; the file carries
   * the detail, so later steps can point at it without resending it.
   */
  private async generateDocument(step: DemoStep, channel: string): Promise<void> {
    const authorName = step.actor ?? "noodle";
    const author = await this.requireActor(authorName, "agent");
    const participant = await this.joinParticipant(author);
    const name = step.documentName ?? "one-pager-context.txt";
    const saved = await this.attachments.save(author, { name, mime: "text/plain" }, Buffer.from(ONE_PAGER_CONTEXT_DOC, "utf8"));
    const messageId = randomUUID();
    const bound = await this.attachments.bind(messageId, [saved.id], author.id);
    const caption = step.caption ?? "wrote it up as one doc, everything's in there";
    await this.hub.postMessage(participant, caption, channel, { id: messageId, attachments: bound, skipMentionDispatch: true });
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
    } else {
      // upsertActor also registers agents as workspace members, which
      // ticket ownership requires (BoardService.requireMember).
      actor = await this.db.upsertActor(resolvedKind, name);
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
    await this.hub.postMessage(participant, content, channel, { skipMentionDispatch: true });
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

  /**
   * The walkthrough's human decision points normally wait for a real click on
   * the spotlighted Plan/Ticket card. That round trip depends on wiring that
   * isn't reliable during onboarding, so Continue performs the same real
   * accept/approve call directly instead of waiting for it to arrive via a
   * separate UI control.
   */
  private async autoAcceptPlan(): Promise<void> {
    if (!this.run?.planRef) {
      this.resolveGate();
      return;
    }
    const human = await this.requireActor("maya", "human");
    try {
      await this.plans.accept(human, this.run.planRef);
    } catch (err) {
      console.error("[demo] auto-accept failed:", err instanceof Error ? err.message : err);
    }
    this.setStage("planning", "Plan accepted. Proposing the bounded ticket.");
    this.resolveGate();
  }

  private async autoApproveTicket(): Promise<void> {
    if (!this.run?.ticketRef) {
      this.resolveGate();
      return;
    }
    const human = await this.requireActor("maya", "human");
    const hermes = await this.requireActor("hermes", "agent");
    try {
      await this.service.approve(human, this.run.ticketRef, hermes.id);
    } catch (err) {
      console.error("[demo] auto-approve failed:", err instanceof Error ? err.message : err);
    }
    this.setStage("assigned", "Ticket approved. Starting execution.");
    this.resolveGate();
  }

  private async approveLatestProposal(channel: string): Promise<void> {
    const ref = this.latestProposalRef;
    if (!ref) return;
    const human = await this.requireActor("maya", "human");
    await this.service.approve(human, ref);
    await this.hub.postMessage(await this.participantFor("maya"), `approved ${ref}`, channel, { skipMentionDispatch: true });
  }

  private async acceptLatestPlan(channel: string): Promise<void> {
    const ref = this.latestPlanRef;
    if (!ref) return;
    const human = await this.requireActor("maya", "human");
    await this.plans.accept(human, ref);
    await this.hub.postMessage(await this.participantFor("maya"), `accepted ${ref}`, channel, { skipMentionDispatch: true });
  }

  private async participantFor(name: string): Promise<Participant> {
    const actor = await this.requireActor(name);
    return this.joinParticipant(actor);
  }

  private onMessagePosted(message: ChatMessage): void {
    if (message.authorKind === "human" && message.channel && this.isTriggerPhrase(message.content)) {
      void this.start(message.channel, "walkthrough", message.authorId, {
        script: this.scripts.get(DEMO_TRIGGER_SCRIPT_KEY),
        wipe: false,
      });
      return;
    }
    if (!this.run || message.channel !== this.run.channel) return;
    if (message.authorKind === "agent" && this.resolveAgentReply) {
      this.resolveAgentReply();
      this.resolveAgentReply = null;
    }
  }

  private isTriggerPhrase(content: string): boolean {
    return content.trim().toLowerCase() === DEMO_TRIGGER_PHRASE;
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
    focusKind?: DemoFocusTarget["kind"],
  ): Promise<void> {
    this.gateType = gateFor;
    const message = prompt ?? (gateFor === "continue"
      ? "Continue when you are ready."
      : gateFor === "accept_plan"
        ? "Waiting for you to accept the plan."
        : "Waiting for you to approve the ticket.");
    const kind = focusKind ?? (gateFor === "accept_plan" ? "plan_accept" : gateFor === "approve_ticket" ? "ticket_approve" : "guide");
    const id = kind === "plan_accept" ? this.run?.planRef : kind === "ticket_approve" || kind === "result" ? this.run?.ticketRef : undefined;
    const focus: DemoFocusTarget = { kind, ...(id ? { id } : {}) };
    await new Promise<void>((resolve) => {
      this.gateResolve = resolve;
      this.setStage(`waiting_${gateFor}`, message, focus);
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

  private setStage(stage: string, message?: string, focus?: DemoFocusTarget): void {
    if (!this.run) return;
    this.run.stage = stage;
    this.run.progressMessage = message;
    this.run.focus = focus ?? { kind: "guide" };
    this.broadcastProgress();
  }

  private broadcastProgress(): void {
    if (!this.run) return;
    this.hub.broadcastDemoProgress({
      type: "demo_progress",
      channel: this.run.channel,
      stage: this.run.stage,
      paused: this.run.paused,
      ...(this.run.progressMessage ? { message: this.run.progressMessage } : {}),
      ...(this.run.focus ? { focus: this.run.focus } : {}),
    });
  }
}
