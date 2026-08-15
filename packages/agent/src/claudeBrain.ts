import {
  query as claudeQuery,
  tool,
  createSdkMcpServer as claudeCreateSdkMcpServer,
  type CanUseTool,
  type HookCallback,
  type Options,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { NormalizedUsage } from "@workspace/shared";
import { z } from "zod";
import { isSafeClaudeNativeTool, SAFE_CLAUDE_NATIVE_TOOLS } from "./nativeTools";
import {
  boundedToolInput,
  buildPromptText,
  isPlanTool,
  summarizedToolOutput,
  type Brain,
  type BrainCallbacks,
  type BrainEvent,
  type BrainInput,
  type BrainResult,
  type BrainRunOptions,
  type ToolDeclaration,
  type ToolExecutor,
} from "./brain";

// Claude counts total agent turns (including every native-tool call), not
// tool-call rounds like MAX_TOOL_ROUNDS does for Gemini — a materially
// different unit, so this needs its own, more generous cap rather than
// reusing that constant.
export const CLAUDE_MAX_TURNS = 40;

export class ClaudeBrain implements Brain {
  private query = claudeQuery;
  private createSdkMcpServer = claudeCreateSdkMcpServer;

  constructor(
    private model: string | undefined,
    private cwd: string,
  ) {}

  async run(input: BrainInput, callbacks: BrainCallbacks, options?: BrainRunOptions): Promise<BrainResult> {
    const activity = { happened: false };
    const trackedCallbacks: BrainCallbacks = {
      onEvent: (event) => {
        if (isRetryUnsafe(event)) activity.happened = true;
        callbacks.onEvent(event);
      },
    };

    try {
      return await this.runQuery(input, trackedCallbacks, options, this.model, activity);
    } catch (err) {
      if (this.model === undefined || activity.happened || !isModelUnavailable(err)) throw err;
      return this.runQuery(input, trackedCallbacks, options, undefined, activity);
    }
  }

  private async runQuery(
    input: BrainInput,
    callbacks: BrainCallbacks,
    options: BrainRunOptions | undefined,
    model: string | undefined,
    activity: { happened: boolean },
  ): Promise<BrainResult> {
    const abortController = new AbortController();
    if (options?.signal) {
      if (options.signal.aborted) abortController.abort();
      options.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }

    let providerSessionId = options?.providerSessionId ?? null;
    const captureSession = (sessionId: string | undefined) => {
      if (!sessionId || sessionId === providerSessionId) return;
      providerSessionId = sessionId;
      callbacks.onEvent({ type: "provider.session", providerSessionId: sessionId });
    };
    const hooks = createToolHooks(callbacks, captureSession);
    const boardToolNames = new Set(
      input.tools?.length && options?.onToolCall
        ? input.tools.map((decl) => `mcp__board__${decl.name}`)
        : [],
    );
    const boardServer =
      input.tools?.length && options?.onToolCall
        ? this.createSdkMcpServer({
            name: "board",
            version: "1.0.0",
            tools: input.tools.map((decl) =>
              toSdkTool(decl, async (name, args) => {
                activity.happened = true;
                return options.onToolCall!(name, args);
              }),
            ),
          })
        : undefined;

    const canUseTool: CanUseTool = async (toolName) => {
      activity.happened = true;
      if (isSafeClaudeNativeTool(toolName) || boardToolNames.has(toolName)) {
        return { behavior: "allow" };
      }
      return { behavior: "deny", message: `Tool ${toolName} is not approved for native execution.` };
    };
    const claudeOptions: Options = {
      ...(model ? { model } : {}),
      ...(providerSessionId ? { resume: providerSessionId } : {}),
      ...(options?.permissionMode
        ? {
            permissionMode:
              options.permissionMode === "approveAll" || options.permissionMode === "bypass"
                ? "acceptEdits"
                : options.permissionMode,
          }
        : {}),
      cwd: this.cwd,
      systemPrompt: input.system,
      abortController,
      includePartialMessages: true,
      maxTurns: CLAUDE_MAX_TURNS,
      tools: [...SAFE_CLAUDE_NATIVE_TOOLS],
      canUseTool,
      hooks,
      ...(boardServer ? { mcpServers: { board: boardServer } } : {}),
    };

    const stream = this.query({ prompt: buildClaudePrompt(input), options: claudeOptions });

    let finalText = "";
    let usage: NormalizedUsage | undefined;
    for await (const message of stream) {
      if ("session_id" in message) captureSession(message.session_id);
      if (message.type === "stream_event") {
        const event = message.event;
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            callbacks.onEvent({ type: "output.delta", text: event.delta.text });
            finalText += event.delta.text;
          } else if (event.delta.type === "thinking_delta") {
            callbacks.onEvent({ type: "thought.delta", text: event.delta.thinking });
          }
        }
      } else if (message.type === "result") {
        usage = normalizeClaudeUsage(message);
        if (usage) callbacks.onEvent({ type: "usage.reported", usage });
        if (message.subtype === "success") {
          finalText = message.result;
        } else {
          throw new Error(
            `claude agent sdk error (${message.subtype}): ${message.errors.join("; ") || "no details"}`,
          );
        }
      }
    }

    return { text: finalText.trim() || "(no response)", providerSessionId, usage };
  }
}

