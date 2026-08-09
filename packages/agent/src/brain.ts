export const MAX_TOOL_ROUNDS = 12;

export interface BrainCallbacks {
  onThought(thought: string): void;
  onText(text: string): void;
}

/** JSON-schema-shaped tool declaration, mapped to each provider's own format. */
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
  /** Images the triggering messages carried; data is base64-encoded bytes. */
  images?: { mimeType: string; data: string }[];
  tools?: ToolDeclaration[];
}

export interface BrainRunOptions {
  signal?: AbortSignal;
  /** Invoked for each tool call the model makes; result is fed back. */
  onToolCall?: ToolExecutor;
}

/** A concrete LLM backend the agent can run a batch of work through. */
export interface Brain {
  run(input: BrainInput, callbacks: BrainCallbacks, options?: BrainRunOptions): Promise<string>;
}

export function buildPromptText(input: BrainInput): string {
  return `<context>\n${input.context}\n</context>\n\n${input.prompt}`;
}
