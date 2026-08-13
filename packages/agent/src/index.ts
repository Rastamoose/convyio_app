import fs from "node:fs/promises";
import { isBoardEnvelope } from "@workspace/shared";
import {
  AGENT_MODEL,
  AGENT_NAME,
  AGENT_PROVIDER,
  AGENT_TOKEN,
  CHARTER_PATH,
  CLAUDE_WORKDIR,
  DATA_DIR,
  GEMINI_API_KEY,
  WS_URL,
} from "./config";
import { AgentSocket } from "./socket";
import type { Brain } from "./brain";
import { GeminiBrain } from "./geminiBrain";
import { ClaudeBrain } from "./claudeBrain";
import { Memory } from "./memory";
import { BoardClient } from "./boardClient";
import { PendingWork } from "./pendingWork";
import { Presence } from "./presence";
import { AgentRunner } from "./runner";
import { ProposalLifecycle } from "./proposalLifecycle";
import { ConversationSessions } from "./conversationSessions";

async function loadCharter(): Promise<string> {
  try {
    return await fs.readFile(CHARTER_PATH, "utf-8");
  } catch (err) {
    console.warn("[agent] could not load charter, using default prompt:", err);
    return `You are ${AGENT_NAME}, a helpful workspace assistant. Respond only when directly addressed.`;
  }
}

function createBrain(): Brain {
  if (AGENT_PROVIDER === "claude") {
    return new ClaudeBrain(AGENT_MODEL, CLAUDE_WORKDIR);
  }
  if (AGENT_PROVIDER === "gemini") {
    return new GeminiBrain(GEMINI_API_KEY!, AGENT_MODEL!);
  }
  throw new Error("codex provider is not yet supported");
}

async function main() {
  if (AGENT_PROVIDER === "gemini" && !GEMINI_API_KEY) {
    console.error("[agent] Missing GEMINI_API_KEY. Set it in the environment and restart.");
    process.exit(1);
  }
  if (AGENT_PROVIDER === "codex") {
    console.error("[agent] Codex provider is not yet supported.");
    process.exit(1);
  }

  const systemPrompt = await loadCharter();
  const socket = new AgentSocket(WS_URL);
  const boardClient = new BoardClient(socket);
  if (AGENT_PROVIDER === "claude") {
    await fs.mkdir(CLAUDE_WORKDIR, { recursive: true });
  }
  const brain = createBrain();
  const memory = await Memory.load(DATA_DIR);
  const pendingWork = await PendingWork.load(DATA_DIR);
  const conversationSessions = await ConversationSessions.load(DATA_DIR);
  const presence = new Presence(socket, boardClient);
  const runner = new AgentRunner(
    socket,
    brain,
    memory,
    boardClient,
    pendingWork,
    conversationSessions,
    presence,
    systemPrompt,
  );
  const lifecycle = new ProposalLifecycle(boardClient, pendingWork, runner, presence);

  socket.onEvent((event) => {
    if (isBoardEnvelope(event)) {
      // Give the BoardClient's own listener a tick to update its cache first.
      setImmediate(() => lifecycle.onBoardEvent(event));
      return;
    }
    switch (event.type) {
      case "welcome":
        runner.onWelcome();
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
        break;
      case "work_available":
        runner.claimAvailable(event.requestIds);
        break;
      case "work_assigned":
        for (const assignment of event.assignments) runner.enqueueAssignment(assignment);
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

  socket.connect(AGENT_NAME, AGENT_TOKEN);

  process.on("SIGINT", () => {
    socket.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[agent] fatal:", err);
  process.exit(1);
});