function createToolHooks(
  callbacks: BrainCallbacks,
  captureSession: (sessionId: string | undefined) => void,
): NonNullable<Options["hooks"]> {
  const states = new Map<string, "started" | "completed" | "failed">();
  const start = (toolCallId: string, name: string, input: unknown) => {
    if (states.has(toolCallId)) return;
    states.set(toolCallId, "started");
    callbacks.onEvent({
      type: "tool.started",
      toolCallId,
      name,
      source: name.startsWith("mcp__") ? "mcp" : "native",
      input: boundedToolInput(input),
    });
    if (isPlanTool(name)) {
      callbacks.onEvent({ type: "plan.updated", toolCallId, plan: boundedToolInput(input) });
    }
  };
  const preToolUse: HookCallback = async (hook) => {
    if (hook.hook_event_name !== "PreToolUse") return {};
    captureSession(hook.session_id);
    start(hook.tool_use_id, hook.tool_name, hook.tool_input);
    return {};
  };
  const postToolUse: HookCallback = async (hook) => {
    if (hook.hook_event_name !== "PostToolUse") return {};
    captureSession(hook.session_id);
    start(hook.tool_use_id, hook.tool_name, hook.tool_input);
    if (states.get(hook.tool_use_id) !== "started") return {};
    states.set(hook.tool_use_id, "completed");
    callbacks.onEvent({
      type: "tool.completed",
      toolCallId: hook.tool_use_id,
      name: hook.tool_name,
      output: summarizedToolOutput(hook.tool_response),
    });
    return {};
  };
  const postToolUseFailure: HookCallback = async (hook) => {
    if (hook.hook_event_name !== "PostToolUseFailure") return {};
    captureSession(hook.session_id);
    start(hook.tool_use_id, hook.tool_name, hook.tool_input);
    if (states.get(hook.tool_use_id) !== "started") return {};
    states.set(hook.tool_use_id, "failed");
    callbacks.onEvent({
      type: "tool.failed",
      toolCallId: hook.tool_use_id,
      name: hook.tool_name,
      error: hook.error.slice(0, 1_000),
    });
    return {};
  };
  return {
    PreToolUse: [{ hooks: [preToolUse] }],
    PostToolUse: [{ hooks: [postToolUse] }],
    PostToolUseFailure: [{ hooks: [postToolUseFailure] }],
  };
}

function normalizeClaudeUsage(message: SDKResultMessage): NormalizedUsage | undefined {
  const models = Object.values(message.modelUsage ?? {});
  if (models.length > 0) {
    return {
      inputTokens: models.reduce((sum, usage) => sum + usage.inputTokens, 0),
      outputTokens: models.reduce((sum, usage) => sum + usage.outputTokens, 0),
      cacheReadTokens: models.reduce((sum, usage) => sum + usage.cacheReadInputTokens, 0),
      cacheWriteTokens: models.reduce((sum, usage) => sum + usage.cacheCreationInputTokens, 0),
      costUsd: models.reduce((sum, usage) => sum + usage.costUSD, 0),
    };
  }

  const usage = (message.usage ?? {}) as unknown as Record<string, unknown>;
  const normalized: NormalizedUsage = {};
  assignNumber(normalized, "inputTokens", usage.input_tokens);
  assignNumber(normalized, "outputTokens", usage.output_tokens);
  assignNumber(normalized, "cacheReadTokens", usage.cache_read_input_tokens);
  assignNumber(normalized, "cacheWriteTokens", usage.cache_creation_input_tokens);
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function assignNumber(
  usage: NormalizedUsage,
  key: keyof NormalizedUsage,
  value: unknown,
): void {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) usage[key] = value;
}

function isRetryUnsafe(event: BrainEvent): boolean {
  return event.type !== "provider.session" && event.type !== "usage.reported";
}

function isModelUnavailable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const unavailable = "not found|does not exist|unavailable|not available|unsupported|invalid|unknown";
  return new RegExp(`model[^.\\n]*(?:${unavailable})|(?:${unavailable})[^.\\n]*model`, "i").test(message);
}

function buildClaudePrompt(input: BrainInput): string | AsyncIterable<SDKUserMessage> {
  const text = buildPromptText(input);
  if (!input.images?.length) return text;
  const images = input.images;
  return (async function* (): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          ...images.map((image) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: image.mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
              data: image.data,
            },
          })),
          { type: "text" as const, text },
        ],
      },
    };
  })();
}

function toSdkTool(decl: ToolDeclaration, executor: ToolExecutor) {
  return tool(decl.name, decl.description, toZodShape(decl.parameters), async (args) => {
    const result = await executor(decl.name, args as Record<string, unknown>);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}

function toZodShape(params: ToolDeclaration["parameters"]): Record<string, z.ZodTypeAny> {
  const required = new Set(params.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(params.properties)) {
    const field = zodFieldFor(prop);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}

function zodFieldFor(prop: { type: string; description?: string; items?: { type: string } }): z.ZodTypeAny {
  const base = ((): z.ZodTypeAny => {
    switch (prop.type) {
      case "number":
        return z.number();
      case "integer":
        return z.number().int();
      case "boolean":
        return z.boolean();
      case "array":
        return z.array(zodFieldFor(prop.items ?? { type: "string" }));
      default:
        return z.string();
    }
  })();
  return prop.description ? base.describe(prop.description) : base;
}
