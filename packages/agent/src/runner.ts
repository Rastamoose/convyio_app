import { randomUUID } from "node:crypto";
import type {
  AgentActivityItem,
  AgentRunFinishEvent,
  AgentWorkAssignment,
  Attachment,
  BoardItem,
  ChannelInfo,
  JsonValue,
  NormalizedUsage,
  PermissionMode,
} from "@workspace/shared";
import type { AgentSocket } from "./socket";
import {
  boundedToolInput,
  summarizedToolOutput,
  type Brain,
  type BrainEvent,
} from "./brain";
import type { Memory } from "./memory";
import type { BoardClient } from "./boardClient";
import type { PendingWork } from "./pendingWork";
import type { Presence } from "./presence";
import type { ConversationSessions } from "./conversationSessions";
import { TOOL_DECLARATIONS, createToolExecutor } from "./tools";

export interface WorkItem {
  authorName: string;
  content: string;
  channel: string;
  /** Durable request identity; absent for proposal-resume and interrupt flows. */
  requestId?: string;
  conversationId?: string;
  channelId?: string;
  providerSessionId?: string | null;
  serverProviderSessionId?: string | null;
  permissionMode?: PermissionMode;
  triggerMessageId?: string;
  /** Files the triggering message carried; images are shown to the model. */
  attachments?: Attachment[];
  /** Set when this work resumes an approved board item. */
  taskId?: string;
}

