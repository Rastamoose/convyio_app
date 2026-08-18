import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { AcpBrain, permissionDecision, readWorkspaceFile, sanitizedChildEnvironment } from "../src/acpBrain";
import { tempDir, waitFor } from "./helpers";

function modelOptions(currentValue = "default-model"): SessionConfigOption[] {
  return [{
    id: "model-selector",
    name: "Model",
    category: "model",
    type: "select",
    currentValue,
    options: [
      { value: "default-model", name: "Default" },
      { value: "custom-model", name: "Custom" },
    ],
  }];
}

function fakeAgent(record: {
  initialized?: unknown;
  newSessions: string[];
  loaded: string[];
  selected: string[];
  prompts: string[];
  cancelled: string[];
  loadFailures?: Set<string>;
}) {
  let nextSession = 1;
  let cancelPrompt: (() => void) | undefined;
  return acp
    .agent({ name: "fake-claude" })
    .onRequest(acp.methods.agent.initialize, (ctx) => {
      record.initialized = ctx.params;
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: "fake-claude", version: "1.0.0" },
        authMethods: [],
      };
    })
    .onRequest(acp.methods.agent.session.new, () => {
      const sessionId = `session-${nextSession++}`;
      record.newSessions.push(sessionId);
      return { sessionId, configOptions: modelOptions() };
    })
    .onRequest(acp.methods.agent.session.load, (ctx) => {
      record.loaded.push(ctx.params.sessionId);
      if (record.loadFailures?.has(ctx.params.sessionId)) {
        throw new acp.RequestError(-32602, `Resource not found: ${ctx.params.sessionId}`);
      }
      return { configOptions: modelOptions() };
    })
    .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => {
      record.selected.push(String(ctx.params.value));
      return { configOptions: modelOptions(String(ctx.params.value)) };
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const text = ctx.params.prompt.find((block) => block.type === "text")?.text ?? "";
      record.prompts.push(text);
      if (text.includes("wait forever")) {
        await new Promise<void>((resolve) => { cancelPrompt = resolve; });
        return { stopReason: "cancelled" as const };
      }
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Search",
          kind: "search",
          status: "in_progress",
          rawInput: { query: "needle" },
        },
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
          rawOutput: { matches: 1 },
        },
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: "plan", entries: [{ content: "Inspect", priority: "medium", status: "completed" }] },
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } },
      });
      return { stopReason: "end_turn" as const, usage: { totalTokens: 7, inputTokens: 5, outputTokens: 2 } };
    })
    .onNotification(acp.methods.agent.session.cancel, (ctx) => {
      record.cancelled.push(ctx.params.sessionId);
      cancelPrompt?.();
    });
}

describe("AcpBrain", () => {
  test("negotiates capabilities, discovers models, maps output, and resumes sessions", async () => {
    const workspace = await tempDir();
    const record = { newSessions: [] as string[], loaded: [] as string[], selected: [] as string[], prompts: [] as string[], cancelled: [] as string[], initialized: undefined as unknown };
    const brain = new AcpBrain(workspace, fakeAgent(record));
    const readiness = await brain.preflight(null);
    assert.deepEqual(readiness.harness, { id: "claude", version: "1.0.0" });
    assert.equal(readiness.effectiveModel, "default-model");
    assert.equal(readiness.options[0].category, "model");
    assert.deepEqual(record.selected, []);
    assert.deepEqual((record.initialized as { clientCapabilities: unknown }).clientCapabilities, {
      fs: { readTextFile: true, writeTextFile: false },
      terminal: false,
      auth: { terminal: false },
    });

    brain.configure("custom-model");
    const events: string[] = [];
    const first = await brain.run(
      { system: "platform policy", context: "ctx", prompt: "question" },
      { onEvent: (event) => events.push(event.type) },
    );
    assert.equal(first.text, "answer");
    assert.equal(first.providerSessionId, "session-1");
    assert.deepEqual(first.usage, { inputTokens: 5, outputTokens: 2, totalTokens: 7 });
    assert.deepEqual(record.selected, ["custom-model"]);
    assert.match(record.prompts[0], /<system>\nplatform policy/);
    assert.deepEqual(events, [
      "provider.session",
      "thought.delta",
      "tool.started",
      "tool.completed",
      "plan.updated",
      "output.delta",
      "usage.reported",
    ]);

    const resumed = await brain.run(
      { system: "new profile", context: "ctx", prompt: "again" },
      { onEvent: () => undefined },
      { providerSessionId: "persisted-session" },
    );
    assert.equal(resumed.providerSessionId, "persisted-session");
    assert.deepEqual(record.loaded, ["persisted-session"]);
    assert.match(record.prompts[1], /new profile/);
    brain.close();
  });

  test("starts a fresh session when the stored session no longer exists locally", async () => {
    const workspace = await tempDir();
    const record = {
      newSessions: [] as string[],
      loaded: [] as string[],
      selected: [] as string[],
      prompts: [] as string[],
      cancelled: [] as string[],
      loadFailures: new Set(["gone-session"]),
    };
    const brain = new AcpBrain(workspace, fakeAgent(record));
    const result = await brain.run(
      { system: "platform policy", context: "ctx", prompt: "question" },
      { onEvent: () => undefined },
      { providerSessionId: "gone-session" },
    );
    assert.deepEqual(record.loaded, ["gone-session"]);
    assert.deepEqual(record.newSessions, ["session-1"]);
    assert.equal(result.providerSessionId, "session-1");
    assert.equal(result.text, "answer");
    brain.close();
  });

  test("preflight does not replace the effective configured model", async () => {
    const workspace = await tempDir();
    const record = { newSessions: [] as string[], loaded: [] as string[], selected: [] as string[], prompts: [] as string[], cancelled: [] as string[] };
    const brain = new AcpBrain(workspace, fakeAgent(record));
    brain.configure("custom-model");
    await brain.preflight("default-model");
    await brain.run(
      { system: "policy", context: "ctx", prompt: "question" },
      { onEvent: () => undefined },
    );
    assert.deepEqual(record.selected, ["custom-model"]);
    brain.close();
  });

  test("falls back to the harness default when the requested model is not advertised", async () => {
    const workspace = await tempDir();
    const record = { newSessions: [] as string[], loaded: [] as string[], selected: [] as string[], prompts: [] as string[], cancelled: [] as string[] };
    const brain = new AcpBrain(workspace, fakeAgent(record));
    const readiness = await brain.preflight("gemini-2.5-pro");
    assert.equal(readiness.effectiveModel, "default-model");
    assert.deepEqual(record.selected, []);
    brain.close();
  });

  test("sends ACP cancellation", async () => {
    const workspace = await tempDir();
    const record = { newSessions: [] as string[], loaded: [] as string[], selected: [] as string[], prompts: [] as string[], cancelled: [] as string[] };
    const brain = new AcpBrain(workspace, fakeAgent(record));
    await brain.preflight(null);
    const controller = new AbortController();
    const running = brain.run(
      { system: "policy", context: "ctx", prompt: "wait forever" },
      { onEvent: () => undefined },
      { signal: controller.signal },
    );
    await waitFor(() => record.prompts.length > 0 ? true : undefined, "ACP prompt start");
    controller.abort();
    await assert.rejects(running, /cancel/i);
    assert.deepEqual(record.cancelled, ["session-1"]);
    brain.close();
  });
});

