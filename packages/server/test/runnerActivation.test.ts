import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RunnerRuntime } from "../src/RunnerRuntime";
import type { AgentInvite } from "@workspace/shared";

/**
 * Activation intent is the one piece of runner state that deliberately
 * outlives a connection, so the cases worth pinning are all about what
 * survives a disconnect and what does not.
 */
const profile = { actorId: "agent-1", configRevision: 1, provider: "claude" } as AgentInvite;

describe("runner activation", () => {
  test("a paired runner joins dormant and is not handed work", () => {
    const runtime = new RunnerRuntime();
    runtime.connect(profile);

    assert.equal(runtime.summary(profile.actorId, 1).health, "dormant");
    assert.equal(runtime.isAvailable(profile.actorId), false);
  });

  test("activation survives a reconnect so a crash-restart comes back awake", () => {
    const runtime = new RunnerRuntime();
    runtime.connect(profile);
    runtime.setActivated(profile.actorId, true);

    // The agent process dies and its connection is cleared, then it rejoins.
    runtime.clear(profile.actorId);
    runtime.connect(profile);

    assert.equal(runtime.isActivated(profile.actorId), true);
    assert.equal(runtime.summary(profile.actorId, 1).health, "checking");
  });

  test("sleeping puts it straight back to dormant and unavailable", () => {
    const runtime = new RunnerRuntime();
    runtime.connect(profile);
    runtime.setActivated(profile.actorId, true);
    runtime.setActivated(profile.actorId, false);

    assert.equal(runtime.isActivated(profile.actorId), false);
    assert.equal(runtime.isAvailable(profile.actorId), false);
    // A reconnect must not resurrect the activation it just lost.
    runtime.clear(profile.actorId);
    runtime.connect(profile);
    assert.equal(runtime.summary(profile.actorId, 1).health, "dormant");
  });

  test("a revoked agent forgets it was ever activated", () => {
    const runtime = new RunnerRuntime();
    runtime.connect(profile);
    runtime.setActivated(profile.actorId, true);

    runtime.forget(profile.actorId);
    runtime.connect(profile);

    assert.equal(runtime.isActivated(profile.actorId), false);
    assert.equal(runtime.summary(profile.actorId, 1).health, "dormant");
  });
});
