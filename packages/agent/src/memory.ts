import fs from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "@workspace/shared";

const WINDOW_SIZE = 50;

/**
 * Rolling window of recent chat messages for the model's context, persisted
 * to a transcript file so a restarted agent is not amnesiac before its first
 * welcome frame (which reseeds the window from server history).
 */
export class Memory {
  private window: ChatMessage[];
  private readonly transcriptFile: string;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(transcriptFile: string, window: ChatMessage[]) {
    this.transcriptFile = transcriptFile;
    this.window = window;
  }

  static async load(dataDir: string): Promise<Memory> {
    const transcriptFile = path.join(dataDir, "transcript.json");
    await fs.mkdir(path.dirname(transcriptFile), { recursive: true });
    const stored = await readTranscript(transcriptFile);
    return new Memory(transcriptFile, stored.slice(-WINDOW_SIZE));
  }

  seed(history: ChatMessage[]): void {
    this.window = history.slice(-WINDOW_SIZE);
  }

  append(message: ChatMessage): void {
    this.window.push(message);
    if (this.window.length > WINDOW_SIZE) {
      this.window.shift();
    }
    this.persist(message);
  }

  context(): string {
    return this.window
      .map((m) => {
        const attachments = m.attachments?.length
          ? ` [attachments: ${m.attachments.map((a) => `${a.name} (${a.mime})`).join(", ")}]`
          : "";
        return `[#${m.channel ?? "general"}] ${m.authorName} (${m.authorKind}): ${m.content}${attachments}`;
      })
      .join("\n");
  }

  private persist(item: ChatMessage): void {
    // Swallow failures per write: a rejected link would poison the chain and
    // silently stop every later persist. The in-memory window stays correct;
    // only the restart transcript misses this message.
    this.writeQueue = this.writeQueue
      .then(async () => {
        const current = await readTranscript(this.transcriptFile);
        current.push(item);
        await fs.writeFile(this.transcriptFile, JSON.stringify(current, null, 2));
      })
      .catch((err) => {
        console.warn("[agent] transcript write failed — message won't survive a restart:", err);
      });
  }
}

/** An absent transcript is a normal first run; anything else is a real error. */
async function readTranscript(file: string): Promise<ChatMessage[]> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as ChatMessage[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[agent] could not read transcript, continuing without it:", err);
    }
    return [];
  }
}