const MAX_IMAGES_PER_RUN = 4;
/** Ceiling on image bytes fetched per run, so one batch can't balloon the request. */
const IMAGE_BYTE_BUDGET = 8 * 1024 * 1024;

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
  private pendingClaims = new Set<string>();
  private claimedRequests = new Set<string>();
  private seenRequests = new Set<string>();
  private finishedRequests = new Map<string, AgentRunFinishEvent>();
  private channelIds = new Map<string, string>();

  constructor(
    private socket: AgentSocket,
    private brain: Brain,
    private memory: Memory,
    private board: BoardClient,
    private pendingWork: PendingWork,
    private conversationSessions: ConversationSessions,
    private presence: Presence,
    private systemPrompt: string,
  ) {}

  /** Profile changes affect the next run; an input already handed to a brain stays immutable. */
  updateSystemPrompt(systemPrompt: string): void {
    this.systemPrompt = systemPrompt;
  }

  /** A reconnect invalidates server claims, but not local queued/running work. */
  onWelcome(channels: ChannelInfo[] = []): void {
    this.pendingClaims.clear();
    this.claimedRequests.clear();
    this.channelIds = new Map(channels.map((channel) => [channel.name, channel.id]));
  }

  claimAvailable(requestIds: string[]): void {
    const claimable = requestIds.filter(
      (id) => !this.pendingClaims.has(id) && !this.claimedRequests.has(id),
    );
    if (claimable.length === 0) return;
    for (const id of claimable) this.pendingClaims.add(id);
    for (let index = 0; index < claimable.length; index += 50) {
      this.socket.send({ type: "work_claim", requestIds: claimable.slice(index, index + 50) });
    }
  }

  enqueueAssignment(assignment: AgentWorkAssignment): void {
    const { request, conversation, trigger } = assignment;
    this.pendingClaims.delete(request.id);
    this.claimedRequests.add(request.id);
    if (this.seenRequests.has(request.id)) {
      const finish = this.finishedRequests.get(request.id);
      if (finish) this.socket.send(finish);
      return;
    }
    this.seenRequests.add(request.id);
    const local = this.conversationSessions.get(conversation.id);
    const providerSessionId = conversation.providerSessionId ?? local?.providerSessionId ?? null;
    void this.conversationSessions
      .set(conversation.id, { providerSessionId, permissionMode: conversation.permissionMode })
      .catch((err) => console.error("[agent] could not persist assigned conversation session:", err));
    this.enqueue({
      requestId: request.id,
      conversationId: conversation.id,
      channelId: request.channelId,
      providerSessionId,
      serverProviderSessionId: conversation.providerSessionId,
      permissionMode: conversation.permissionMode,
      triggerMessageId: trigger.id,
      authorName: trigger.authorName,
      content: trigger.content,
      channel: trigger.channel ?? "general",
      attachments: trigger.attachments,
    });
  }

  enqueue(work: WorkItem): void {
    this.queue.push(work);
    void this.runCycle();
  }

  /** Abort the current run, drop all queued work, and start over on this. */
  interruptWith(work: WorkItem): void {
    this.abortController?.abort();
    this.cancelQueued(this.queue);
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
   * Batch legacy work by channel and durable work by conversation so every
   * finish has one server-valid run scope.
   */
  private nextBatch(): WorkItem[] {
    const first = this.queue[0];
    const channel = first.channelId ?? first.channel;
    const conversationId = first.requestId ? first.conversationId : undefined;
    const batch: WorkItem[] = [];
    let durableRequests = 0;
    for (let index = 0; index < this.queue.length;) {
      const item = this.queue[index];
      const isSameRunScope =
        (item.channelId ?? item.channel) === channel &&
        (conversationId === undefined
          ? item.requestId === undefined
          : item.requestId !== undefined && item.conversationId === conversationId);
      if (!isSameRunScope || (item.requestId !== undefined && durableRequests >= 50)) {
        index += 1;
        continue;
      }
      batch.push(...this.queue.splice(index, 1));
      if (item.requestId) durableRequests += 1;
    }
    return batch;
  }

  private async runBatch(batch: WorkItem[]): Promise<void> {
    const channel = batch[0].channel;
    const channelId = batch[0].channelId ?? this.channelIds.get(channel) ?? channel;
    const requestIds = batch.flatMap((item) => item.requestId ?? []);
    const conversationItem = batch.find((item) => item.conversationId);
    const conversationId = conversationItem?.conversationId ?? null;
    const providerSessionId = conversationItem?.providerSessionId ?? null;
    const serverProviderSessionId = conversationItem?.serverProviderSessionId ?? null;
    const permissionMode = conversationItem?.permissionMode ?? "default";
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
    const activity = channelId
      ? createActivityBatcher(this.socket, runId, channelId, conversationId)
      : null;
    const providerSessionEvents = new Map<string, string>();
    let latestProviderSessionId = providerSessionId;
    let streamedText = "";
    let reportedUsage: NormalizedUsage | undefined;
    const onBrainEvent = (event: BrainEvent) => {
      const clientEventId = activity?.push(event);
      if (event.type === "provider.session") {
        latestProviderSessionId = event.providerSessionId;
        if (clientEventId) providerSessionEvents.set(event.providerSessionId, clientEventId);
      } else if (event.type === "usage.reported") {
        reportedUsage = event.usage;
      }
      if (event.type === "output.delta") {
        streamedText += event.text;
        this.socket.send({ type: "trace_chunk", runId, chunk: { kind: "text", content: event.text } });
      } else if (event.type === "thought.delta") {
        this.socket.send({ type: "trace_chunk", runId, chunk: { kind: "thought", content: event.text } });
      }
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
      onActivity: (line) => onBrainEvent({ type: "thought.delta", text: `[toolman] ${line}` }),
      conversationId,
    });

    const { images, notes } = await this.gatherImages(batch);
    let finalText = "";
    let error: string | undefined;
    let usage: NormalizedUsage | undefined;
    let outcome: AgentRunFinishEvent["outcome"] = "completed";

    try {
      const result = await this.brain.run(
        {
          system: this.systemPrompt,
          context: this.buildContext(),
          prompt: buildPrompt(batch, channel, notes),
          images,
          tools: TOOL_DECLARATIONS,
        },
        { onEvent: onBrainEvent },
        { signal, onToolCall: executeTool, providerSessionId, permissionMode },
      );
      finalText = result.text;
      usage = result.usage ?? reportedUsage;
      latestProviderSessionId = result.providerSessionId;
    } catch (err) {
      if (signal.aborted) {
        outcome = "cancelled";
        console.log(`[agent] run ${runId.slice(0, 8)} interrupted`);
      } else {
        outcome = "failed";
        const detail = err instanceof Error ? err.message : String(err);
        error = "Brain run failed";
        finalText = streamedText.trim() || friendlyErrorMessage(detail);
        console.error("[agent] run failed:", detail);
      }
    } finally {
      activity?.flush();
      this.abortController = null;
    }

    usage ??= reportedUsage;
    if (conversationId) {
      await this.persistConversationSession(
        conversationId,
        latestProviderSessionId,
        serverProviderSessionId,
        permissionMode,
        providerSessionEvents.get(latestProviderSessionId ?? ""),
      );
    }

    const finalContent = outcome === "cancelled" ? "" : finalText.slice(0, 4_000);
    this.sendFinish({
      type: "agent_run_finish",
      runId,
      channelId,
      conversationId,
      requestIds,
      outcome,
      finalContent,
      ...(error ? { error } : {}),
      ...(usage ? { usage } : {}),
    });
    console.log(`[agent] run ${runId.slice(0, 8)} ${outcome} (${finalContent.length} chars)`);
    this.activeTask = null;
  }

  private async persistConversationSession(
    conversationId: string,
    providerSessionId: string | null,
    serverProviderSessionId: string | null,
    permissionMode: PermissionMode,
    clientEventId: string | undefined,
  ): Promise<void> {
    try {
      await this.conversationSessions.set(conversationId, { providerSessionId, permissionMode });
    } catch (err) {
      console.error("[agent] could not persist conversation session:", err);
    }
    if (providerSessionId === serverProviderSessionId) return;
    this.socket.send({
      type: "conversation_session_set",
      conversationId,
      providerSessionId,
      permissionMode,
      ...(clientEventId ? { clientEventId } : {}),
    });
  }

  private sendFinish(event: AgentRunFinishEvent): void {
    for (const requestId of event.requestIds) {
      this.finishedRequests.set(requestId, event);
      this.claimedRequests.delete(requestId);
    }
    this.socket.send(event);
  }

  private cancelQueued(items: WorkItem[]): void {
    for (const item of items) {
      if (!item.requestId) continue;
      this.sendFinish({
        type: "agent_run_finish",
        runId: randomUUID(),
        channelId: item.channelId ?? this.channelIds.get(item.channel) ?? item.channel,
        conversationId: item.conversationId ?? null,
        requestIds: [item.requestId],
        outcome: "cancelled",
        finalContent: "",
      });
    }
  }

  private buildContext(): string {
    return (
      `Current board (the only source of authority for mutating work):\n` +
      `${this.board.summary()}\n\n` +
      `Recent chat transcript:\n${this.memory.context()}`
    );
  }

  /**
   * Fetch the batch's planned images for the model, plus prompt notes for
   * every attachment it will not see. A failed fetch downgrades that image
   * to a note instead of failing the run.
   */
  private async gatherImages(
    batch: WorkItem[],
  ): Promise<{ images: { mimeType: string; data: string }[]; notes: string[] }> {
    const plan = planAttachments(batch);
    const notes = plan.omitted.map(
      (a) => `[attachment ${a.name} (${a.mime}, ${a.size} bytes) attached — not shown]`,
    );
    for (const a of plan.tooLarge) notes.push(`[image ${a.name} omitted: too large]`);

    const images: { mimeType: string; data: string }[] = [];
    for (const image of plan.fetch) {
      try {
        const { mime, data } = await this.board.fetchAttachment(image.url);
        images.push({ mimeType: mime, data });
      } catch (err) {
        console.warn(`[agent] could not fetch image ${image.name}:`, err);
        notes.push(`[image ${image.name} unavailable]`);
      }
    }
    return { images, notes };
  }
}