describe("ACP read-only client security", () => {
  test("allows safe structured reads and rejects missing, outside, symlinked, sensitive, and mutating requests", async () => {
    const workspace = await tempDir();
    const outside = await tempDir();
    const safe = path.join(workspace, "safe.txt");
    const outsideFile = path.join(outside, "outside.txt");
    const options = [
      { optionId: "allow", name: "Allow", kind: "allow_once" as const },
      { optionId: "reject", name: "Reject", kind: "reject_once" as const },
    ];
    const decision = (toolCall: Parameters<typeof permissionDecision>[1]["toolCall"]) => permissionDecision(workspace, { sessionId: "s", toolCall, options });
    await fs.writeFile(safe, "safe");
    await fs.writeFile(outsideFile, "outside");
    await fs.writeFile(path.join(workspace, ".env"), "SECRET=x");
    await fs.symlink(outsideFile, path.join(workspace, "escape.txt"));

    assert.deepEqual(await decision({ toolCallId: "1", kind: "read", locations: [{ path: safe }] }), { outcome: { outcome: "selected", optionId: "allow" } });
    assert.deepEqual(await decision({ toolCallId: "2", kind: "read", rawInput: { paths: [safe] } }), { outcome: { outcome: "selected", optionId: "allow" } });
    for (const toolCall of [
      { toolCallId: "3", kind: "read" as const },
      { toolCallId: "4", kind: "read" as const, rawInput: { path: outsideFile } },
      { toolCallId: "5", kind: "read" as const, locations: [{ path: path.join(workspace, "escape.txt") }] },
      { toolCallId: "6", kind: "read" as const, rawInput: { file_path: path.join(workspace, ".env") } },
      { toolCallId: "7", kind: "read" as const, rawInput: { path: path.join(workspace, "missing.txt") } },
      { toolCallId: "8", kind: "edit" as const, rawInput: { path: safe } },
    ]) {
      assert.deepEqual(await decision(toolCall), { outcome: { outcome: "selected", optionId: "reject" } });
    }
    for (const kind of ["search", "think", "fetch"] as const) {
      assert.deepEqual(await decision({ toolCallId: kind, kind }), { outcome: { outcome: "selected", optionId: "allow" } });
    }
  });

  test("realpath-confines reads and rejects symlinks and sensitive names", async () => {
    const workspace = await tempDir();
    const outside = await tempDir();
    await fs.writeFile(path.join(workspace, "safe.txt"), "one\ntwo\nthree");
    await fs.writeFile(path.join(workspace, ".env.local"), "SECRET=x");
    await fs.writeFile(path.join(outside, "outside.txt"), "outside");
    await fs.symlink(path.join(outside, "outside.txt"), path.join(workspace, "escape.txt"));
    await fs.symlink(path.join(workspace, "safe.txt"), path.join(workspace, "linked-safe.txt"));
    assert.deepEqual(await readWorkspaceFile(workspace, { sessionId: "s", path: path.join(workspace, "safe.txt"), line: 2, limit: 1 }), { content: "two" });
    await assert.rejects(readWorkspaceFile(workspace, { sessionId: "s", path: path.join(workspace, "escape.txt") }));
    await assert.rejects(readWorkspaceFile(workspace, { sessionId: "s", path: path.join(workspace, "linked-safe.txt") }));
    await assert.rejects(readWorkspaceFile(workspace, { sessionId: "s", path: path.join(workspace, ".env.local") }), /sensitive/);
  });

  test("sanitizes subprocess environment and never forwards Convyio tokens", () => {
    const result = sanitizedChildEnvironment({
      PATH: "/bin",
      HOME: "/home/test",
      LANG: "C",
      ANTHROPIC_API_KEY: "claude-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
      AGENT_TOKEN: "convyio-secret",
      CONVYIO_INSTALLATION_TOKEN: "convyio-installation-secret",
      RANDOM_SECRET: "nope",
    });
    assert.deepEqual(result, {
      PATH: "/bin",
      HOME: "/home/test",
      LANG: "C",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
    });
  });
});
