import OpenAI from "openai";
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { NormalizedUsage } from "@workspace/shared";
import {
  MAX_TOOL_ROUNDS,
  boundedToolInput,
  buildPromptText,
  isPlanTool,
  summarizedToolOutput,
  type Brain,
  type BrainCallbacks,
  type BrainInput,
  type BrainResult,
  type BrainRunOptions,
  type ToolDeclaration,
} from "./brain";

export class OpenAIBrain implements Brain {
  private client: OpenAI;

  constructor(
    apiKey: string,
    private model: string,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async run(input: BrainInput, callbacks: BrainCallbacks, options?: BrainRunOptions): Promise<BrainResult> {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: input.system },
      { role: "user", content: toUserContent(input) },
    ];
    const tools: ChatCompletionTool[] | undefined = input.tools?.length
      ? input.tools.map(toChatCompletionTool)
      : undefined;

    let finalText = "";
    let usage: NormalizedUsage | undefined;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages,
          tools,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: options?.signal },
      );

      let roundText = "";
      const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
      let roundUsage: NormalizedUsage | undefined;

      for await (const chunk of stream) {
        if (chunk.usage) roundUsage = normalizeOpenAIUsage(chunk.usage);
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          callbacks.onEvent({ type: "output.delta", text: delta.content });
          roundText += delta.content;
        }
        for (const call of delta.tool_calls ?? []) {
          const existing = toolCalls.get(call.index) ?? { id: "", name: "", arguments: "" };
          if (call.id) existing.id = call.id;
          if (call.function?.name) existing.name += call.function.name;
          if (call.function?.arguments) existing.arguments += call.function.arguments;
          toolCalls.set(call.index, existing);
        }
      }
      finalText += roundText;

      if (roundUsage) {
        usage = addUsage(usage, roundUsage);
        callbacks.onEvent({ type: "usage.reported", usage });
      }
      if (toolCalls.size === 0) break;

      const calls = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
      messages.push({
        role: "assistant",
        content: roundText || null,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      });

      for (const call of calls) {
        const args = parseArguments(call.arguments);
        callbacks.onEvent({
          type: "tool.started",
          toolCallId: call.id,
          name: call.name,
          source: "native",
          input: boundedToolInput(args),
        });
        if (isPlanTool(call.name)) {
          callbacks.onEvent({ type: "plan.updated", toolCallId: call.id, plan: boundedToolInput(args) });
        }
        if (!options?.onToolCall) {
          callbacks.onEvent({ type: "tool.failed", toolCallId: call.id, name: call.name, error: "tool executor unavailable" });
          messages.push({ role: "tool", tool_call_id: call.id, content: "tool executor unavailable" });
          continue;
        }
        try {
          const result = await options.onToolCall(call.name, args);
          callbacks.onEvent({
            type: "tool.completed",
            toolCallId: call.id,
            name: call.name,
            output: summarizedToolOutput(result),
          });
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          callbacks.onEvent({ type: "tool.failed", toolCallId: call.id, name: call.name, error: detail.slice(0, 1_000) });
          throw err;
        }
      }
    }

    return { text: finalText.trim() || "(no response)", providerSessionId: null, usage };
  }
}

function toUserContent(input: BrainInput): string | ChatCompletionContentPart[] {
  const text = buildPromptText(input);
  if (!input.images?.length) return text;
  return [
    ...input.images.map(
      (image): ChatCompletionContentPart => ({
        type: "image_url",
        image_url: { url: `data:${image.mimeType};base64,${image.data}` },
      }),
    ),
    { type: "text", text },
  ];
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function normalizeOpenAIUsage(usage: NonNullable<import("openai/resources/completions").CompletionUsage>): NormalizedUsage {
  return compactUsage({
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cacheReadTokens: usage.prompt_tokens_details?.cached_tokens,
    cacheWriteTokens: usage.prompt_tokens_details?.cache_write_tokens,
    totalTokens: usage.total_tokens,
  });
}

function addUsage(current: NormalizedUsage | undefined, next: NormalizedUsage): NormalizedUsage {
  const total: NormalizedUsage = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(next) as [keyof NormalizedUsage, number][]) {
    total[key] = (total[key] ?? 0) + value;
  }
  return total;
}

function compactUsage(usage: NormalizedUsage): NormalizedUsage {
  return Object.fromEntries(
    Object.entries(usage).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
}

function toChatCompletionTool(decl: ToolDeclaration): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: decl.name,
      description: decl.description,
      parameters: decl.parameters,
    },
  };
}
