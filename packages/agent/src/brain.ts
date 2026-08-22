import type { JsonValue, NormalizedUsage, PermissionMode } from "@workspace/shared";

export const MAX_TOOL_ROUNDS = 12;

export type BrainEvent =
  | { type: "output.delta"; text: string }
  | { type: "thought.delta"; text: string }
  | { type: "plan.updated"; toolCallId: string; plan: JsonValue }
  | { type: "tool.started"; toolCallId: string; name: string; source: "native" | "mcp"; input: JsonValue }
  | { type: "tool.progress"; toolCallId: string; name: string; progress: JsonValue }
  | { type: "tool.completed"; toolCallId: string; name: string; output?: JsonValue }
  | { type: "tool.failed"; toolCallId: string; name: string; error: string }
  | { type: "usage.reported"; usage: NormalizedUsage }
  | { type: "provider.session"; providerSessionId: string };

export interface BrainCallbacks {
  onEvent(event: BrainEvent): void;
}

export interface BrainResult {
  text: string;
  providerSessionId: string | null;
  usage?: NormalizedUsage;
}

/** JSON-schema-shaped tool declaration, mapped to each provider's own format. */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<
      string,
      { type: string; description?: string; items?: { type: string; enum?: string[] } }
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
  /** Images the triggering messages carried; data is base64-encoded bytes. */
  images?: { mimeType: string; data: string }[];
  tools?: ToolDeclaration[];
}

export interface BrainRunOptions {
  signal?: AbortSignal;
  providerSessionId?: string | null;
  permissionMode?: PermissionMode;
  /** Invoked for each tool call the model makes; result is fed back. */
  onToolCall?: ToolExecutor;
}

/** A concrete LLM backend the agent can run a batch of work through. */
export interface Brain {
  run(input: BrainInput, callbacks: BrainCallbacks, options?: BrainRunOptions): Promise<BrainResult>;
  /** Only implemented by brains whose model can change without reconnecting
   *  (currently OpenAI). Absent on brains where model is fixed at construction. */
  setModel?(model: string): void;
}

export function buildPromptText(input: BrainInput): string {
  return `<context>\n${input.context}\n</context>\n\n${input.prompt}`;
}

export function boundedToolInput(value: unknown): JsonValue {
  return boundedValue(value, true, 0);
}

export function summarizedToolOutput(value: unknown): JsonValue {
  return boundedValue(value, false, 0);
}

export function isPlanTool(name: string): boolean {
  return /(?:^|__|_)(?:todo(?:write)?|plan)(?:$|_)/i.test(name);
}

function boundedValue(value: unknown, includeStrings: boolean, depth: number): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") {
    if (!includeStrings) return `[string:${value.length} chars]`;
    return value.length <= 1_000 ? value : `${value.slice(0, 1_000)}…`;
  }
  if (depth >= 4) return `[${Array.isArray(value) ? "array" : typeof value}]`;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => boundedValue(item, includeStrings, depth + 1));
  }
  if (typeof value !== "object") return String(value).slice(0, 200);

  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    result[key.slice(0, 100)] = /(?:password|passphrase|secret|token|credentials?|auth(?:entication|orization)?|api.?key|access.?key|private.?key|client.?secret|environment|^env$)/i.test(key)
      ? "[redacted]"
      : boundedValue(item, includeStrings, depth + 1);
  }
  return result;
}
