import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  InitializeResponse,
  ReadTextFileRequest,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
  ToolCallStatus,
  Usage,
} from "@agentclientprotocol/sdk";
import type { NormalizedUsage, RunnerConfigOption } from "@workspace/shared";
import { boundedToolInput, buildPromptText, summarizedToolOutput, type Brain, type BrainCallbacks, type BrainInput, type BrainResult, type BrainRunOptions } from "./brain";
import { isSafeAcpKind } from "./nativeTools";

export type AcpReadiness = {
  harness: { id: string; version: string };
  options: RunnerConfigOption[];
  effectiveModel?: string;
};

export class AcpFailure extends Error {
  constructor(
    readonly code: "ACP_AUTH_REQUIRED" | "ACP_INCOMPATIBLE" | "ACP_MISCONFIGURED" | "ACP_MALFORMED_OUTPUT" | "ACP_PROCESS_EXITED",
    message: string,
  ) {
    super(message);
    this.name = "AcpFailure";
  }
}

type ActiveRun = {
  callbacks: BrainCallbacks;
  text: string;
  tools: Map<string, { name: string; status?: ToolCallStatus }>;
  usage?: NormalizedUsage;
};

type SessionState = { sessionId: string; configOptions: SessionConfigOption[] };

export class AcpBrain implements Brain {
  private process: ChildProcessWithoutNullStreams | null = null;
  private connection: acp.ClientConnection | null = null;
  private context: acp.ClientContext | null = null;
  private initialization: InitializeResponse | null = null;
  private startup: Promise<void> | null = null;
  private spareSession: SessionState | null = null;
  private sessions = new Map<string, SessionState>();
  private activeRuns = new Map<string, ActiveRun>();
  private requestedModel: string | null = null;
  private stderr = "";
  private mcpServers: { name: string; url: string; headers?: Record<string, string> }[] = [];

  constructor(
    private readonly workspace: string,
    private readonly testAgent?: acp.AgentApp,
  ) {}

  setMcpServers(servers: { name: string; url: string; headers?: Record<string, string> }[]): void {
    this.mcpServers = servers;
  }

  async preflight(requestedModel: string | null): Promise<AcpReadiness> {
    await this.ensureStarted();
    this.spareSession ??= await this.newSession();
    const effectiveModel = await this.applyRequestedModel(this.spareSession, requestedModel);
    return {
      harness: {
        id: "claude",
        version: this.initialization?.agentInfo?.version ?? "0.64.2",
      },
      options: toRunnerOptions(this.spareSession.configOptions),
      ...(effectiveModel ? { effectiveModel } : {}),
    };
  }

  configure(requestedModel: string | null): void {
    this.requestedModel = requestedModel;
  }

