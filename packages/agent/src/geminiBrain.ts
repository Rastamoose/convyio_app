import {
  GoogleGenAI,
  Type,
  type Content,
  type FunctionDeclaration,
  type Part,
  type Schema,
} from "@google/genai";

const MAX_TOOL_ROUNDS = 12;

export interface BrainCallbacks {
  onThought(thought: string): void;
  onText(text: string): void;
}

/** JSON-schema-shaped tool declaration, mapped to Gemini's format. */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<
      string,
      { type: string; description?: string; items?: { type: string } }
    >;
    required?: string[];
  };
}

export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface BrainInput {
  system: string;
  context: string;
  prompt: string;
  tools?: ToolDeclaration[];
}

export interface BrainRunOptions {
  signal?: AbortSignal;
  /** Invoked for each tool call the model makes; result is fed back. */
  onToolCall?: ToolExecutor;
}

export class GeminiBrain {
  private ai: GoogleGenAI;

  constructor(
    apiKey: string,
    private model: string,
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async run(input: BrainInput, callbacks: BrainCallbacks, options?: BrainRunOptions): Promise<string> {
    const contents: Content[] = [
      { role: "user", parts: [{ text: buildContents(input) }] },
    ];
    const tools = input.tools?.length
      ? [{ functionDeclarations: input.tools.map(toFunctionDeclaration) }]
      : undefined;

    let finalText = "";

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
      const functionCalls: { name: string; args: Record<string, unknown> }[] = [];

      for await (const chunk of response) {
        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          modelParts.push(part);
          if (part.functionCall?.name) {
            functionCalls.push({
              name: part.functionCall.name,
              args: (part.functionCall.args ?? {}) as Record<string, unknown>,
            });
          } else if (part.text) {
            if (part.thought) {
              callbacks.onThought(part.text);
            } else {
              callbacks.onText(part.text);
              finalText += part.text;
            }
          }
        }
      }

      if (functionCalls.length === 0 || !options?.onToolCall) break;

      contents.push({ role: "model", parts: modelParts });
      const responses: Part[] = [];
      for (const call of functionCalls) {
        const result = await options.onToolCall(call.name, call.args);
        responses.push({
          functionResponse: { name: call.name, response: result },
        });
      }
      contents.push({ role: "user", parts: responses });
    }

    return finalText.trim() || "(no response)";
  }
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
      ...(value.items ? { items: { type: typeFor(value.items.type) } } : {}),
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

function buildContents(input: BrainInput): string {
  return `<context>\n${input.context}\n</context>\n\n${input.prompt}`;
}
