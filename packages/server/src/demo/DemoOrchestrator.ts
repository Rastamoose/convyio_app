import fs from "node:fs/promises";
import path from "node:path";
import type { BoardEventEnvelope, ChatMessage } from "@workspace/shared";
import type { Hub } from "../hub";
import type { Roster } from "../roster";
import type { WorkspaceDb } from "../db";
import type { BoardService } from "../board/BoardService";
import type { DemoScript } from "./script";

const STEP_DELAY_MS = 4500;
const AGENT_TIMEOUT_MS = 90_000;
/** Post-approval the agent starts, edits files, and completes — allow longer. */
const WORK_TIMEOUT_MS = 180_000;

/**
 * Replays a demo script through the real pipeline: persona messages go
 * through the hub exactly like human input, agent replies and board
 * proposals are the live agent's own work. The orchestrator only feeds
 * inputs and waits — it owns no script content and no special server
 * behaviour.
 */
export class DemoOrchestrator {
  private running = false;
  /** Bumped on every start; a stale generation aborts its loop. */
  private generation = 0;
  private agentReplyWaiter: ((message: ChatMessage) => void) | null = null;
  private proposalWaiter: ((ref: string) => void) | null = null;
  private cancelWaits: (() => void)[] = [];
  /** Ref of the latest agent proposal observed during the current run. */
  private lastProposalRef: string | null = null;
  /** Board refs created by demo runs, cleaned up on the next start. */
  private demoRefs = new Set<string>();

  constructor(
    private hub: Hub,
    private roster: Roster,
    private db: WorkspaceDb,
    private service: BoardService,
    private workspaceDir: string,
    private seedRoot: string,
    private scripts: Map<string, DemoScript>,
  ) {
    hub.onDemoStart = (channel, actorId) => void this.start(channel, actorId);
    hub.onMessagePosted = (message) => {
      if (message.authorKind === "agent") {
        this.agentReplyWaiter?.(message);
      }
    };
    hub.onBoardEvent = (envelope) => this.onBoardEvent(envelope);
  }

  get channels(): string[] {
    return [...this.scripts.keys()];
  }

  private onBoardEvent(envelope: BoardEventEnvelope): void {
    if (envelope.type === "item.proposed" && this.running) {
      this.demoRefs.add(envelope.item.ref);
      this.lastProposalRef = envelope.item.ref;
      this.proposalWaiter?.(envelope.item.ref);
    }
  }

  /** Always restarts from the top: cancels any in-flight run and clears the channel. */
  private async start(channel: string, actorId: string): Promise<void> {
    const script = this.scripts.get(channel);
    if (!script) return;

    const gen = ++this.generation;
    for (const cancel of [...this.cancelWaits]) cancel();

    // Let a previous run unwind before starting over.
    while (this.running) {
      await delay(50);
      if (gen !== this.generation) return; // superseded by an even newer start
    }
    this.running = true;
    this.lastProposalRef = null;
    console.log(`[demo] starting scripted demo in #${channel}`);

    try {
      await this.hub.clearChannel(actorId, channel);
      await this.cleanupDemoItems(script.personas[0]);
      if (script.seedDir) await this.seedWorkspace(script.seedDir);

      const agentName = this.roster.onlineAgentName();
      if (!agentName) {
        await this.post(script.personas[0], "(demo aborted: no agent is online — start the agent process first)", channel);
        return;
      }

      for (const step of script.steps) {
        await delay(STEP_DELAY_MS);
        if (gen !== this.generation) return;
        await this.post(step.author, step.say.replaceAll("{agent}", agentName), channel);
        if (step.await === "agent_reply") {
          await this.waitForAgentReply(channel, AGENT_TIMEOUT_MS);
          if (gen !== this.generation) return;
        }
        if (step.await === "approve_proposal") {
          await this.approveProposal(step.author, channel);
          if (gen !== this.generation) return;
        }
      }
    } catch (err) {
      console.warn("[demo] aborted:", err instanceof Error ? err.message : err);
    } finally {
      this.running = false;
      if (gen === this.generation) {
        this.removePersonas(script.personas);
      }
      console.log("[demo] finished");
    }
  }

