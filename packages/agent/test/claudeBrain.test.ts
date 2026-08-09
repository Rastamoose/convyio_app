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
): { brain: ClaudeBrain; requests: RecordedRequest[] } {
  const brain = new ClaudeBrain("fake-model", "/fake/cwd");
  const requests: RecordedRequest[] = [];
  const query = (request: RecordedRequest) => {
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

function resultMessage(text: string): unknown {
  return { type: "result", subtype: "success", result: text };
}

function errorResult(subtype: string, errors: string[]): unknown {
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

const noopCallbacks: BrainCallbacks = { onThought: () => {}, onText: () => {} };

describe("ClaudeBrain", () => {
  test("returns the result message's text", async () => {
    const { brain } = stubbedBrain([resultMessage("hello there")]);

    const reply = await brain.run({ system: "sys", context: "ctx", prompt: "hi" }, noopCallbacks);

    assert.equal(reply, "hello there");
  });

  test("streams text and thinking deltas to their callbacks, in order", async () => {
    const { brain } = stubbedBrain([
      thinkingDelta("considering..."),
      textDelta("hel"),
      textDelta("lo"),
      resultMessage("hello"),
    ]);
    const seen: { kind: string; content: string }[] = [];
    const callbacks: BrainCallbacks = {
      onThought: (t) => seen.push({ kind: "thought", content: t }),
      onText: (t) => seen.push({ kind: "text", content: t }),
    };

    await brain.run({ system: "sys", context: "ctx", prompt: "hi" }, callbacks);

    assert.deepEqual(seen, [
      { kind: "thought", content: "considering..." },
      { kind: "text", content: "hel" },
      { kind: "text", content: "lo" },
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

  test("returns accumulated streamed text instead of throwing when output already streamed before an error result", async () => {
    const { brain } = stubbedBrain([
      textDelta("Partial progress before "),
      textDelta("hitting a limit."),
      errorResult("error_max_turns", ["exceeded maximum turns"]),
    ]);

    const reply = await brain.run({ system: "sys", context: "ctx", prompt: "hi" }, noopCallbacks);

    assert.equal(reply, "Partial progress before hitting a limit.");
  });

  test("caps turns at CLAUDE_MAX_TURNS", async () => {
    const { brain, requests } = stubbedBrain([resultMessage("ok")]);

    await brain.run({ system: "sys", context: "ctx", prompt: "hi" }, noopCallbacks);

    assert.equal(requests[0].options.maxTurns, CLAUDE_MAX_TURNS);
  });

  test("canUseTool always allows (native-tool gating is deferred MVP debt)", async () => {
    const { brain, requests } = stubbedBrain([resultMessage("ok")]);

    await brain.run({ system: "sys", context: "ctx", prompt: "hi" }, noopCallbacks);

    const canUseTool = requests[0].options.canUseTool as CanUseTool;
    const result = await canUseTool("Bash", {}, {
      signal: new AbortController().signal,
      toolUseID: "tool-1",
      requestId: "req-1",
    });
    assert.deepEqual(result, { behavior: "allow" });
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
