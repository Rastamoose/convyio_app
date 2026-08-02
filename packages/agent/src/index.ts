import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import {
  isBoardEnvelope,
  type BoardEventEnvelope,
  type BoardItem,
  type ChatMessage,
} from "@workspace/shared";
import { AGENT_NAME, CHARTER_PATH, DATA_DIR, GEMINI_API_KEY, WS_URL } from "./config";
import { AgentSocket } from "./socket";
import { GeminiBrain } from "./brain/GeminiBrain";
import { Memory } from "./memory";
import { BoardClient } from "./boardClient";
import { TOOL_DECLARATIONS, createToolExecutor } from "./tools";

if (!GEMINI_API_KEY) {
  console.error("[agent] Missing GEMINI_API_KEY. Set it in the environment and restart.");
  process.exit(1);
}

const socket = new AgentSocket(WS_URL);
const boardClient = new BoardClient(socket);
const brain = new GeminiBrain(GEMINI_API_KEY);
const memory = new Memory(DATA_DIR);

interface WorkItem {
  authorName: string;
  content: string;
  channel: string;
  /** Set when this work resumes an approved board item. */
  taskId?: string;
}

let systemPrompt: string;
let participantId: string | null = null;
let runInFlight = false;
let runAbortController: AbortController | null = null;
/** The board item the agent is actively executing against, if any. */
let activeTask: BoardItem | null = null;
const workQueue: WorkItem[] = [];
/** Work stashed while its proposal awaits a human decision, keyed by item id. */
const pendingWork = new Map<string, { origin: string; channel: string }>();

async function loadCharter(): Promise<string> {
  try {
    return await fs.readFile(CHARTER_PATH, "utf-8");
  } catch (err) {
    console.warn("[agent] could not load charter, using default prompt:", err);
    return `You are ${AGENT_NAME}, a helpful workspace assistant. Respond only when directly addressed.`;
  }
}

const mentionRegex = new RegExp(`@${AGENT_NAME}\\b`, "i");

function isMention(message: ChatMessage): boolean {
  return message.authorKind === "human" && mentionRegex.test(message.content);
}

function buildPrompt(items: WorkItem[]): string {
  const formatted = items
    .map((m) => `- ${m.authorName}: ${m.content}`)
    .join("\n");
  return (
    `Messages addressed to you:\n${formatted}\n\n` +
    `Reply in the workspace chat. Address each sender by name (e.g. "harris: …" ` +
    `or a natural greeting using their name) so it is clear who you are answering.`
  );
}

