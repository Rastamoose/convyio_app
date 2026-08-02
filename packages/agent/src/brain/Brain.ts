export interface BrainCallbacks {
  onThought(thought: string): void;
  onText(text: string): void;
}

/** JSON-schema-shaped tool declaration, mapped to the provider's format. */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
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

export interface Brain {
  run(input: BrainInput, callbacks: BrainCallbacks, options?: BrainRunOptions): Promise<string>;
}
