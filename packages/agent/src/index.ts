import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { ChatMessage } from "@workspace/shared";
import { AGENT_NAME, CHARTER_PATH, DATA_DIR, GEMINI_API_KEY, WS_URL } from "./config";
import { AgentSocket } from "./socket";
import { GeminiBrain } from "./brain/GeminiBrain";
import { Memory } from "./memory";

if (!GEMINI_API_KEY) {
  console.error("[agent] Missing GEMINI_API_KEY. Set it in the environment and restart.");
  process.exit(1);
}

const socket = new AgentSocket(WS_URL);
const brain = new GeminiBrain(GEMINI_API_KEY);
const memory = new Memory(DATA_DIR);

let systemPrompt: string;
let participantId: string | null = null;
let runInFlight = false;
let runAbortController: AbortController | null = null;
const mentionQueue: { authorName: string; content: string; channel: string }[] = [];

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

function buildPrompt(items: { authorName: string; content: string }[]): string {
  const formatted = items
    .map((m) => `- ${m.authorName}: ${m.content}`)
    .join("\n");
  return (
    `Messages addressed to you:\n${formatted}\n\n` +
    `Reply in the workspace chat. Address each sender by name (e.g. "harris: …" ` +
    `or a natural greeting using their name) so it is clear who you are answering.`
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

async function runWorkCycle(): Promise<void> {
  if (runInFlight) return;
  runInFlight = true;

  try {
    while (mentionQueue.length > 0) {
      // Wait briefly before the agent appears as "working" or starts streaming.
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Batch only mentions from the same channel so the reply lands where
      // it was asked; remaining channels are handled on the next loop pass.
      const channel = mentionQueue[0].channel;
      const batch: typeof mentionQueue = [];
      for (let i = mentionQueue.length - 1; i >= 0; i--) {
        if (mentionQueue[i].channel === channel) {
          batch.unshift(...mentionQueue.splice(i, 1));
        }
      }
      const authorNames = Array.from(new Set(batch.map((m) => m.authorName)));
      const runId = randomUUID();
      console.log(`[agent] starting run ${runId.slice(0, 8)} for ${authorNames.join(", ")}`);

      socket.send({
        type: "status_update",
        status: `Replying to ${authorNames.join(", ")}…`,
        runState: "working",
      });
      socket.send({ type: "trace_start", runId });

      runAbortController = new AbortController();
      const signal = runAbortController.signal;

      const traceChunks: { kind: "thought" | "text"; content: string }[] = [];
      let finalText = "";
      let producedOutput = false;
      let aborted = false;

      try {
        finalText = await brain.run(
          {
            system: systemPrompt,
            context: memory.context(),
            prompt: buildPrompt(batch),
          },
          {
            onThought: (thought) => {
              producedOutput = true;
              const chunk = { kind: "thought" as const, content: thought };
              traceChunks.push(chunk);
              socket.send({ type: "trace_chunk", runId, chunk });
            },
            onText: (text) => {
              producedOutput = true;
              const chunk = { kind: "text" as const, content: text };
              traceChunks.push(chunk);
              socket.send({ type: "trace_chunk", runId, chunk });
            },
          },
          { signal },
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
      socket.send({ type: "status_update", status: "", runState: "idle" });
    }
  } finally {
    runInFlight = false;
  }
}

async function main() {
  systemPrompt = await loadCharter();
  await memory.init();

  socket.onEvent((event) => {
    switch (event.type) {
      case "welcome":
        participantId = event.self.id;
        memory.seed(event.history);
        console.log(`[agent] joined as ${event.self.name} (${event.self.id})`);
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
          mentionQueue.push({
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
        mentionQueue.length = 0;
        mentionQueue.push({
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
