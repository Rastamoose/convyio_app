const WINDOW_MS = 60 * 60 * 1000;
const MAX_RUNS = 10;

export class HostedUsageLimiter {
  private runs = new Map<string, number[]>();
  private announced = new Map<string, number>();

  check(authorId: string, now = Date.now()): { allowed: boolean; announce: boolean } {
    const cutoff = now - WINDOW_MS;
    const recent = (this.runs.get(authorId) ?? []).filter((stamp) => stamp > cutoff);
    this.runs.set(authorId, recent);
    if (recent.length < MAX_RUNS) {
      recent.push(now);
      return { allowed: true, announce: false };
    }
    const lastAnnounced = this.announced.get(authorId);
    const announce = lastAnnounced === undefined || lastAnnounced <= cutoff;
    if (announce) this.announced.set(authorId, now);
    return { allowed: false, announce };
  }
}
