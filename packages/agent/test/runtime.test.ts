import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentInvite } from "@workspace/shared";
import { AcpFailure } from "../src/acpBrain";
import { OPENAI_MODEL_CHOICES, ProfileUpdateQueue, readinessFailure, resolveOpenAiModel } from "../src/runtime";

describe("paired runner readiness", () => {
  test("reports typed preflight failures instead of ready", () => {
    assert.deepEqual(readinessFailure(new AcpFailure("ACP_AUTH_REQUIRED", "secret detail")), {
      health: "auth_required",
      code: "ACP_AUTH_REQUIRED",
    });
    assert.deepEqual(readinessFailure(new AcpFailure("ACP_MISCONFIGURED", "bad model")), {
      health: "misconfigured",
      code: "ACP_MISCONFIGURED",
    });
    assert.deepEqual(readinessFailure(new AcpFailure("ACP_INCOMPATIBLE", "bad protocol")), {
      health: "incompatible",
      code: "ACP_INCOMPATIBLE",
    });
  });

  test("serializes profile updates and applies only the newest revision", async () => {
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const preflighted: number[] = [];
    const applied: number[] = [];
    let active = 0;
    let maximumActive = 0;
    const queue = new ProfileUpdateQueue(async (profile, isCurrent) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      preflighted.push(profile.configRevision);
      if (profile.configRevision === 2) {
        started?.();
        await blocked;
      }
      if (isCurrent()) applied.push(profile.configRevision);
      active -= 1;
    });

    const second = queue.enqueue(profile(2));
    await firstStarted;
    const fourth = queue.enqueue(profile(4));
    await Promise.all([queue.enqueue(profile(3)), queue.enqueue(profile(4))]);
    release?.();
    await Promise.all([second, fourth]);

    assert.deepEqual(preflighted, [2, 4]);
    assert.deepEqual(applied, [4]);
    assert.equal(maximumActive, 1);
  });

  test("reset re-applies the current revision so a reconnect re-announces readiness", async () => {
    const applied: number[] = [];
    const queue = new ProfileUpdateQueue(async (profile) => { applied.push(profile.configRevision); });

    await queue.enqueue(profile(3));
    await queue.enqueue(profile(3));
    assert.deepEqual(applied, [3], "same revision is deduped while connected");

    queue.reset();
    await queue.enqueue(profile(3));
    assert.deepEqual(applied, [3, 3], "reconnect re-applies");
  });
});

describe("OpenAI model resolution", () => {
  test("falls back to the default when no model was requested", () => {
    assert.equal(resolveOpenAiModel(null), OPENAI_MODEL_CHOICES[0]);
  });

  test("uses the requested model when set", () => {
    assert.equal(resolveOpenAiModel("gpt-5-nano"), "gpt-5-nano");
  });
});

function profile(configRevision: number): AgentInvite {
  return {
    id: "agent-1",
    workspaceId: "workspace-1",
    actorId: "actor-1",
    name: "reader",
    provider: "claude",
    instructions: `revision ${configRevision}`,
    requestedModel: null,
    access: { mode: "workspace", selectedActorIds: [] },
    configRevision,
    createdBy: "human-1",
    createdAt: 1,
    updatedAt: configRevision,
    revokedAt: null,
  };
}
