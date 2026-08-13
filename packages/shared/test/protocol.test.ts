import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clientEventSchema } from "../src/protocol";

describe("client event validation", () => {
  test("valid join parses and defaults kind to human", () => {
    const event = clientEventSchema.parse({ type: "join", name: "dana" });
    assert.equal(event.type, "join");
    assert.equal(event.type === "join" && event.kind, "human");
  });

  test("join rejects empty and over-long names", () => {
    assert.throws(() => clientEventSchema.parse({ type: "join", name: "" }));
    assert.throws(() => clientEventSchema.parse({ type: "join", name: "x".repeat(33) }));
  });

  test("message enforces content bounds", () => {
    assert.throws(() => clientEventSchema.parse({ type: "message", content: "" }));
    assert.throws(() =>
      clientEventSchema.parse({ type: "message", content: "x".repeat(4001) }),
    );
    const ok = clientEventSchema.parse({ type: "message", content: "hi", channel: "demo" });
    assert.equal(ok.type, "message");
  });

  test("unknown event types are rejected", () => {
    assert.throws(() => clientEventSchema.parse({ type: "sudo", content: "rm -rf" }));
  });

  test("action_request validates the action union", () => {
    const ok = clientEventSchema.parse({
      type: "action_request",
      requestId: "r1",
      boardItemRef: "task-1",
      action: { kind: "write_file", path: "a.md", content: "x" },
    });
    assert.equal(ok.type, "action_request");
    assert.throws(() =>
      clientEventSchema.parse({
        type: "action_request",
        requestId: "r1",
        action: { kind: "delete_everything" },
      }),
    );
    // write_file without content is malformed, not silently accepted.
    assert.throws(() =>
      clientEventSchema.parse({
        type: "action_request",
        requestId: "r1",
        action: { kind: "write_file", path: "a.md" },
      }),
    );
  });

  test("run_end defaults reason to completed", () => {
    const event = clientEventSchema.parse({ type: "run_end", runId: "r1" });
    assert.equal(event.type === "run_end" && event.reason, "completed");
  });

  test("work frames require unique bounded request ids and a terminal outcome", () => {
    assert.equal(
      clientEventSchema.parse({ type: "work_claim", requestIds: ["request-1"] }).type,
      "work_claim",
    );
    assert.throws(() => clientEventSchema.parse({ type: "work_claim", requestIds: [] }));
    assert.throws(() =>
      clientEventSchema.parse({ type: "work_claim", requestIds: ["request-1", "request-1"] }),
    );
    assert.throws(() =>
      clientEventSchema.parse({
        type: "work_claim",
        requestIds: Array.from({ length: 51 }, (_, index) => `request-${index}`),
      }),
    );
    assert.equal(
      clientEventSchema.parse({
        type: "work_complete",
        requestIds: ["request-1"],
        outcome: "cancelled",
      }).type,
      "work_complete",
    );
    assert.throws(() =>
      clientEventSchema.parse({
        type: "work_complete",
        requestIds: ["request-1"],
        outcome: "failed",
      }),
    );
  });

  test("message mentions cannot be supplied by a client", () => {
    const event = clientEventSchema.parse({
      type: "message",
      content: "@agent hello",
      mentions: ["forged-agent-id"],
    });
    assert.equal(event.type === "message" && "mentions" in event, false);
  });
});
