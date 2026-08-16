import assert from "node:assert/strict";
import { test } from "node:test";
import { RateLimiter } from "../src/auth/RateLimiter";

test("rate limiter bounds a window and resets without retaining stale buckets", () => {
  const limiter = new RateLimiter();
  assert.equal(limiter.take("actor", 2, 1000, 100), true);
  assert.equal(limiter.take("actor", 2, 1000, 200), true);
  assert.equal(limiter.take("actor", 2, 1000, 300), false);
  assert.equal(limiter.take("actor", 2, 1000, 1100), true);
});