  async run(input: BrainInput, callbacks: BrainCallbacks, options?: BrainRunOptions): Promise<BrainResult> {
    await this.ensureStarted();
    const session = await this.sessionFor(options?.providerSessionId ?? null);
    await this.applyRequestedModel(session, this.requestedModel);
    const active: ActiveRun = { callbacks, text: "", tools: new Map() };
    this.activeRuns.set(session.sessionId, active);
    callbacks.onEvent({ type: "provider.session", providerSessionId: session.sessionId });

    const abort = () => {
      void this.context?.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
      setTimeout(() => {
        if (this.activeRuns.has(session.sessionId)) this.stopProcess();
      }, 2_000).unref();
    };
    options?.signal?.addEventListener("abort", abort, { once: true });
    try {
      const prompt = promptBlocks(input);
      const response = await this.contextOrThrow().request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt,
      });
      if (response.stopReason === "cancelled" || options?.signal?.aborted) throw new Error("ACP run cancelled");
      const usage = response.usage ? normalizedUsage(response.usage) : active.usage;
      if (usage) callbacks.onEvent({ type: "usage.reported", usage });
      return { text: active.text, providerSessionId: session.sessionId, ...(usage ? { usage } : {}) };
    } catch (error) {
      if (options?.signal?.aborted) throw new Error("ACP run cancelled");
      throw this.typedFailure(error);
    } finally {
      options?.signal?.removeEventListener("abort", abort);
      this.activeRuns.delete(session.sessionId);
    }
  }

  close(): void {
    this.connection?.close();
    this.stopProcess();
  }

  private async ensureStarted(): Promise<void> {
    if (this.context) return;
    this.startup ??= this.start();
    await this.startup;
  }

  private async start(): Promise<void> {
    const app = acp
      .client({ name: "convyio-agent" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => permissionDecision(this.workspace, ctx.params))
      .onRequest(acp.methods.client.fs.readTextFile, (ctx) => readWorkspaceFile(this.workspace, ctx.params))
      .onNotification(acp.methods.client.session.update, (ctx) => this.onSessionUpdate(ctx.params));
    if (this.testAgent) {
      this.connection = app.connect(this.testAgent);
    } else {
      const executable = resolveClaudeAcpExecutable();
      await verifyClaudeAuthentication(executable, this.workspace);
      const child = spawn(process.execPath, [executable], {
        cwd: this.workspace,
        env: sanitizedChildEnvironment(process.env),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.process = child;
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        this.stderr = `${this.stderr}${chunk}`.slice(-4_000);
      });
      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      );
      this.connection = app.connect(stream);
    }
    this.context = this.connection.agent;
    try {
      const initialized = await this.context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
        clientInfo: { name: "convyio-agent", version: "0.1.0" },
      });
      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new AcpFailure("ACP_INCOMPATIBLE", `Claude ACP selected unsupported protocol v${initialized.protocolVersion}.`);
      }
      this.initialization = initialized;
    } catch (error) {
      this.stopProcess();
      throw this.typedFailure(error);
    }
  }

  private async newSession(): Promise<SessionState> {
    try {
      const response = await this.contextOrThrow().request(acp.methods.agent.session.new, {
        cwd: this.workspace,
        mcpServers: [],
      });
      const created = response as { sessionId: string; configOptions?: SessionConfigOption[] };
      const state = { sessionId: created.sessionId, configOptions: created.configOptions ?? [] };
      this.sessions.set(state.sessionId, state);
      return state;
    } catch (error) {
      throw this.typedFailure(error);
    }
  }

  private async sessionFor(providerSessionId: string | null): Promise<SessionState> {
    if (!providerSessionId) {
      const session = this.spareSession ?? await this.newSession();
      this.spareSession = null;
      return session;
    }
    const existing = this.sessions.get(providerSessionId);
    if (existing) return existing;
    if (!this.initialization?.agentCapabilities?.loadSession) {
      throw new AcpFailure("ACP_INCOMPATIBLE", "Claude ACP does not support loading conversation sessions.");
    }
    try {
      const response = await this.contextOrThrow().request(acp.methods.agent.session.load, {
        sessionId: providerSessionId,
        cwd: this.workspace,
        mcpServers: [],
      });
      const loaded = response as { configOptions?: SessionConfigOption[] };
      const state = { sessionId: providerSessionId, configOptions: loaded.configOptions ?? [] };
      this.sessions.set(providerSessionId, state);
      return state;
    } catch (error) {
      throw this.typedFailure(error);
    }
  }

  /**
   * Resolves the profile's model preference against what this harness actually
   * offers, and returns what will really be used. A model the harness does not
   * advertise falls back to the harness default rather than failing: the
   * preference is stored server-side and can outlive the harness version that
   * accepted it, and a stale preference must not take the agent offline. The
   * caller reports the difference (see runtime.ts) as a degraded runner.
   */
  private async applyRequestedModel(session: SessionState, requestedModel: string | null): Promise<string | undefined> {
    const modelOption = session.configOptions.find((option) => option.category === "model");
    const harnessDefault = modelOption?.type === "select" ? modelOption.currentValue : undefined;
    if (!requestedModel) return harnessDefault;
    if (!modelOption || modelOption.type !== "select") return harnessDefault;
    const values = selectChoices(modelOption).map((choice) => choice.value);
    if (!values.includes(requestedModel)) return harnessDefault;
    if (modelOption.currentValue !== requestedModel) {
      const response = await this.contextOrThrow().request(acp.methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: modelOption.id,
        value: requestedModel,
      });
      session.configOptions = response.configOptions;
    }
    return requestedModel;
  }

  private onSessionUpdate(notification: SessionNotification): void {
    const active = this.activeRuns.get(notification.sessionId);
    if (!active) return;
    mapUpdate(notification.update, active);
  }

  private contextOrThrow(): acp.ClientContext {
    if (!this.context) throw new AcpFailure("ACP_PROCESS_EXITED", "Claude ACP process is not running.");
    return this.context;
  }

  private typedFailure(error: unknown): Error {
    if (error instanceof AcpFailure) return error;
    const detail = error instanceof Error ? error.message : String(error);
    const combined = `${detail}\n${this.stderr}`.toLowerCase();
    if (/auth|login|credential|unauthorized/.test(combined)) {
      return new AcpFailure("ACP_AUTH_REQUIRED", "Claude authentication is required. Run `claude login`, then restart convyio-agent.");
    }
    if (this.process && this.process.exitCode !== null) {
      return new AcpFailure("ACP_PROCESS_EXITED", `Claude ACP exited unexpectedly (code ${this.process.exitCode}).`);
    }
    return new AcpFailure("ACP_MALFORMED_OUTPUT", `Claude ACP communication failed: ${detail}`);
  }

  private stopProcess(): void {
    if (this.process && !this.process.killed) this.process.kill("SIGTERM");
    this.connection?.close();
    this.process = null;
    this.connection = null;
    this.context = null;
    this.startup = null;
  }
}

