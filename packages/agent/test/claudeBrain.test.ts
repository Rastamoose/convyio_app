import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CanUseTool, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeBrain, CLAUDE_MAX_TURNS } from "../src/claudeBrain";
import type { BrainCallbacks } from "../src/brain";
import type { ToolDeclaration, ToolExecutor } from "../src/brain";

// query() is the brain's network boundary (spawns the bundled claude CLI
// binary); the stub below stands in for it and records the request the
// brain assembles. No real subprocess or credentials are touched.

interface RecordedRequest {
  prompt: unknown;
  options: Record<string, unknown>;
}

interface RegisteredServer {
  tools: { name: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { type: string; text: string }[] }> }[];
}

const registeredTools: RegisteredServer[] = [];

function stubbedBrain(
  messages: unknown[],
  model: string | null = "fake-model",
): { brain: ClaudeBrain; requests: RecordedRequest[] } {
  return stubbedBrainRuns([messages], model);
}

function stubbedBrainRuns(
  runs: unknown[][],
  model: string | null = "fake-model",
): { brain: ClaudeBrain; requests: RecordedRequest[] } {
  const brain = new ClaudeBrain(model ?? undefined, "/fake/cwd");
  const requests: RecordedRequest[] = [];
  const query = (request: RecordedRequest) => {
    const messages = runs[requests.length] ?? [];
    requests.push(request);
    return (async function* () {
      for (const message of messages) yield message as SDKMessage;
    })();
  };
  const createSdkMcpServer = (options: RegisteredServer) => {
    registeredTools.push(options);
    return { type: "sdk" as const, name: "board", instance: {} };
  };
  (brain as unknown as { query: typeof query }).query = query;
  (brain as unknown as { createSdkMcpServer: typeof createSdkMcpServer }).createSdkMcpServer =
    createSdkMcpServer;
  return { brain, requests };
}

function resultMessage(text: string): Record<string, unknown> {
  return { type: "result", subtype: "success", result: text };
}

function errorResult(subtype: string, errors: string[]): Record<string, unknown> {
  return { type: "result", subtype, errors };
}

function textDelta(text: string): unknown {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  };
}

function thinkingDelta(thinking: string): unknown {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } },
  };
}

const noopCallbacks: BrainCallbacks = { onEvent: () => {} };