function createActivityBatcher(
  socket: AgentSocket,
  runId: string,
  channelId: string,
  conversationId: string | null,
): { push(event: BrainEvent): string; flush(): void } {
  let pending: AgentActivityItem[] = [];
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (pending.length === 0) return;
    socket.send({ type: "activity_batch", events: pending });
    pending = [];
  };
  const append = (
    kind: AgentActivityItem["kind"],
    payload: AgentActivityItem["payload"],
    subjectId?: string,
  ) => {
    const item: AgentActivityItem = {
      clientEventId: randomUUID(),
      kind,
      channelId,
      conversationId,
      runId,
      ...(subjectId ? { subjectId: boundedId(subjectId) } : {}),
      payload,
    };
    pending.push(item);
    if (pending.length === 50) flush();
    else if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
    return item.clientEventId;
  };
  return {
    push(event) {
      if (event.type === "output.delta" || event.type === "thought.delta") {
        const kind = event.type === "output.delta" ? "agent.output.delta" : "agent.thought.delta";
        let firstId = "";
        for (let offset = 0; offset < Math.max(event.text.length, 1); offset += 4_000) {
          const id = append(kind, { text: event.text.slice(offset, offset + 4_000) });
          if (!firstId) firstId = id;
        }
        return firstId;
      }
      switch (event.type) {
        case "plan.updated":
          return append(
            "agent.plan.updated",
            { plan: boundedActivityValue(boundedToolInput(event.plan)) },
            event.toolCallId,
          );
        case "tool.started":
          return append(
            "agent.tool.started",
            {
              name: event.name.slice(0, 1_000),
              source: event.source,
              input: boundedActivityValue(boundedToolInput(event.input)),
            },
            event.toolCallId,
          );
        case "tool.progress":
          return append(
            "agent.tool.progress",
            {
              name: event.name.slice(0, 1_000),
              progress: boundedActivityValue(boundedToolInput(event.progress)),
            },
            event.toolCallId,
          );
        case "tool.completed":
          return append(
            "agent.tool.completed",
            {
              name: event.name.slice(0, 1_000),
              ...(event.output === undefined
                ? {}
                : { output: boundedActivityValue(summarizedToolOutput(event.output)) }),
            },
            event.toolCallId,
          );
        case "tool.failed":
          return append(
            "agent.tool.failed",
            { name: event.name.slice(0, 1_000), error: "Tool failed" },
            event.toolCallId,
          );
        case "usage.reported":
          return append("agent.usage.reported", { usage: event.usage });
        case "provider.session":
          return append("agent.provider.session", { captured: true });
      }
    },
    flush,
  };
}

