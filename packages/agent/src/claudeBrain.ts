import {
  query as claudeQuery,
  tool,
  createSdkMcpServer as claudeCreateSdkMcpServer,
  type Options,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  MAX_TOOL_ROUNDS,
  buildPromptText,
  type Brain,
  type BrainCallbacks,
  type BrainInput,
  type BrainRunOptions,
  type ToolDeclaration,
  type ToolExecutor,
} from "./brain";

export class ClaudeBrain implements Brain {
  private query = claudeQuery;
  private createSdkMcpServer = claudeCreateSdkMcpServer;

  constructor(
    private model: string,
    private cwd: string,
  ) {}

  async run(input: BrainInput, callbacks: BrainCallbacks, options?: BrainRunOptions): Promise<string> {
    const abortController = new AbortController();
    if (options?.signal) {
      if (options.signal.aborted) abortController.abort();
      options.signal.addEventListener("abort", () => abortController.abort());
    }

    const boardServer =
      input.tools?.length && options?.onToolCall
        ? this.createSdkMcpServer({
            name: "board",
            version: "1.0.0",
            tools: input.tools.map((decl) => toSdkTool(decl, options.onToolCall!)),
          })
        : undefined;

    const claudeOptions: Options = {
      model: this.model,
      cwd: this.cwd,
      systemPrompt: input.system,
      abortController,
      includePartialMessages: true,
      maxTurns: MAX_TOOL_ROUNDS,
      // ponytail: always-allow stub. Native Claude Code tools (Bash, Write,
      // Edit, ...) run ungated for MVP — board-approval routing for them is
      // deferred debt, see ARCHITECTURE.md's 2026-08-09 decision log entry.
      canUseTool: async () => ({ behavior: "allow" }),
      ...(boardServer ? { mcpServers: { board: boardServer } } : {}),
    };

    const stream = this.query({ prompt: buildClaudePrompt(input), options: claudeOptions });

    let finalText = "";
    for await (const message of stream) {
      if (message.type === "stream_event") {
        const event = message.event;
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            callbacks.onText(event.delta.text);
          } else if (event.delta.type === "thinking_delta") {
            callbacks.onThought(event.delta.thinking);
          }
        }
      } else if (message.type === "result") {
        if (message.subtype === "success") {
          finalText = message.result;
        } else {
          throw new Error(
            `claude agent sdk error (${message.subtype}): ${message.errors.join("; ") || "no details"}`,
          );
        }
      }
    }

    return finalText.trim() || "(no response)";
  }
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
