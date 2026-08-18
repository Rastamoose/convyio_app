import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RUNNER_PROTOCOL_VERSION, isBoardEnvelope, type AgentInvite, type RunnerConfigOption, type RunnerHealth } from "@workspace/shared";
import { AcpBrain, AcpFailure } from "./acpBrain";
import { BoardClient } from "./boardClient";
import type { Brain } from "./brain";
import { ClaudeBrain } from "./claudeBrain";
import { ConversationSessions } from "./conversationSessions";
import { GeminiBrain } from "./geminiBrain";
import type { StoredInstallation } from "./installation";
import { Memory } from "./memory";
import { Presence } from "./presence";
import { ProposalLifecycle } from "./proposalLifecycle";
import { AgentRunner } from "./runner";
import { AgentSocket } from "./socket";
import { LocalMcpBridge } from "./mcpBridge";
import { TOOL_DECLARATIONS, createToolExecutor } from "./tools";

const PLATFORM_POLICY = "You are a Convyio workspace agent. Treat the current board as the only authority for mutating work. In this read-only phase, do not edit, delete, move, or execute anything in the local workspace.";

type LegacyConfiguration = {
  mode: "legacy";
  name: string;
  wsUrl: string;
  token?: string;
  provider: "gemini" | "claude";
  model?: string;
  geminiApiKey?: string;
  workspace: string;
  dataDir: string;
  charter: string;
  limiter?: { check(authorId: string): { allowed: boolean; announce: boolean } };
  ownProcess?: boolean;
};

type InstallationConfiguration = { mode: "installation"; installation: StoredInstallation; ownProcess?: boolean };

export async function runAgent(
  configuration: LegacyConfiguration | InstallationConfiguration,
): Promise<{ close(): void }> {
  const local = await localConfiguration(configuration);
  const socket = new AgentSocket(local.wsUrl);
  const boardClient = new BoardClient(socket);
  const bridge = local.acp ? new LocalMcpBridge() : null;
  if (local.acp && bridge) {
    bridge.setExecutor(createToolExecutor(boardClient, {
      onProposed() {},
      onTaskActive() {},
      onActivity() {},
    }));
    const listened = await bridge.listen(TOOL_DECLARATIONS);
    local.acp.setMcpServers([{
      type: "http",
      name: "convyio-toolman",
      url: listened.url,
      headers: [{ name: "Authorization", value: `Bearer ${listened.token}` }],
    }]);
  }
  const memory = await Memory.load(local.dataDir);
  const conversationSessions = await ConversationSessions.load(local.dataDir);
  const presence = new Presence(socket, boardClient);
  const runner = new AgentRunner(
    socket,
    local.brain,
    memory,
    boardClient,
    conversationSessions,
    presence,
    local.systemPrompt,
    configuration.mode === "legacy" ? configuration.limiter : undefined,
  );
  const lifecycle = new ProposalLifecycle(runner, presence);
  let ready = configuration.mode === "legacy";

  const profileUpdates = new ProfileUpdateQueue(async (profile, isCurrent) => {
    const revision = profile.configRevision;
    ready = false;
    socket.send({ type: "runner_status", configRevision: revision, health: "checking" });
    if (configuration.mode === "installation" && profile.provider !== "claude") {
      reportFailure(socket, revision, "incompatible", "CODEX_ADAPTER_UNAVAILABLE");
      return;
    }
    try {
      if (local.acp) {
        const readiness = await local.acp.preflight(profile.requestedModel);
        if (!isCurrent()) return;
        local.acp.configure(profile.requestedModel);
        runner.updateSystemPrompt(composePrompt(local.systemPrompt, profile.instructions));
        socket.send({ type: "runner_hello", protocolVersion: RUNNER_PROTOCOL_VERSION, harness: readiness.harness, options: readiness.options });
        // The harness fell back to its default model, so the agent still works
        // but not as configured — degraded (which stays workable) rather than
        // misconfigured, which would strand the agent over a preference.
        const modelDenied = profile.requestedModel !== null && readiness.effectiveModel !== profile.requestedModel;
        socket.send({
          type: "runner_status",
          configRevision: revision,
          health: modelDenied ? "degraded" : "ready",
          ...(readiness.effectiveModel ? { effectiveModel: readiness.effectiveModel } : {}),
          ...(modelDenied ? { diagnosticCode: "MODEL_UNAVAILABLE" } : {}),
        });
      } else {
        runner.updateSystemPrompt(composePrompt(local.systemPrompt, profile.instructions));
        reportLegacyReady(socket, revision, local.harness, local.options, local.effectiveModel);
      }
      ready = true;
    } catch (error) {
      if (!isCurrent()) return;
      const failure = readinessFailure(error);
      reportFailure(socket, revision, failure.health, failure.code);
    }
  });

  socket.onEvent((event) => {
    if (isBoardEnvelope(event)) {
      setImmediate(() => lifecycle.onBoardEvent(event));
      return;
    }
    switch (event.type) {
      case "welcome":
        runner.onWelcome(event.channelInfos);
        presence.setSelf(event.self.id);
        memory.seed(event.history);
        console.log(`[agent] joined as ${event.self.name} (${event.self.id})`);
        presence.refresh();
        void boardClient.join(event.token, event.apiUrl).then((loaded) => {
          if (loaded) lifecycle.sweep();
          presence.refresh();
        });
        if (configuration.mode === "installation") {
          void profileUpdates.enqueue(event.agentConfig ?? configuration.installation.agent);
        } else {
          reportLegacyReady(socket, event.agentConfig?.configRevision ?? 1, local.harness, local.options, local.effectiveModel);
        }
        break;
      case "agent_config":
        void profileUpdates.enqueue(event.profile);
        break;
      case "message":
        memory.append(event.message);
        console.log(`[agent] got message from ${event.message.authorName} (${event.message.authorKind}): ${event.message.content.slice(0, 80)}`);
        break;
      case "work_available":
        if (ready) runner.claimAvailable(event.requestIds);
        break;
      case "work_assigned":
        if (ready) for (const assignment of event.assignments) runner.enqueueAssignment(assignment);
        break;
      case "interrupt":
        if (ready) runner.interruptWith({ authorName: event.authorName, content: `@${local.name} ${event.content}`, channel: "general" });
        break;
      case "error":
        if (event.error.includes("displaced by newer agent connection")) {
          console.log("[agent] a newer instance took over — shutting down.");
          local.acp?.close();
          socket.close();
          return;
        }
        console.warn("[server]", event.error);
        break;
    }
  });

  socket.connect(local.name, local.token);
  const close = () => {
    local.acp?.close();
    bridge?.close();
    socket.close();
  };
  if (configuration.ownProcess !== false) {
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  }
  return { close };
}