export function sanitizedChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const exact = new Set([
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP", "LANG", "LANGUAGE", "LC_ALL", "NO_COLOR",
    "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR",
  ]);
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (exact.has(key) || key.startsWith("LC_"))) result[key] = value;
  }
  return result;
}

export async function readWorkspaceFile(workspace: string, request: ReadTextFileRequest): Promise<{ content: string }> {
  const realWorkspace = await fs.realpath(workspace);
  const requested = path.resolve(workspace, request.path);
  rejectSensitivePath(realWorkspace, requested);
  requireSafeWorkspacePath(realWorkspace, await fs.realpath(requested));
  const handle = await fs.open(requested, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actualPath = await openFilePath(handle, requested);
    requireSafeWorkspacePath(realWorkspace, actualPath);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("ACP file read rejected: path is not a regular file.");
    if (stat.size > 1024 * 1024) throw new Error("ACP file read rejected: file exceeds 1 MiB.");
    const buffer = Buffer.alloc(Number(stat.size) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1024 * 1024) throw new Error("ACP file read rejected: file exceeds 1 MiB.");
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    if (!request.line && !request.limit) return { content };
    const lines = content.split("\n");
    const start = Math.max((request.line ?? 1) - 1, 0);
    return { content: lines.slice(start, request.limit ? start + request.limit : undefined).join("\n") };
  } finally {
    await handle.close();
  }
}

