import {
  GoogleGenAI,
  Type,
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  type GenerateContentResponseUsageMetadata,
  type Part,
  type Schema,
} from "@google/genai";
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

export class GeminiBrain implements Brain {
  private ai: GoogleGenAI;

  constructor(
    apiKey: string,
    private model: string,
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async run(input: BrainInput, callbacks: BrainCallbacks, options?: BrainRunOptions): Promise<BrainResult> {
    // Image parts go before the text: Gemini's image-understanding docs
    // recommend placing images ahead of the text prompt for best results.
    const contents: Content[] = [
      {
        role: "user",
        parts: [
          ...(input.images ?? []).map((image): Part => ({ inlineData: image })),
          { text: buildPromptText(input) },
        ],
      },
    ];
    const tools = input.tools?.length
      ? [{ functionDeclarations: input.tools.map(toFunctionDeclaration) }]
      : undefined;

    let finalText = "";
    let usage: NormalizedUsage | undefined;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await this.ai.models.generateContentStream({
        model: this.model,
        contents,
        config: {
          systemInstruction: input.system,
          thinkingConfig: { includeThoughts: true },
          abortSignal: options?.signal,
          tools,
        },
      });

      const modelParts: Part[] = [];
      const functionCalls: FunctionCall[] = [];
      let roundUsage: NormalizedUsage | undefined;

      for await (const chunk of response) {
        if (chunk.usageMetadata) roundUsage = normalizeGeminiUsage(chunk.usageMetadata);
        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          modelParts.push(part);
          if (part.functionCall?.name) {
            functionCalls.push(part.functionCall);
          } else if (part.text) {
            if (part.thought) {
              callbacks.onEvent({ type: "thought.delta", text: part.text });
            } else {
              callbacks.onEvent({ type: "output.delta", text: part.text });
              finalText += part.text;
            }
          }
        }
      }

      if (roundUsage) {
        usage = addUsage(usage, roundUsage);
        callbacks.onEvent({ type: "usage.reported", usage });
      }
      if (functionCalls.length === 0) break;

      contents.push({ role: "model", parts: modelParts });
      const responses: Part[] = [];
      for (const [index, call] of functionCalls.entries()) {
        const name = call.name!;
        const args = (call.args ?? {}) as Record<string, unknown>;
        const toolCallId = call.id ?? `gemini-${round}-${index}`;
        callbacks.onEvent({
          type: "tool.started",
          toolCallId,
          name,
          source: "native",
          input: boundedToolInput(args),
        });
        if (isPlanTool(name)) {
          callbacks.onEvent({ type: "plan.updated", toolCallId, plan: boundedToolInput(args) });
        }
        if (!options?.onToolCall) {
          callbacks.onEvent({ type: "tool.failed", toolCallId, name, error: "tool executor unavailable" });
          continue;
        }
        try {
          const result = await options.onToolCall(name, args);
          callbacks.onEvent({
            type: "tool.completed",
            toolCallId,
            name,
            output: summarizedToolOutput(result),
          });
          responses.push({
            functionResponse: { id: call.id, name, response: result },
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          callbacks.onEvent({ type: "tool.failed", toolCallId, name, error: detail.slice(0, 1_000) });
          throw err;
        }
      }
      if (responses.length === 0) break;
      contents.push({ role: "user", parts: responses });
    }

    return { text: finalText.trim() || "(no response)", providerSessionId: null, usage };
  }
}

function normalizeGeminiUsage(metadata: GenerateContentResponseUsageMetadata): NormalizedUsage {
  return compactUsage({
    inputTokens: metadata.promptTokenCount,
    outputTokens: metadata.candidatesTokenCount,
    cacheReadTokens: metadata.cachedContentTokenCount,
    thoughtTokens: metadata.thoughtsTokenCount,
    toolTokens: metadata.toolUsePromptTokenCount,
    totalTokens: metadata.totalTokenCount,
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

function toFunctionDeclaration(tool: ToolDeclaration): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: toSchema(tool.parameters),
  };
}

function toSchema(param: ToolDeclaration["parameters"]): Schema {
  const properties: Record<string, Schema> = {};
  for (const [key, value] of Object.entries(param.properties)) {
    properties[key] = {
      type: typeFor(value.type),
      ...(value.description ? { description: value.description } : {}),
      ...(value.items
        ? {
            items: {
              type: typeFor(value.items.type),
              ...(value.items.enum ? { enum: value.items.enum } : {}),
            },
          }
        : {}),
    };
  }
  return { type: Type.OBJECT, properties, required: param.required };
}

function typeFor(t: string): Type {
  switch (t) {
    case "number":
      return Type.NUMBER;
    case "integer":
      return Type.INTEGER;
    case "boolean":
      return Type.BOOLEAN;
    case "array":
      return Type.ARRAY;
    default:
      return Type.STRING;
  }
}
