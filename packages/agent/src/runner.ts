import { randomUUID } from "node:crypto";
import type { BoardItem } from "@workspace/shared";
import type { AgentSocket } from "./socket";
import type { GeminiBrain } from "./geminiBrain";
import type { Memory } from "./memory";
import type { BoardClient } from "./boardClient";
import type { PendingWork } from "./pendingWork";
import type { Presence } from "./presence";
import { TOOL_DECLARATIONS, createToolExecutor } from "./tools";

export interface WorkItem {
  authorName: string;
  content: string;
  channel: string;
  /** Set when this work resumes an approved board item. */
  taskId?: string;
}

/**
 * Owns the work queue and the run cycle: batches queued work per channel,
 * runs the brain with the board tools, and emits trace/summary frames.
 */
export class AgentRunner {
  private queue: WorkItem[] = [];
  private runInFlight = false;
  private abortController: AbortController | null = null;
  /** The board item the agent is actively executing against, if any. */
  private activeTask: BoardItem | null = null;

  constructor(
    private socket: AgentSocket,
    private brain: GeminiBrain,
    private memory: Memory,
    private board: BoardClient,
    private pendingWork: PendingWork,
    private presence: Presence,
    private systemPrompt: string,
  ) {}

  enqueue(work: WorkItem): void {
    this.queue.push(work);
    void this.runCycle();
  }

  /** Abort the current run, drop all queued work, and start over on this. */
  interruptWith(work: WorkItem): void {
    this.abortController?.abort();
    this.queue.length = 0;
    this.enqueue(work);
  }

  /** Halt the current run if it executes against the given board item (I4). */
  abortIfWorkingOn(itemId: string): boolean {
    if (this.activeTask?.id !== itemId) return false;
    this.abortController?.abort();
    return true;
  }

  private async runCycle(): Promise<void> {
    if (this.runInFlight) return;
    this.runInFlight = true;

    try {
      while (this.queue.length > 0) {
        // Wait briefly before the agent appears as "working" or starts streaming.
        await new Promise((resolve) => setTimeout(resolve, 500));
        await this.runBatch(this.nextBatch());
        this.presence.endRun();
      }
    } finally {
      this.activeTask = null;
      this.runInFlight = false;
      this.presence.endRun();
    }
  }

  /**
   * Batch only work from the same channel so the reply lands where it was
   * asked; remaining channels are handled on the next loop pass.
   */
  private nextBatch(): WorkItem[] {
    const channel = this.queue[0].channel;
    const batch: WorkItem[] = [];
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].channel === channel) {
        batch.unshift(...this.queue.splice(i, 1));
      }
    }
    return batch;
  }

  private async runBatch(batch: WorkItem[]): Promise<void> {
    const channel = batch[0].channel;
    const authorNames = Array.from(new Set(batch.map((m) => m.authorName)));
    const resumedTaskId = batch.find((m) => m.taskId)?.taskId;
    const resumedItem = resumedTaskId ? this.board.resolve(resumedTaskId) : undefined;
    const runId = randomUUID();
    console.log(`[agent] starting run ${runId.slice(0, 8)} for ${authorNames.join(", ")}`);

    this.activeTask = resumedItem ?? null;
    const humanAuthors = authorNames.filter((n) => n !== "system");
    this.presence.working(
      resumedItem
        ? `Working on ${resumedItem.ref}…`
        : humanAuthors.length > 0
          ? `Replying to ${humanAuthors.join(", ")}…`
          : "Catching up on the board…",
      resumedItem?.id ?? null,
    );
    this.socket.send({ type: "trace_start", runId });

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    let finalText = "";
    let producedOutput = false;
    let aborted = false;

    const emitChunk = (kind: "thought" | "text", content: string) => {
      producedOutput = true;
      this.socket.send({ type: "trace_chunk", runId, chunk: { kind, content } });
    };

    const executeTool = createToolExecutor(this.board, {
      onProposed: (item) => {
        this.pendingWork.set(item.id, {
          origin: batch.map((m) => `${m.authorName}: ${m.content}`).join("\n"),
          channel,
        });
      },
      onTaskActive: (item) => {
        if (this.activeTask?.id === item.id) return;
        this.activeTask = item;
        this.presence.working(`Working on ${item.ref}…`, item.id);
      },
      onActivity: (line) => emitChunk("thought", `[toolman] ${line}`),
    });

    try {
      finalText = await this.brain.run(
        {
          system: this.systemPrompt,
          context: this.buildContext(),
          prompt: buildPrompt(batch, channel),
          tools: TOOL_DECLARATIONS,
        },
        {
          onThought: (thought) => emitChunk("thought", thought),
          onText: (text) => emitChunk("text", text),
        },
        { signal, onToolCall: executeTool },
      );
    } catch (err) {
      if (signal.aborted) {
        aborted = true;
        console.log(`[agent] run ${runId.slice(0, 8)} interrupted`);
      } else {
        const detail = err instanceof Error ? err.message : String(err);
        console.error("[agent] run failed:", detail);
        if (!producedOutput) {
          finalText = friendlyErrorMessage(detail);
        }
      }
    } finally {
      this.abortController = null;
    }

    if (!aborted) {
      this.socket.send({ type: "summary", runId, content: finalText, channel });
      console.log(`[agent] run ${runId.slice(0, 8)} summary sent (${finalText.length} chars)`);
    } else {
      this.socket.send({ type: "run_end", runId, reason: "aborted" });
      console.log(`[agent] run ${runId.slice(0, 8)} aborted`);
    }
    this.activeTask = null;
  }

  private buildContext(): string {
    return (
      `Current board (the only source of authority for mutating work):\n` +
      `${this.board.summary()}\n\n` +
      `Recent chat transcript:\n${this.memory.context()}`
    );
  }
}

function buildPrompt(items: WorkItem[], channel: string): string {
  const formatted = items
    .map((m) => `- ${m.authorName}: ${m.content}`)
    .join("\n");
  return (
    `Messages addressed to you (all in #${channel}):\n${formatted}\n\n` +
    `Reply in #${channel}. Transcript lines from other channels are background ` +
    `context only — never answer or continue them here. Address each sender by ` +
    `name (e.g. "harris: …" or a natural greeting using their name) so it is ` +
    `clear who you are answering.`
  );
}

function friendlyErrorMessage(detail: string): string {
  const lower = detail.toLowerCase();
  if (lower.includes("api key not valid") || lower.includes("unauthorized") || lower.includes("authentication")) {
    return "Sorry, my API key isn't working. Please ask the workspace owner to check it.";
  }
  if (lower.includes("not found") || lower.includes("unsupported model") || lower.includes("does not support")) {
    return "Sorry, the configured model isn't available right now. Try a different one or check back later.";
  }
  if (lower.includes("rate limit") || lower.includes("quota") || lower.includes("exhausted")) {
    return "Sorry, I've hit a rate limit. Give me a moment and try again.";
  }
  if (lower.includes("network") || lower.includes("fetch") || lower.includes("econnrefused")) {
    return "Sorry, I can't reach my brain right now. Check the network and try again.";
  }
  return "Sorry, something went wrong while I was thinking. Please try again.";
}