function boundedId(value: string): string {
  return value.slice(0, 128) || "unknown";
}

function boundedActivityValue(value: JsonValue): JsonValue {
  const bytes = JSON.stringify(value).length;
  return bytes <= 12_000 ? value : `[payload omitted:${bytes} bytes]`;
}

/**
 * Decide which of the batch's attachments the model gets as image parts:
 * only image/* mimes, capped at the MAX_IMAGES_PER_RUN most recent, skipping
 * any that would push the total past IMAGE_BYTE_BUDGET. Everything else is
 * only described in the prompt text.
 */
function planAttachments(batch: WorkItem[]): {
  fetch: Attachment[];
  tooLarge: Attachment[];
  omitted: Attachment[];
} {
  const all = batch.flatMap((m) => m.attachments ?? []);
  const images = all.filter((a) => a.mime.startsWith("image/"));
  const recent = images.slice(-MAX_IMAGES_PER_RUN);
  const fetch: Attachment[] = [];
  const tooLarge: Attachment[] = [];
  let budget = IMAGE_BYTE_BUDGET;
  for (const image of recent) {
    if (image.size <= budget) {
      fetch.push(image);
      budget -= image.size;
    } else {
      tooLarge.push(image);
    }
  }
  const omitted = all.filter((a) => !recent.includes(a));
  return { fetch, tooLarge, omitted };
}

function buildPrompt(items: WorkItem[], channel: string, attachmentNotes: string[]): string {
  const formatted = items
    .map((m) => `- ${m.authorName}: ${m.content}`)
    .join("\n");
  const notes = attachmentNotes.length > 0 ? `\n${attachmentNotes.join("\n")}` : "";
  return (
    `Messages addressed to you (all in #${channel}):\n${formatted}${notes}\n\n` +
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
