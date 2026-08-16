interface Bucket {
  count: number;
  resetsAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  take(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const current = this.buckets.get(key);
    if (!current || current.resetsAt <= now) {
      this.buckets.set(key, { count: 1, resetsAt: now + windowMs });
      if (this.buckets.size > 10_000) {
        this.sweep(now);
        for (const bucketKey of this.buckets.keys()) {
          if (this.buckets.size <= 5_000) break;
          this.buckets.delete(bucketKey);
        }
      }
      return true;
    }
    if (current.count >= limit) return false;
    current.count += 1;
    return true;
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetsAt <= now) this.buckets.delete(key);
    }
  }
}
