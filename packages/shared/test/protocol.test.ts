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
    const projectOk = clientEventSchema.parse({
      type: "action_request",
      requestId: "r2",
      boardItemRef: "task-1",
      action: { kind: "project_run_command", projectId: "proj-1", command: "npm test" },
    });
    assert.equal(projectOk.type, "action_request");
    assert.throws(() =>
      clientEventSchema.parse({
        type: "action_request",
        requestId: "r2",
        action: { kind: "project_run_command", command: "npm test" },
      }),
    );
    assert.throws(() =>
      clientEventSchema.parse({
        type: "action_request",
        requestId: "r2",
        action: { kind: "project_edit_file", projectId: "proj-1", path: "a.ts" },
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

  test("agent activity frames enforce event, payload, and batch bounds", () => {
    const activity = {
      clientEventId: "activity-1",
      kind: "agent.tool.started",
      channelId: "channel-1",
      conversationId: "conversation-1",
      runId: "run-1",
      subjectId: "tool-1",
      payload: { name: "Read", input: { path: "README.md" } },
    };
    assert.equal(
      clientEventSchema.parse({ type: "activity_batch", events: [activity] }).type,
      "activity_batch",
    );
    assert.throws(() => clientEventSchema.parse({ type: "activity_batch", events: [] }));
    assert.throws(() =>
      clientEventSchema.parse({ type: "activity_batch", events: [activity, activity] }),
    );
    assert.throws(() =>
      clientEventSchema.parse({
        type: "activity_batch",
        events: [{ ...activity, kind: "message.created" }],
      }),
    );
    assert.throws(() =>
      clientEventSchema.parse({
        type: "activity_batch",
        events: [{ ...activity, payload: { text: "x".repeat(4_001) } }],
      }),
    );
  });

  test("agent finish and conversation session frames are bounded", () => {
    const finish = clientEventSchema.parse({
      type: "agent_run_finish",
      runId: "run-1",
      channelId: "channel-1",
      conversationId: null,
      requestIds: [],
      outcome: "failed",
      finalContent: "could not finish",
      error: "provider failed",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    assert.equal(finish.type, "agent_run_finish");
    assert.throws(() =>
      clientEventSchema.parse({
        ...finish,
        requestIds: ["request-1", "request-1"],
      }),
    );
    assert.throws(() =>
      clientEventSchema.parse({ ...finish, finalContent: "x".repeat(4_001) }),
    );
    assert.equal(
      clientEventSchema.parse({
        type: "conversation_session_set",
        conversationId: "conversation-1",
        providerSessionId: "provider-session-1",
        permissionMode: "plan",
      }).type,
      "conversation_session_set",
    );
    assert.throws(() =>
      clientEventSchema.parse({
        type: "conversation_session_set",
        conversationId: "conversation-1",
        providerSessionId: "x".repeat(4_097),
        permissionMode: "default",
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

  test("runner hello accepts bounded ACP-like options and strips unknown fields", () => {
    const event = clientEventSchema.parse({
      type: "runner_hello",
      protocolVersion: 1,
      harness: { id: "claude", version: "0.1.0", localPath: "/secret" },
      options: [
        {
          id: "model",
          label: "Model",
          category: "model",
          kind: "select",
          value: "sonnet",
          choices: [{ value: "sonnet", label: "Sonnet" }],
          apiKey: "secret",
        },
        {
          id: "thinking",
          label: "Thinking",
          category: "thought_level",
          kind: "boolean",
          value: true,
        },
      ],
      env: { TOKEN: "secret" },
    });
    assert.equal(event.type, "runner_hello");
    assert.equal(event.type === "runner_hello" && "env" in event, false);
    assert.equal(event.type === "runner_hello" && "localPath" in event.harness, false);
    assert.equal(event.type === "runner_hello" && "apiKey" in event.options[0], false);
  });

  test("runner frames reject oversized, duplicate, and unstable diagnostics", () => {
    const option = {
      id: "model",
      label: "Model",
      category: "model",
      kind: "select",
      choices: [{ value: "sonnet", label: "Sonnet" }],
    };
    assert.throws(() =>
      clientEventSchema.parse({
        type: "runner_hello",
        protocolVersion: 1,
        harness: { id: "claude", version: "0.1.0" },
        options: Array.from({ length: 33 }, (_, index) => ({ ...option, id: `model-${index}` })),
      }),
    );
    assert.throws(() =>
      clientEventSchema.parse({
        type: "runner_hello",
        protocolVersion: 1,
        harness: { id: "claude", version: "0.1.0" },
        options: [option, option],
      }),
    );
    assert.throws(() =>
      clientEventSchema.parse({
        type: "runner_status",
        configRevision: 1,
        health: "ready",
        diagnosticCode: "contains local path /tmp",
      }),
    );
    assert.throws(() =>
      clientEventSchema.parse({
        type: "runner_status",
        configRevision: 1,
        health: "ready",
        effectiveModel: "x".repeat(201),
      }),
    );
  });
});