export async function permissionDecision(workspace: string, request: RequestPermissionRequest) {
  const kind = request.toolCall.kind;
  const allow = kind === "read"
    ? await readPermissionAllowed(workspace, request.toolCall)
    : isSafeAcpKind(kind);
  const desired = allow ? "allow_once" : "reject_once";
  const option = request.options.find((candidate) => candidate.kind === desired)
    ?? request.options.find((candidate) => candidate.kind.startsWith(allow ? "allow" : "reject"));
  return option
    ? { outcome: { outcome: "selected" as const, optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" as const } };
}

async function readPermissionAllowed(workspace: string, toolCall: RequestPermissionRequest["toolCall"]): Promise<boolean> {
  const paths: string[] = [];
  let inspectable = true;
  for (const location of toolCall.locations ?? []) {
    if (typeof location.path !== "string" || location.path.length === 0) inspectable = false;
    else paths.push(location.path);
  }
  inspectable = collectInputPaths(toolCall.rawInput, paths) && inspectable;
  if (!inspectable || paths.length === 0) return false;
  try {
    const realWorkspace = await fs.realpath(workspace);
    for (const candidate of paths) {
      const requested = path.resolve(workspace, candidate);
      rejectSensitivePath(realWorkspace, requested);
      const realCandidate = await fs.realpath(requested);
      requireSafeWorkspacePath(realWorkspace, realCandidate);
    }
    return true;
  } catch {
    return false;
  }
}

function collectInputPaths(value: unknown, paths: string[], depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value !== "object") return true;
  if (Array.isArray(value)) return value.every((item) => collectInputPaths(item, paths, depth + 1));
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.replace(/[_-]/g, "").toLowerCase();
    if (normalized.endsWith("path") || normalized.endsWith("paths")) {
      const values = Array.isArray(item) ? item : [item];
      if (values.length === 0 || values.some((candidate) => typeof candidate !== "string" || candidate.length === 0)) return false;
      paths.push(...values as string[]);
    } else if (!collectInputPaths(item, paths, depth + 1)) {
      return false;
    }
  }
  return true;
}

function requireSafeWorkspacePath(realWorkspace: string, candidate: string): void {
  if (candidate !== realWorkspace && !candidate.startsWith(`${realWorkspace}${path.sep}`)) {
    throw new Error("ACP file read rejected: path is outside the paired workspace.");
  }
  rejectSensitivePath(realWorkspace, candidate);
}

function rejectSensitivePath(realWorkspace: string, candidate: string): void {
  const relativeParts = path.relative(realWorkspace, candidate).split(path.sep);
  if (relativeParts.some(isSensitiveName) || relativeParts.some((name) => [".ssh", ".aws", ".gnupg", ".kube", ".docker"].includes(name.toLowerCase()))) {
    throw new Error("ACP file read rejected: sensitive credential file.");
  }
}

