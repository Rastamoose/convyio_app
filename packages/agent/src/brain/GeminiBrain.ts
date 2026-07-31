import { GoogleGenAI } from "@google/genai";
import type { Brain, BrainCallbacks, BrainInput, BrainRunOptions } from "./Brain";

const MODEL = process.env.AGENT_MODEL ?? "gemini-2.5-flash";

export class GeminiBrain implements Brain {
  private ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async run(input: BrainInput, callbacks: BrainCallbacks, options?: BrainRunOptions): Promise<string> {
    const response = await this.ai.models.generateContentStream({
      model: MODEL,
      contents: buildContents(input),
      config: {
        systemInstruction: input.system,
        thinkingConfig: { includeThoughts: true },
        abortSignal: options?.signal,
      },
    });

    let finalText = "";
    for await (const chunk of response) {
      // Newer SDK builds may return text via the convenience .text() accessor;
      // parts carry thought annotations when includeThoughts is enabled.
      const text = chunk.text;
      if (text) {
        callbacks.onText(text);
        finalText += text;
      }

      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (!part.text) continue;
        if (part.thought) {
          callbacks.onThought(part.text);
        } else if (!text) {
          // Only double-emit if .text() was not available on this chunk.
          callbacks.onText(part.text);
          finalText += part.text;
        }
      }
    }

    return finalText.trim() || "(no response)";
  }
}

function buildContents(input: BrainInput): string {
  return `<context>\n${input.context}\n</context>\n\n${input.prompt}`;
}