describe("ClaudeBrain", () => {
  test("returns the result message's text", async () => {
    const { brain } = stubbedBrain([resultMessage("hello there")]);

    const reply = await brain.run({ system: "sys", context: "ctx", prompt: "hi" }, noopCallbacks);

    assert.equal(reply.text, "hello there");
  });

  test("streams text and thinking deltas to their callbacks, in order", async () => {
    const { brain } = stubbedBrain([
      thinkingDelta("considering..."),
      textDelta("hel"),
      textDelta("lo"),
      resultMessage("hello"),
    ]);
    const seen: { type: string; text: string }[] = [];
    const callbacks: BrainCallbacks = {
      onEvent: (event) => {
        if (event.type === "thought.delta" || event.type === "output.delta") seen.push(event);
      },
    };

    await brain.run({ system: "sys", context: "ctx", prompt: "hi" }, callbacks);

    assert.deepEqual(seen, [
      { type: "thought.delta", text: "considering..." },
      { type: "output.delta", text: "hel" },
      { type: "output.delta", text: "lo" },
    ]);
  });

  test("resumes the exact provider session and captures the returned session", async () => {
    const { brain, requests } = stubbedBrain([
      { ...resultMessage("ok"), session_id: "session-returned" },
    ]);
    const events: unknown[] = [];

    const result = await brain.run(
      { system: "sys", context: "ctx", prompt: "hi" },
      { onEvent: (event) => events.push(event) },
      { providerSessionId: "session-exact", permissionMode: "plan" },
    );

    assert.equal(requests[0].options.resume, "session-exact");
    assert.equal(Object.hasOwn(requests[0].options, "continue"), false);
    assert.equal(requests[0].options.permissionMode, "plan");
    assert.equal(Object.hasOwn(requests[0].options, "settingSources"), false);
    assert.equal(result.providerSessionId, "session-returned");
    assert.deepEqual(events, [
      { type: "provider.session", providerSessionId: "session-returned" },
    ]);
  });

  test("passes system prompt and combined context/prompt text through", async () => {
    const { brain, requests } = stubbedBrain([resultMessage("ok")]);

    await brain.run({ system: "be nice", context: "ctx", prompt: "what is pictured?" }, noopCallbacks);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.systemPrompt, "be nice");
    assert.equal(requests[0].prompt, "<context>\nctx\n</context>\n\nwhat is pictured?");
  });

  test("images are sent as a user message with image blocks before the text block", async () => {
    const { brain, requests } = stubbedBrain([resultMessage("ok")]);
    const images = [{ mimeType: "image/png", data: "cGll" }];

    await brain.run(
      { system: "sys", context: "ctx", prompt: "what is pictured?", images },
      noopCallbacks,
    );

    const prompt = requests[0].prompt as AsyncIterable<{ message: { content: { type: string }[] } }>;
    const messages: { message: { content: { type: string }[] } }[] = [];
    for await (const m of prompt) messages.push(m);

    assert.equal(messages.length, 1);
    const content = messages[0].message.content;
    assert.equal(content.length, 2);
    assert.equal(content[0].type, "image");
    assert.equal(content[1].type, "text");
  });

  test("no images means a plain string prompt", async () => {
    const { brain, requests } = stubbedBrain([resultMessage("ok")]);

    await brain.run({ system: "sys", context: "ctx", prompt: "hello" }, noopCallbacks);

    assert.equal(typeof requests[0].prompt, "string");
  });

  test("a non-success result throws an error runner.ts can classify", async () => {
    const { brain } = stubbedBrain([
      errorResult("error_during_execution", ["oauth token expired: authentication_failed"]),
    ]);

    await assert.rejects(
      () => brain.run({ system: "sys", context: "ctx", prompt: "hi" }, noopCallbacks),
      /authentication_failed/,
    );
  });

  test("throws when an error result follows streamed output", async () => {
    const { brain } = stubbedBrain([
      textDelta("Partial progress before "),
      textDelta("hitting a limit."),
      errorResult("error_max_turns", ["exceeded maximum turns"]),
    ]);

    await assert.rejects(
      () => brain.run({ system: "sys", context: "ctx", prompt: "hi" }, noopCallbacks),
      /exceeded maximum turns/,
    );
  });

  test("caps turns at CLAUDE_MAX_TURNS", async () => {
    const { brain, requests } = stubbedBrain([resultMessage("ok")]);

    await brain.run({ system: "sys", context: "ctx", prompt: "hi" }, noopCallbacks);

    assert.equal(requests[0].options.maxTurns, CLAUDE_MAX_TURNS);
  });

  test("omits the model option when using the Claude harness default", async () => {
    const { brain, requests } = stubbedBrain([resultMessage("ok")], null);

    await brain.run({ system: "sys", context: "ctx", prompt: "hi" }, noopCallbacks);

    assert.equal(Object.hasOwn(requests[0].options, "model"), false);
  });

  test("retries a recognized unavailable configured model once with the harness default", async () => {
    const { brain, requests } = stubbedBrainRuns([
      [errorResult("error_during_execution", ["Model fake-model not found"])],
      [resultMessage("fallback reply")],
    ]);

    const reply = await brain.run({ system: "sys", context: "ctx", prompt: "hi" }, noopCallbacks);

    assert.equal(reply.text, "fallback reply");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].options.model, "fake-model");
    assert.equal(Object.hasOwn(requests[1].options, "model"), false);
  });

  test("does not retry auth, rate, network, or general errors", async () => {
    for (const error of [
      "authentication_failed",
      "rate limit exceeded",
      "ECONNRESET while contacting API",
      "unexpected execution failure",
    ]) {
      const { brain, requests } = stubbedBrain([errorResult("error_during_execution", [error])]);

      await assert.rejects(() => brain.run({ system: "sys", context: "ctx", prompt: "hi" }, noopCallbacks));

      assert.equal(requests.length, 1, error);
    }
  });

  test("does not retry an unavailable model after streamed output", async () => {
    const { brain, requests } = stubbedBrain([
      textDelta("Already emitted."),
      errorResult("error_during_execution", ["Model fake-model not found"]),
    ]);

    await assert.rejects(
      () => brain.run({ system: "sys", context: "ctx", prompt: "hi" }, noopCallbacks),
      /Model fake-model not found/,
    );

    assert.equal(requests.length, 1);
  });

  test("does not retry an unavailable model after a board tool side effect", async () => {
    const { brain, requests } = stubbedBrain([]);
    let calls = 0;
    const query = (request: RecordedRequest) => {
      requests.push(request);
      return (async function* () {
        await registeredTools.at(-1)!.tools[0].handler({}, undefined);
        yield errorResult("error_during_execution", ["Model fake-model not found"]) as SDKMessage;
      })();
    };
    (brain as unknown as { query: typeof query }).query = query;

    await assert.rejects(() =>
      brain.run(
        {
          system: "sys",
          context: "ctx",
          prompt: "hi",
          tools: [{ name: "board_propose", description: "Propose", parameters: { type: "object", properties: {} } }],
        },
        noopCallbacks,
        {
          onToolCall: async () => {
            calls += 1;
            return { ok: true };
          },
        },
      ),
    );

    assert.equal(calls, 1);
    assert.equal(requests.length, 1);
  });

  test("normalizes hook tool lifecycle, plan updates, and result usage", async () => {
    const usage = {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 2,
      webSearchRequests: 0,
      costUSD: 0.01,
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
    };
    const { brain, requests } = stubbedBrain([
      { ...resultMessage("ok"), session_id: "session-1", modelUsage: { sonnet: usage } },
    ]);
    const events: any[] = [];

    const result = await brain.run(
      { system: "sys", context: "ctx", prompt: "hi" },
      { onEvent: (event) => events.push(event) },
    );
    const hooks = requests[0].options.hooks as Record<
      string,
      { hooks: ((input: any, toolUseId?: string) => Promise<unknown>)[] }[]
    >;
    const base = { session_id: "session-1", transcript_path: "/tmp/transcript", cwd: "/tmp" };
    await hooks.PreToolUse[0].hooks[0]({
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "TodoWrite",
      tool_input: { todos: [{ content: "ship", status: "pending" }] },
      tool_use_id: "tool-plan",
    });
    await hooks.PreToolUse[0].hooks[0]({
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "TodoWrite",
      tool_input: {},
      tool_use_id: "tool-plan",
    });
    await hooks.PostToolUse[0].hooks[0]({
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "TodoWrite",
      tool_input: {},
      tool_response: { content: "large file contents must not leak" },
      tool_use_id: "tool-plan",
    });
    await hooks.PostToolUseFailure[0].hooks[0]({
      ...base,
      hook_event_name: "PostToolUseFailure",
      tool_name: "Read",
      tool_input: { path: "README.md" },
      tool_use_id: "tool-failed",
      error: "not found",
    });

    assert.deepEqual(result.usage, {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      costUsd: 0.01,
    });
    assert.deepEqual(
      events.filter((event) => event.type.startsWith("tool.") || event.type === "plan.updated").map((event) => event.type),
      ["tool.started", "plan.updated", "tool.completed", "tool.started", "tool.failed"],
    );
    assert.deepEqual(events.find((event) => event.type === "tool.completed").output, {
      content: "[string:33 chars]",
    });
  });

  test("reports usage before throwing an error result", async () => {
    const events: any[] = [];
    const { brain } = stubbedBrain([{
      ...errorResult("error_during_execution", ["provider failed"]),
      usage: { input_tokens: 7, output_tokens: 1 },
    }]);

    await assert.rejects(() =>
      brain.run(
        { system: "sys", context: "ctx", prompt: "hi" },
        { onEvent: (event) => events.push(event) },
      ),
    );
    assert.deepEqual(events.find((event) => event.type === "usage.reported"), {
      type: "usage.reported",
      usage: { inputTokens: 7, outputTokens: 1 },
    });
  });

  test("only exposes and approves safe native read tools", async () => {
    const { brain, requests } = stubbedBrain([resultMessage("ok")]);

    await brain.run({ system: "sys", context: "ctx", prompt: "hi" }, noopCallbacks);

    assert.deepEqual(requests[0].options.tools, ["Read", "Glob", "Grep", "WebFetch", "WebSearch"]);
    const canUseTool = requests[0].options.canUseTool as CanUseTool;
    for (const toolName of ["Read", "Glob", "Grep", "WebFetch", "WebSearch"]) {
      const result = await canUseTool(toolName, {}, {
        signal: new AbortController().signal,
        toolUseID: `tool-${toolName}`,
        requestId: `request-${toolName}`,
      });
      assert.deepEqual(result, { behavior: "allow" });
    }
  });

  test("denies native mutation tools and unknown tools", async () => {
    const { brain, requests } = stubbedBrain([resultMessage("ok")]);

    await brain.run({ system: "sys", context: "ctx", prompt: "hi" }, noopCallbacks);

    const canUseTool = requests[0].options.canUseTool as CanUseTool;
    for (const toolName of ["Bash", "Write", "Edit", "NotebookEdit", "DeleteEverything", "mcp__other__write"]) {
      const result = await canUseTool(toolName, {}, {
        signal: new AbortController().signal,
        toolUseID: `tool-${toolName}`,
        requestId: `request-${toolName}`,
      });
      assert.equal(result?.behavior, "deny");
      if (result?.behavior === "deny") assert.match(result.message, /not approved/);
    }
  });

  test("board tool calls are bridged through onToolCall and results returned as MCP content", async () => {
    const toolDecl: ToolDeclaration = {
      name: "board_list",
      description: "List board items",
      parameters: { type: "object", properties: {} },
    };
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const onToolCall: ToolExecutor = async (name, args) => {
      calls.push({ name, args });
      return { board: "(empty)" };
    };
    const { brain, requests } = stubbedBrain([resultMessage("done")]);

    await brain.run(
      { system: "sys", context: "ctx", prompt: "hi", tools: [toolDecl] },
      noopCallbacks,
      { onToolCall },
    );

    const mcpServers = requests[0].options.mcpServers as
      | Record<string, { instance?: unknown }>
      | undefined;
    assert.ok(mcpServers?.board, "expected a 'board' MCP server to be registered");
    const canUseTool = requests[0].options.canUseTool as CanUseTool;
    const permission = await canUseTool("mcp__board__board_list", {}, {
      signal: new AbortController().signal,
      toolUseID: "tool-board-list",
      requestId: "request-board-list",
    });
    assert.deepEqual(permission, { behavior: "allow" });

    const registered = registeredTools.at(-1);
    assert.ok(registered, "expected createSdkMcpServer to have been called");
    assert.equal(registered!.tools.length, 1);
    assert.equal(registered!.tools[0].name, "board_list");

    const result = await registered!.tools[0].handler({}, undefined);
    assert.deepEqual(calls, [{ name: "board_list", args: {} }]);
    assert.deepEqual(result, { content: [{ type: "text", text: JSON.stringify({ board: "(empty)" }) }] });
  });

  test("no tools registered when the run has no onToolCall", async () => {
    const toolDecl: ToolDeclaration = {
      name: "board_list",
      description: "List board items",
      parameters: { type: "object", properties: {} },
    };
    const { brain, requests } = stubbedBrain([resultMessage("done")]);

    await brain.run({ system: "sys", context: "ctx", prompt: "hi", tools: [toolDecl] }, noopCallbacks);

    assert.equal(requests[0].options.mcpServers, undefined);
  });
});
