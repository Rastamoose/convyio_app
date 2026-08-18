import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HostedUsageLimiter } from "../src/hostedLimiter";

describe("hosted usage limiter", () => {
  test("allows ten runs then announces once", () => {
    const limiter = new HostedUsageLimiter();
    const start = 1_000;
    for (let i = 0; i < 10; i += 1) {
      assert.deepEqual(limiter.check("human-1", start + i * 1_000), { allowed: true, announce: false });
    }
    assert.deepEqual(limiter.check("human-1", start + 10_000), { allowed: false, announce: true });
    assert.deepEqual(limiter.check("human-1", start + 11_000), { allowed: false, announce: false });
    assert.deepEqual(limiter.check("human-2", start + 12_000), { allowed: true, announce: false });
    assert.deepEqual(limiter.check("human-1", start + 10_000 + 60 * 60 * 1000), { allowed: true, announce: false });
  });
});