function buildContext(): string {
  return (
    `Current board (the only source of authority for mutating work):\n` +
    `${boardClient.summary()}\n\n` +
    `Recent chat transcript:\n${memory.context()}`
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

/**
 * Broadcast the agent's between-runs availability: red/blocked while any of
 * its proposals await a human decision, orange/idle otherwise.
 */
function updateAvailability(): void {
  if (runInFlight) return;
  const proposed = participantId ? boardClient.myProposedItems(participantId) : [];
  if (proposed.length > 0) {
    const refs = proposed.map((i) => i.ref).join(", ");
    socket.send({
      type: "status_update",
      status: `Blocked — awaiting approval (${refs})`,
      runState: "blocked",
      taskId: proposed[0].id,
    });
  } else {
    socket.send({ type: "status_update", status: "", runState: "idle", taskId: null });
  }
}

async function runWorkCycle(): Promise<void> {
  if (runInFlight) return;
  runInFlight = true;

  try {
    while (workQueue.length > 0) {
      // Wait briefly before the agent appears as "working" or starts streaming.
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Batch only work from the same channel so the reply lands where it was
      // asked; remaining channels are handled on the next loop pass.
      const channel = workQueue[0].channel;
      const batch: WorkItem[] = [];
      for (let i = workQueue.length - 1; i >= 0; i--) {
        if (workQueue[i].channel === channel) {
          batch.unshift(...workQueue.splice(i, 1));
        }
      }
      const authorNames = Array.from(new Set(batch.map((m) => m.authorName)));
      const resumedTask = batch.find((m) => m.taskId)?.taskId;
      const resumedItem = resumedTask ? boardClient.resolve(resumedTask) : undefined;
      const runId = randomUUID();
      console.log(`[agent] starting run ${runId.slice(0, 8)} for ${authorNames.join(", ")}`);

      activeTask = resumedItem ?? null;
      const humanAuthors = authorNames.filter((n) => n !== "system");
      socket.send({
        type: "status_update",
        status: resumedItem
          ? `Working on ${resumedItem.ref}…`
          : humanAuthors.length > 0
            ? `Replying to ${humanAuthors.join(", ")}…`
            : "Catching up on the board…",
        runState: "working",
        taskId: resumedItem?.id ?? null,
      });
      socket.send({ type: "trace_start", runId });

      runAbortController = new AbortController();
      const signal = runAbortController.signal;

      let finalText = "";
      let producedOutput = false;
      let aborted = false;

      const emitChunk = (kind: "thought" | "text", content: string) => {
        producedOutput = true;
        socket.send({ type: "trace_chunk", runId, chunk: { kind, content } });
      };

      const executeTool = createToolExecutor(boardClient, {
        onProposed: (item) => {
          pendingWork.set(item.id, {
            origin: batch.map((m) => `${m.authorName}: ${m.content}`).join("\n"),
            channel,
          });
        },
        onTaskActive: (item) => {
          if (activeTask?.id === item.id) return;
          activeTask = item;
          socket.send({
            type: "status_update",
            status: `Working on ${item.ref}…`,
            runState: "working",
            taskId: item.id,
          });
        },
        onActivity: (line) => emitChunk("thought", `[toolman] ${line}`),
      });

      try {
        finalText = await brain.run(
          {
            system: systemPrompt,
            context: buildContext(),
            prompt: buildPrompt(batch),
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
        runAbortController = null;
      }

      if (!aborted) {
        socket.send({ type: "summary", runId, content: finalText, channel });
        console.log(`[agent] run ${runId.slice(0, 8)} summary sent (${finalText.length} chars)`);
      } else {
        socket.send({ type: "run_end", runId, reason: "aborted" });
        console.log(`[agent] run ${runId.slice(0, 8)} aborted`);
      }
      activeTask = null;
      runInFlight = false;
      updateAvailability();
      runInFlight = true;
    }
  } finally {
    activeTask = null;
    runInFlight = false;
    updateAvailability();
  }
}

/**
 * React to board events: resume approved proposals, drop denied ones, and
 * halt work whose backing item was deleted (I4).
 */
function onBoardEvent(envelope: BoardEventEnvelope): void {
  const { item } = envelope;

  if (envelope.type === "item.deleted") {
    if (activeTask && activeTask.id === item.id) {
      console.log(`[agent] ${item.ref} deleted mid-run — halting`);
      runAbortController?.abort();
      workQueue.push({
        authorName: "system",
        content:
          `Board item ${item.ref} ("${item.title}") was DELETED by ${envelope.actor.display_name}. ` +
          `The work it authorized is halted; the toolman will refuse further actions on it. ` +
          `Briefly acknowledge this in chat.`,
        channel: "general",
      });
      void runWorkCycle();
    }
    pendingWork.delete(item.id);
    updateAvailability();
    return;
  }

  const work = pendingWork.get(item.id);
  if (!work) {
    updateAvailability();
    return;
  }

  if (envelope.type === "item.approved") {
    pendingWork.delete(item.id);
    console.log(`[agent] ${item.ref} approved — resuming`);
    workQueue.push({
      authorName: "system",
      content:
        `Your proposal ${item.ref} ("${item.title}") was APPROVED by ${envelope.actor.display_name}. ` +
        `Call board_start("${item.ref}"), do the work it authorizes using ${item.ref} as the ` +
        `board_item_ref for mutating actions, and call board_complete("${item.ref}") when finished. ` +
        `Original request:\n${work.origin}`,
      channel: work.channel,
      taskId: item.id,
    });
    void runWorkCycle();
  } else if (envelope.type === "item.denied") {
    pendingWork.delete(item.id);
    console.log(`[agent] ${item.ref} denied — dropping`);
    const reason = typeof envelope.payload.reason === "string" ? envelope.payload.reason : null;
    workQueue.push({
      authorName: "system",
      content:
        `Your proposal ${item.ref} ("${item.title}") was DENIED by ${envelope.actor.display_name}` +
        `${reason ? ` with reason: ${reason}` : ""}. ` +
        `Drop that line of work. Briefly acknowledge this in chat; do not re-propose it.`,
      channel: work.channel,
    });
    void runWorkCycle();
  }
  updateAvailability();
}

async function main() {
  systemPrompt = await loadCharter();
  await memory.init();

  // Re-derive blocked/idle once the board cache lands after (re)join, so a
  // restarted agent with outstanding proposals shows blocked immediately.
  boardClient.onRefreshed = () => updateAvailability();

  socket.onEvent((event) => {
    if (isBoardEnvelope(event)) {
      // Give the BoardClient's own listener a tick to update its cache first.
      setImmediate(() => onBoardEvent(event));
      return;
    }
    switch (event.type) {
      case "welcome":
        participantId = event.self.id;
        memory.seed(event.history);
        console.log(`[agent] joined as ${event.self.name} (${event.self.id})`);
        updateAvailability();
        break;
      case "message":
        memory.append(event.message);
        console.log(
          `[agent] got message from ${event.message.authorName} (${event.message.authorKind}): ${event.message.content.slice(0, 80)}`,
        );
        if (event.message.authorKind === "agent") return;
        if (event.message.content.trimStart().toLowerCase().startsWith("/interrupt")) return;
        if (isMention(event.message)) {
          console.log("[agent] mention detected, queueing");
          workQueue.push({
            authorName: event.message.authorName,
            content: event.message.content,
            channel: event.message.channel ?? "general",
          });
          void runWorkCycle();
        }
        break;
      case "interrupt": {
        console.log(`[agent] interrupted by ${event.authorName}: ${event.content.slice(0, 80)}`);
        runAbortController?.abort();
        workQueue.length = 0;
        workQueue.push({
          authorName: event.authorName,
          content: `@${AGENT_NAME} ${event.content}`,
          channel: "general",
        });
        void runWorkCycle();
        break;
      }
      case "error":
        if (event.error.includes("displaced by newer agent connection")) {
          console.log("[agent] a newer instance took over — shutting down.");
          socket.close();
          process.exit(0);
        }
        console.warn("[server]", event.error);
        break;
    }
  });

  socket.connect(AGENT_NAME);

  process.on("SIGINT", () => {
    socket.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[agent] fatal:", err);
  process.exit(1);
});
