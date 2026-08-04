import fs from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "@workspace/shared";

const WINDOW_SIZE = 50;

export interface MemoryMessage {
  authorName: string;
  authorKind: "human" | "agent";
  content: string;
  timestamp: number;
  channel?: string;
}

export class Memory {
  private window: MemoryMessage[] = [];
  private transcriptFile: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.transcriptFile = path.join(dataDir, "transcript.json");
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.transcriptFile), { recursive: true });
    try {
      const raw = await fs.readFile(this.transcriptFile, "utf-8");
      const stored = JSON.parse(raw) as MemoryMessage[];
      this.window = stored.slice(-WINDOW_SIZE);
    } catch {
      this.window = [];
    }
  }

  seed(history: ChatMessage[]): void {
    this.window = history.map((m) => ({
      authorName: m.authorName,
      authorKind: m.authorKind,
      content: m.content,
      timestamp: m.timestamp,
      channel: m.channel ?? "general",
    }));
  }

  append(message: ChatMessage): void {
    const item: MemoryMessage = {
      authorName: message.authorName,
      authorKind: message.authorKind,
      content: message.content,
      timestamp: message.timestamp,
      channel: message.channel ?? "general",
    };
    this.window.push(item);
    if (this.window.length > WINDOW_SIZE) {
      this.window.shift();
    }
    this.persist(item);
  }

  context(): string {
    return this.window
      .map(
        (m) =>
          `[#${m.channel ?? "general"}] ${m.authorName} (${m.authorKind}): ${m.content}`,
      )
      .join("\n");
  }

  private persist(item: MemoryMessage): void {
    this.writeQueue = this.writeQueue.then(async () => {
      let current: MemoryMessage[] = [];
      try {
        const raw = await fs.readFile(this.transcriptFile, "utf-8");
        current = JSON.parse(raw) as MemoryMessage[];
      } catch {
        current = [];
      }
      current.push(item);
      await fs.writeFile(this.transcriptFile, JSON.stringify(current, null, 2));
    });
  }
}