async function openFilePath(handle: FileHandle, requested: string): Promise<string> {
  for (const link of [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`]) {
    try {
      return await fs.realpath(link);
    } catch {}
  }
  const candidate = await fs.realpath(requested);
  const [opened, resolved] = await Promise.all([handle.stat(), fs.stat(candidate)]);
  if (opened.dev !== resolved.dev || opened.ino !== resolved.ino) {
    throw new Error("ACP file read rejected: path changed while being opened.");
  }
  return candidate;
}

async function verifyClaudeAuthentication(executable: string, workspace: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [executable, "--cli", "auth", "status"], {
      cwd: workspace,
      env: sanitizedChildEnvironment(process.env),
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.once("error", (error) => reject(new AcpFailure("ACP_PROCESS_EXITED", `Could not start Claude authentication check: ${error.message}`)));
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else if (signal) reject(new AcpFailure("ACP_PROCESS_EXITED", `Claude authentication check ended with ${signal}.`));
      else reject(new AcpFailure("ACP_AUTH_REQUIRED", "Claude authentication is required. Run `claude login`, then restart convyio-agent."));
    });
  });
}

function resolveClaudeAcpExecutable(): string {
  const require = createRequire(import.meta.url);
  return require.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js");
}

function promptBlocks(input: BrainInput): Array<acp.ContentBlock> {
  const blocks: Array<acp.ContentBlock> = [{ type: "text", text: `<system>\n${input.system}\n</system>\n\n${buildPromptText(input)}` }];
  for (const image of input.images ?? []) blocks.push({ type: "image", mimeType: image.mimeType, data: image.data });
  return blocks;
}

function mapUpdate(update: SessionUpdate, active: ActiveRun): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type === "text") {
        active.text += update.content.text;
        active.callbacks.onEvent({ type: "output.delta", text: update.content.text });
      }
      break;
    case "agent_thought_chunk":
      if (update.content.type === "text") active.callbacks.onEvent({ type: "thought.delta", text: update.content.text });
      break;
    case "plan":
      active.callbacks.onEvent({ type: "plan.updated", toolCallId: "acp-plan", plan: boundedToolInput(update.entries) });
      break;
    case "plan_update":
      active.callbacks.onEvent({ type: "plan.updated", toolCallId: update.plan.planId, plan: boundedToolInput(update.plan) });
      break;
    case "tool_call": {
      const name = update.name ?? update.title;
      active.tools.set(update.toolCallId, { name, status: update.status });
      active.callbacks.onEvent({ type: "tool.started", toolCallId: update.toolCallId, name, source: "native", input: boundedToolInput(update.rawInput) });
      emitToolEnd(active, update.toolCallId, name, update.status, update.rawOutput);
      break;
    }
    case "tool_call_update": {
      const previous = active.tools.get(update.toolCallId);
      const name = update.name ?? previous?.name ?? update.title ?? "tool";
      active.tools.set(update.toolCallId, { name, status: update.status ?? previous?.status });
      if (update.status === "in_progress") {
        active.callbacks.onEvent({ type: "tool.progress", toolCallId: update.toolCallId, name, progress: boundedToolInput(update.rawOutput ?? update.content ?? null) });
      }
      emitToolEnd(active, update.toolCallId, name, update.status, update.rawOutput);
      break;
    }
    case "usage_update": {
      const usage: NormalizedUsage = {
        totalTokens: update.used,
        ...(update.cost?.currency === "USD" ? { costUsd: update.cost.amount } : {}),
      };
      active.usage = usage;
      active.callbacks.onEvent({ type: "usage.reported", usage });
      break;
    }
  }
}

function emitToolEnd(active: ActiveRun, toolCallId: string, name: string, status: ToolCallStatus | null | undefined, output: unknown): void {
  if (status === "completed") active.callbacks.onEvent({ type: "tool.completed", toolCallId, name, output: summarizedToolOutput(output) });
  if (status === "failed") active.callbacks.onEvent({ type: "tool.failed", toolCallId, name, error: "ACP tool failed" });
}

function normalizedUsage(usage: Usage): NormalizedUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.thoughtTokens == null ? {} : { thoughtTokens: usage.thoughtTokens }),
    ...(usage.cachedReadTokens == null ? {} : { cacheReadTokens: usage.cachedReadTokens }),
    ...(usage.cachedWriteTokens == null ? {} : { cacheWriteTokens: usage.cachedWriteTokens }),
  };
}

function toRunnerOptions(options: SessionConfigOption[]): RunnerConfigOption[] {
  return options.flatMap((option): RunnerConfigOption[] => {
    if (!["model", "model_config", "thought_level", "mode"].includes(option.category ?? "")) return [];
    const category = option.category as RunnerConfigOption["category"];
    if (option.type === "boolean") return [{ id: option.id, label: option.name, category, kind: "boolean", value: option.currentValue }];
    const choices = selectChoices(option).slice(0, 50);
    if (choices.length === 0) return [];
    return [{ id: option.id, label: option.name, category, kind: "select", value: option.currentValue, choices }];
  }).slice(0, 32);
}

function selectChoices(option: Extract<SessionConfigOption, { type: "select" }>): Array<{ value: string; label: string }> {
  return option.options.flatMap((choice) => "options" in choice
    ? choice.options.map((nested) => ({ value: nested.value, label: nested.name }))
    : [{ value: choice.value, label: choice.name }]);
}

function isSensitiveName(name: string): boolean {
  return /^\.env(?:\..*)?$/i.test(name)
    || /^\.(?:netrc|npmrc|pypirc)$/i.test(name)
    || /^(?:credentials?(?:\..*)?|secrets?(?:\..*)?|auth(?:entication|orization)?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*private[-_.]?key.*|.*\.(?:pem|key|p12|pfx))$/i.test(name);
}