  /** Post a message as a scripted persona through the normal pipeline. */
  private async post(persona: string, content: string, channel: string): Promise<void> {
    const participant = await this.roster.join("human", persona);
    this.hub.broadcastPresence();
    await this.hub.postMessage(participant, content, channel);
  }

  private removePersonas(personas: string[]): void {
    for (const persona of personas) {
      const participant = this.roster.get("human", persona);
      if (participant) this.roster.removeHuman(participant.id);
    }
    this.hub.broadcastPresence();
  }

  /** Copy a fixture tree into the shared workspace before playback. */
  private async seedWorkspace(seedDir: string): Promise<void> {
    await fs.cp(path.join(this.seedRoot, seedDir), path.join(this.workspaceDir, seedDir), {
      recursive: true,
    });
  }

  /**
   * Approve the proposal the agent filed during this run (waiting briefly if
   * it has not landed yet), then wait for the agent's completion reply.
   */
  private async approveProposal(author: string, channel: string): Promise<void> {
    const ref =
      this.lastProposalRef ?? (await this.waitForProposal(AGENT_TIMEOUT_MS));
    const actor = await this.db.upsertActor("human", author);
    const item = await this.service.find(this.db.workspaceId, ref);
    if (!item || item.status !== "proposed") {
      throw new Error(`demo proposal ${ref} is not approvable`);
    }
    await this.service.approve(actor, ref);
    console.log(`[demo] ${author} approved ${ref}`);
    await this.waitForAgentReply(channel, WORK_TIMEOUT_MS);
  }

  /**
   * Best-effort board hygiene: soft-delete leftovers from previous demo runs
   * so restarting the demo does not pile up stale proposals.
   */
  private async cleanupDemoItems(asPersona: string): Promise<void> {
    if (this.demoRefs.size === 0) return;
    const actor = await this.db.upsertActor("human", asPersona);
    for (const ref of this.demoRefs) {
      try {
        const item = await this.service.find(this.db.workspaceId, ref);
        if (item && item.deletedAt == null) await this.service.softDelete(actor, ref);
      } catch (err) {
        console.warn(`[demo] cleanup of ${ref} failed:`, err instanceof Error ? err.message : err);
      }
    }
    this.demoRefs.clear();
  }

  private waitForAgentReply(channel: string, timeoutMs: number): Promise<void> {
    return this.waitFor<ChatMessage>(
      timeoutMs,
      "timed out waiting for agent reply",
      (set) => {
        this.agentReplyWaiter = set;
        return () => (this.agentReplyWaiter = null);
      },
      (message) => (message.channel ?? "general") === channel,
    ).then(() => undefined);
  }

  private waitForProposal(timeoutMs: number): Promise<string> {
    return this.waitFor<string>(
      timeoutMs,
      "timed out waiting for an agent proposal",
      (set) => {
        this.proposalWaiter = set;
        return () => (this.proposalWaiter = null);
      },
      () => true,
    );
  }

  /** Shared cancellable wait plumbing for message/proposal waiters. */
  private waitFor<T>(
    timeoutMs: number,
    timeoutMessage: string,
    register: (notify: (value: T) => void) => () => void,
    accept: (value: T) => boolean,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let unregister = () => {};
      const cleanup = () => {
        clearTimeout(timer);
        unregister();
        this.cancelWaits = this.cancelWaits.filter((c) => c !== cancel);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      const cancel = () => {
        cleanup();
        // Resolved value is unused: the generation check right after the
        // await aborts the superseded loop.
        resolve(undefined as T);
      };
      this.cancelWaits.push(cancel);
      unregister = register((value) => {
        if (!accept(value)) return;
        cleanup();
        resolve(value);
      });
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
