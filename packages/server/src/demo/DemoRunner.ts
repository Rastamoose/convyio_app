import fs from "node:fs/promises";
import path from "node:path";
import type { BoardEventEnvelope, ChatMessage } from "@workspace/shared";
import type { Hub } from "../hub";
import type { BoardDb } from "../board/db";
import type { BoardService } from "../board/BoardService";
import { SEED_FILES } from "./billingSeed";

interface Step {
  author: string;
  content: string;
  /** Pause after posting until an agent replies in the demo channel. */
  waitForAgent?: boolean;
  /**
   * After posting, approve the agent proposal filed during this run as
   * `author`, then wait for the agent's completion reply (long timeout —
   * the agent does real gated work here).
   */
  approveProposal?: boolean;
}

interface DemoScript {
  personas: string[];
  build(agent: string): Step[];
  /** Optional setup before playback (e.g. seed workspace files). */
  setup?: (runner: DemoRunner) => Promise<void>;
}

const STEP_DELAY_MS = 4500;
const AGENT_TIMEOUT_MS = 90_000;
/** Post-approval the agent starts, edits files, and completes — allow longer. */
const WORK_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Script: #demo — marketing copy drafting (context-aware chat assistant)
// ---------------------------------------------------------------------------

const COPY_SCRIPT: DemoScript = {
  personas: ["alex", "blair"],
  build: (agent) => [
    {
      author: "alex",
      content:
        'team — launch is Friday. the landing page hero still says "AI workspace beta" and it reads flat',
    },
    {
      author: "blair",
      content:
        'yeah and we still don\'t have a one-liner for the HN post. we agreed the angle is "your team and your agents in one room" but nothing is written',
    },
    {
      author: "alex",
      content:
        'constraints: no buzzwords, under 10 words for the hero, and don\'t use the word "platform" — we keep sounding like everyone else',
    },
    {
      author: "blair",
      content:
        "also the HN crowd hates marketing speak, it should sound like it was written by an engineer",
    },
    {
      author: "alex",
      content: `@${agent} read the conversation above. draft 3 options for the landing page hero line and 3 options for the HN post one-liner. respect the constraints we discussed.`,
      waitForAgent: true,
    },
    {
      author: "blair",
      content: `@${agent} hero option 2 is closest. make it punchier and drop any mention of AI — the product is the room, not the model`,
      waitForAgent: true,
    },
    {
      author: "alex",
      content: `@${agent} give me the final picks: one hero line, one HN one-liner, nothing else`,
      waitForAgent: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// Script: #demo-bug — a real engineering flow: the agent investigates seeded
// billing code, proposes a fix plan behind the approval gate, a teammate's
// constraint lands BEFORE any code is written, then the approved work runs.
// ---------------------------------------------------------------------------

const BUG_SCRIPT: DemoScript = {
  personas: ["maya", "tom"],
  setup: (runner) => runner.seedWorkspace(),
  build: (agent) => [
    {
      author: "maya",
      content:
        "heads up — Meridian Accounting escalated this morning: every multi-currency invoice is off by a few cents per line item. their accountants are flagging each one by hand",
    },
    {
      author: "tom",
      content:
        "I can reproduce it. it's worse than one bug — the in-app invoice, the PDF export, and the ledger all show slightly different totals for the same invoice",
    },
    {
      author: "maya",
      content: `@${agent} before anyone touches code: read the files under billing/ in the workspace, find the root cause of the rounding discrepancy, and file a board proposal with your fix plan. do NOT modify any files yet.`,
      waitForAgent: true,
    },
    {
      author: "tom",
      content: `@${agent} hold on before that gets approved — ledger-sync has to keep matching what Stripe already charged, to the cent. if rounding changes there, reconciliation breaks for every past invoice. confirm your plan leaves ledger-sync's output unchanged; don't file a new proposal, just restate the corrected plan here in chat.`,
      waitForAgent: true,
    },
    {
      author: "maya",
      content:
        "good catch — that would have shipped broken and we'd have caught it in PR review after the work was done. approving the proposal now.",
      approveProposal: true,
    },
    {
      author: "tom",
      content:
        "one run, one review. the ledger constraint got in front of the agent before the code existed instead of in a review comment after.",
    },
  ],
};

const SCRIPTS: Record<string, DemoScript> = {
  demo: COPY_SCRIPT,
  "demo-bug": BUG_SCRIPT,
};

/** Channels the server can play a scripted demo in. */
export const DEMO_CHANNELS = Object.keys(SCRIPTS);

/**
 * Plays a scripted conversation into a channel through the hub's
 * synthetic-participant API, pausing between lines and waiting for real agent
 * replies (and, for the bug demo, a real board proposal + approval). Pure demo
 * scaffolding — the hub itself stays dumb.
 */
export class DemoRunner {
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
    private db: BoardDb,
    private service: BoardService,
    private workspaceDir: string,
  ) {
    hub.onDemoStart = (channel) => void this.start(channel);
    hub.onMessagePosted = (message) => {
      if (message.authorKind === "agent") {
        this.agentReplyWaiter?.(message);
      }
    };
    hub.onBoardEvent = (envelope) => this.onBoardEvent(envelope);
  }

  /** (Re)write the fake billing module the bug demo investigates. */
  async seedWorkspace(): Promise<void> {
    const dir = path.join(this.workspaceDir, "billing");
    await fs.mkdir(dir, { recursive: true });
    for (const [name, content] of Object.entries(SEED_FILES)) {
      await fs.writeFile(path.join(dir, name), content, "utf-8");
    }
  }

  private onBoardEvent(envelope: BoardEventEnvelope): void {
    if (envelope.type === "item.proposed" && this.running) {
      this.demoRefs.add(envelope.item.ref);
      this.lastProposalRef = envelope.item.ref;
      this.proposalWaiter?.(envelope.item.ref);
    }
  }

  /** Always restarts from the top: cancels any in-flight run and clears the channel. */
  private async start(channel: string): Promise<void> {
    const script = SCRIPTS[channel];
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
      await this.hub.clearChannel(channel);
      this.cleanupDemoItems(script.personas[0]);
      await script.setup?.(this);

      const agentName = this.hub.findOnlineAgentName();
      if (!agentName) {
        await this.hub.postAsSynthetic(
          script.personas[0],
          "(demo aborted: no agent is online — start the agent process first)",
          channel,
        );
        return;
      }

      for (const step of script.build(agentName)) {
        await delay(STEP_DELAY_MS);
        if (gen !== this.generation) return;
        await this.hub.postAsSynthetic(step.author, step.content, channel);
        if (step.waitForAgent) {
          await this.waitForAgentReply(channel, AGENT_TIMEOUT_MS);
          if (gen !== this.generation) return;
        }
        if (step.approveProposal) {
          await this.approveProposal(step.author, channel);
          if (gen !== this.generation) return;
        }
      }
    } catch (err) {
      console.warn("[demo] aborted:", err instanceof Error ? err.message : err);
    } finally {
      this.running = false;
      if (gen === this.generation) {
        this.hub.removeSynthetic(script.personas);
      }
      console.log("[demo] finished");
    }
  }

  /**
   * Approve the proposal the agent filed during this run (waiting briefly if
   * it has not landed yet), then wait for the agent's completion reply.
   */
  private async approveProposal(author: string, channel: string): Promise<void> {
    const ref =
      this.lastProposalRef ?? (await this.waitForProposal(AGENT_TIMEOUT_MS));
    const actor = this.db.upsertActor("human", author);
    const item = this.service.find(this.db.serverId, ref);
    if (!item || item.status !== "proposed") {
      throw new Error(`demo proposal ${ref} is not approvable`);
    }
    this.service.approve(actor, ref);
    console.log(`[demo] ${author} approved ${ref}`);
    await this.waitForAgentReply(channel, WORK_TIMEOUT_MS);
  }

  /**
   * Best-effort board hygiene: soft-delete leftovers from previous demo runs
   * so restarting the demo does not pile up stale proposals.
   */
  private cleanupDemoItems(asPersona: string): void {
    if (this.demoRefs.size === 0) return;
    const actor = this.db.upsertActor("human", asPersona);
    for (const ref of this.demoRefs) {
      try {
        const item = this.service.find(this.db.serverId, ref);
        if (item && item.deletedAt == null) this.service.softDelete(actor, ref);
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
