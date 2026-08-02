import fs from "node:fs/promises";
import path from "node:path";

export interface StashedWork {
  origin: string;
  channel: string;
}

/**
 * Work stashed while a proposal awaits a human decision, keyed by board item
 * id. Persisted to disk so a restarted agent still resumes (or drops) work
 * when its proposals are decided.
 */
export class PendingWork {
  private map = new Map<string, StashedWork>();
  private file: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "pending-work.json");
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await fs.readFile(this.file, "utf-8");
      this.map = new Map(Object.entries(JSON.parse(raw) as Record<string, StashedWork>));
    } catch {
      this.map = new Map();
    }
  }

  get(itemId: string): StashedWork | undefined {
    return this.map.get(itemId);
  }

  set(itemId: string, work: StashedWork): void {
    this.map.set(itemId, work);
    this.persist();
  }

  delete(itemId: string): void {
    if (this.map.delete(itemId)) this.persist();
  }

  entries(): [string, StashedWork][] {
    return [...this.map.entries()];
  }

  private persist(): void {
    const snapshot = Object.fromEntries(this.map);
    this.writeQueue = this.writeQueue.then(() =>
      fs.writeFile(this.file, JSON.stringify(snapshot, null, 2)),
    );
  }
}
