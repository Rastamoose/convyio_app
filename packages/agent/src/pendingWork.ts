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
  private readonly map: Map<string, StashedWork>;
  private readonly file: string;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(file: string, map: Map<string, StashedWork>) {
    this.file = file;
    this.map = map;
  }

  static async load(dataDir: string): Promise<PendingWork> {
    const file = path.join(dataDir, "pending-work.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    let map = new Map<string, StashedWork>();
    try {
      const raw = await fs.readFile(file, "utf-8");
      map = new Map(Object.entries(JSON.parse(raw) as Record<string, StashedWork>));
    } catch (err) {
      // An absent stash is a normal first run. A corrupt one is a real error:
      // starting empty means approved-while-down proposals won't auto-resume,
      // so say so instead of hiding it.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[agent] could not read pending-work stash, starting empty:", err);
      }
    }
    return new PendingWork(file, map);
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
