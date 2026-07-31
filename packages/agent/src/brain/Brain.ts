export interface BrainCallbacks {
  onThought(thought: string): void;
  onText(text: string): void;
}

export interface BrainInput {
  system: string;
  context: string;
  prompt: string;
}

export interface BrainRunOptions {
  signal?: AbortSignal;
}

export interface Brain {
  run(input: BrainInput, callbacks: BrainCallbacks, options?: BrainRunOptions): Promise<string>;
}
