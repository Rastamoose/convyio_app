import fs from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "@workspace/shared";
import type { Storage } from "./Storage";

export class JsonStorage implements Storage {
  private messagesFile: string;
  private messages: ChatMessage[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.messagesFile = path.join(dataDir, "messages.json");
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.messagesFile), { recursive: true });
    try {
      const raw = await fs.readFile(this.messagesFile, "utf-8");
      this.messages = JSON.parse(raw) as ChatMessage[];
    } catch {
      this.messages = [];
    }
  }

  async loadMessages(): Promise<ChatMessage[]> {
    return [...this.messages];
  }

  async appendMessage(message: ChatMessage): Promise<void> {
    this.messages.push(message);
    // Serialize writes so concurrent appends never interleave.
    this.writeQueue = this.writeQueue.then(() =>
      fs.writeFile(this.messagesFile, JSON.stringify(this.messages, null, 2)),
    );
    await this.writeQueue;
  }

  async clearMessages(channel?: string): Promise<void> {
    this.messages = channel
      ? this.messages.filter((m) => (m.channel ?? "general") !== channel)
      : [];
    this.writeQueue = this.writeQueue.then(() =>
      fs.writeFile(this.messagesFile, JSON.stringify(this.messages, null, 2)),
    );
    await this.writeQueue;
  }
}
