import fs from "node:fs/promises";
import { isBoardEnvelope, type ChatMessage } from "@workspace/shared";
import {
  AGENT_MODEL,
  AGENT_NAME,
  CHARTER_PATH,
  DATA_DIR,
  GEMINI_API_KEY,
  WS_URL,
} from "./config";
import { AgentSocket } from "./socket";
import { GeminiBrain } from "./geminiBrain";
import { Memory } from "./memory";
import { BoardClient } from "./boardClient";
import { PendingWork } from "./pendingWork";
import { Presence } from "./presence";
import { AgentRunner } from "./runner";
import { ProposalLifecycle } from "./proposalLifecycle";

const mentionRegex = new RegExp(`@${AGENT_NAME}\\b`, "i");

function isMention(message: ChatMessage): boolean {
  return message.authorKind === "human" && mentionRegex.test(message.content);
}

async function loadCharter(): Promise<string> {
  try {
    return await fs.readFile(CHARTER_PATH, "utf-8");
  } catch (err) {
    console.warn("[agent] could not load charter, using default prompt:", err);
    return `You are ${AGENT_NAME}, a helpful workspace assistant. Respond only when directly addressed.`;
  }
}

async function main() {
  if (!GEMINI_API_KEY) {
    console.error("[agent] Missing GEMINI_API_KEY. Set it in the environment and restart.");
    process.exit(1);
  }

  const systemPrompt = await loadCharter();
  const socket = new AgentSocket(WS_URL);
  const boardClient = new BoardClient(socket);
  const brain = new GeminiBrain(GEMINI_API_KEY, AGENT_MODEL);
  const memory = await Memory.load(DATA_DIR);
  const pendingWork = await PendingWork.load(DATA_DIR);
  const presence = new Presence(socket, boardClient);
  const runner = new AgentRunner(socket, brain, memory, boardClient, pendingWork, presence, systemPrompt);
  const lifecycle = new ProposalLifecycle(boardClient, pendingWork, runner, presence);

  socket.onEvent((event) => {
    if (isBoardEnvelope(event)) {
      // Give the BoardClient's own listener a tick to update its cache first.
      setImmediate(() => lifecycle.onBoardEvent(event));
      return;
    }
    switch (event.type) {
      case "welcome":
        presence.setSelf(event.self.id);
        memory.seed(event.history);
        console.log(`[agent] joined as ${event.self.name} (${event.self.id})`);
        presence.refresh();
        void boardClient.join(event.token, event.apiUrl).then((loaded) => {
          // Sweep only against a fresh snapshot; a failed load must not make
          // stashed work look decided or deleted.
          if (loaded) lifecycle.sweep();
          presence.refresh();
        });
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
          runner.enqueue({
            authorName: event.message.authorName,
            content: event.message.content,
            channel: event.message.channel ?? "general",
          });
        }
        break;
      case "interrupt":
        console.log(`[agent] interrupted by ${event.authorName}: ${event.content.slice(0, 80)}`);
        runner.interruptWith({
          authorName: event.authorName,
          content: `@${AGENT_NAME} ${event.content}`,
          channel: "general",
        });
        break;
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