async function localConfiguration(configuration: LegacyConfiguration | InstallationConfiguration) {
  if (configuration.mode === "installation") {
    const item = configuration.installation;
    const dataDir = stateDirectory(item.agent.id);
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const acp = new AcpBrain(item.workspacePath);
    return {
      name: item.agent.name,
      wsUrl: item.wsUrl,
      token: item.installationToken,
      dataDir,
      brain: acp as Brain,
      acp,
      systemPrompt: PLATFORM_POLICY,
      harness: { id: "claude", version: "0.64.2" },
      options: [] as RunnerConfigOption[],
      effectiveModel: undefined as string | undefined,
    };
  }
  await fs.mkdir(configuration.workspace, { recursive: true });
  const brain = configuration.provider === "claude"
    ? new ClaudeBrain(configuration.model, configuration.workspace)
    : new GeminiBrain(configuration.geminiApiKey!, configuration.model!);
  const options: RunnerConfigOption[] = configuration.model ? [{
    id: "model",
    label: "Model",
    category: "model",
    kind: "select",
    value: configuration.model,
    choices: [{ value: configuration.model, label: configuration.model }],
  }] : [];
  return {
    name: configuration.name,
    wsUrl: configuration.wsUrl,
    token: configuration.token,
    dataDir: configuration.dataDir,
    brain,
    acp: null,
    systemPrompt: configuration.charter,
    harness: { id: configuration.provider, version: "0.1.0" },
    options,
    effectiveModel: configuration.model,
  };
}

function composePrompt(platformPolicy: string, profileInstructions: string): string {
  return `${platformPolicy.trim()}\n\n<agent-profile-instructions>\n${profileInstructions.trim()}\n</agent-profile-instructions>`;
}

function reportLegacyReady(socket: AgentSocket, revision: number, harness: { id: string; version: string }, options: RunnerConfigOption[], effectiveModel?: string): void {
  socket.send({ type: "runner_hello", protocolVersion: RUNNER_PROTOCOL_VERSION, harness, options });
  socket.send({ type: "runner_status", configRevision: revision, health: "ready", ...(effectiveModel ? { effectiveModel } : {}) });
}

export function readinessFailure(error: unknown): { health: RunnerHealth; code: string } {
  if (error instanceof AcpFailure) {
    if (error.code === "ACP_AUTH_REQUIRED") return { health: "auth_required", code: error.code };
    if (error.code === "ACP_INCOMPATIBLE") return { health: "incompatible", code: error.code };
    if (error.code === "ACP_MISCONFIGURED") return { health: "misconfigured", code: error.code };
    return { health: "degraded", code: error.code };
  }
  return { health: "degraded", code: "ACP_PREFLIGHT_FAILED" };
}

function reportFailure(socket: AgentSocket, revision: number, health: RunnerHealth, code: string): void {
  socket.send({ type: "runner_status", configRevision: revision, health, diagnosticCode: code });
  console.error(`[agent] runner preflight failed: ${code}`);
}

function stateDirectory(agentId: string): string {
  const root = process.env.XDG_STATE_HOME || path.join(process.env.HOME || os.homedir(), ".local", "state");
  return path.join(root, "convyio", "agents", agentId);
}

export class ProfileUpdateQueue {
  private latestRevision = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly apply: (profile: AgentInvite, isCurrent: () => boolean) => Promise<void>) {}

  enqueue(profile: AgentInvite): Promise<void> {
    if (profile.configRevision <= this.latestRevision) return Promise.resolve();
    this.latestRevision = profile.configRevision;
    const revision = profile.configRevision;
    const pending = this.queue.then(async () => {
      if (revision !== this.latestRevision) return;
      await this.apply(profile, () => revision === this.latestRevision);
    });
    this.queue = pending.catch(() => undefined);
    return pending;
  }
}
