import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderPromptEnvelope, type PromptEnvelope } from "../src/prompt";

describe("prompt envelope", () => {
  test("renders policy before workspace records", () => {
    const envelope: PromptEnvelope = {
      generatedAt: 1,
      seq: 4,
      policy: [{ id: "agent-workflow", version: "1", hash: "abc", text: "Do not invent authority." }],
      workspace: { id: "ws-1", name: "test_space" },
      actor: { id: "a-1", kind: "agent", displayName: "noodle", workspaceId: "ws-1" },
      plans: [],
      tickets: [],
      context: [],
      notes: [],
      members: [{ id: "a-1", kind: "agent", displayName: "noodle", workspaceId: "ws-1" }],
      permissionMode: "default",
    };
    const rendered = renderPromptEnvelope(envelope);
    assert.match(rendered, /<policy id="agent-workflow"/);
    assert.match(rendered, /Do not invent authority/);
    assert.ok(rendered.indexOf("<policy") < rendered.indexOf("<tickets>"));
  });

  test("renders without notes when the envelope predates the notes field", () => {
    const envelope = {
      generatedAt: 1,
      seq: 4,
      policy: [{ id: "agent-workflow", version: "1", hash: "abc", text: "Do not invent authority." }],
      workspace: { id: "ws-1", name: "test_space" },
      actor: { id: "a-1", kind: "agent", displayName: "noodle", workspaceId: "ws-1" },
      plans: [],
      tickets: [],
      context: [],
      members: [{ id: "a-1", kind: "agent", displayName: "noodle", workspaceId: "ws-1" }],
      permissionMode: "default",
    };
    const rendered = renderPromptEnvelope({ ...envelope, notes: undefined } as unknown as PromptEnvelope);
    assert.match(rendered, /<notes>\n\(no active notes\)\n<\/notes>/);
  });
});
