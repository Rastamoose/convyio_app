import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ChatCompletionChunk, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { OpenAIBrain } from "../src/openaiBrain";
import type { BrainCallbacks } from "../src/brain";

// The OpenAI client is the brain's network boundary; the stub below stands in
// for it and records the request the brain assembles. The fake key never
// leaves the process because chat.completions.create is replaced before any run.

interface RecordedRequest {
  model: string;
  messages: ChatCompletionMessageParam[];
}

function stream(chunks: Partial<ChatCompletionChunk>[]): AsyncIterable<ChatCompletionChunk> {
  return (async function* () {
    for (const chunk of chunks) yield chunk as ChatCompletionChunk;
  })();
}

function stubbedBrain(
  respond: (request: RecordedRequest) => AsyncIterable<ChatCompletionChunk>,
): { brain: OpenAIBrain; requests: RecordedRequest[] } {
  const brain = new OpenAIBrain("fake-key", "fake-model");
  const requests: RecordedRequest[] = [];
  const client = {
    chat: {
      completions: {
        create: async (request: RecordedRequest) => {
          requests.push(request);
          return respond(request);
        },
      },
    },
  };
  (brain as unknown as { client: typeof client }).client = client;
  return { brain, requests };
}

const noopCallbacks: BrainCallbacks = { onEvent: () => {} };

describe("OpenAIBrain", () => {
  test("image parts come before the text part in the user message", async () => {
    const { brain, requests } = stubbedBrain(() => stream([{ choices: [{ delta: { content: "ok" }, index: 0, finish_reason: null }] }]));
    const images = [
      { mimeType: "image/png", data: "cGll" },
      { mimeType: "image/jpeg", data: "amFt" },
    ];

    const reply = await brain.run(
      { system: "sys", context: "ctx", prompt: "what is pictured?", images },
      noopCallbacks,
    );

    assert.equal(reply.text, "ok");
    assert.equal(requests.length, 1);
    const content = requests[0].messages[1].content as unknown as Array<Record<string, unknown>>;
    assert.equal(content.length, 3);
    assert.deepEqual(content[0], { type: "image_url", image_url: { url: "data:image/png;base64,cGll" } });
    assert.deepEqual(content[1], { type: "image_url", image_url: { url: "data:image/jpeg;base64,amFt" } });
    assert.equal(content[2].type, "text");
    assert.match(String(content[2].text), /<context>\nctx\n<\/context>/);
    assert.match(String(content[2].text), /what is pictured\?/);
  });

  test("setModel changes the model used in the next request", async () => {
    const { brain, requests } = stubbedBrain(() => stream([{ choices: [{ delta: { content: "ok" }, index: 0, finish_reason: null }] }]));
    await brain.run({ system: "sys", context: "ctx", prompt: "hi" }, noopCallbacks);
    brain.setModel("gpt-5-mini");
    await brain.run({ system: "sys", context: "ctx", prompt: "hi again" }, noopCallbacks);

    assert.equal(requests[0]!.model, "fake-model");
    assert.equal(requests[1]!.model, "gpt-5-mini");
  });

  test("no images means a plain string user message", async () => {
    const { brain, requests } = stubbedBrain(() => stream([{ choices: [{ delta: { content: "ok" }, index: 0, finish_reason: null }] }]));

    await brain.run({ system: "sys", context: "ctx", prompt: "hello" }, noopCallbacks);

    assert.equal(requests[0].messages[1].content, "<context>\nctx\n</context>\n\nhello");
  });

  test("normalizes tool-call lifecycle, plan updates, and streamed usage", async () => {
    let round = 0;
    const { brain, requests } = stubbedBrain(() => {
      round += 1;
      if (round === 1) {
        return stream([
          {
            choices: [{
              index: 0,
              finish_reason: null,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "board_propose", arguments: JSON.stringify({ title: "Ship it" }) },
                }],
              },
            }],
          },
        ]);
      }
      return stream([
        {
          choices: [{ index: 0, finish_reason: null, delta: { content: "done" } }],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 3,
            total_tokens: 8,
            prompt_tokens_details: { cached_tokens: 1 },
          },
        },
      ]);
    });
    const events: any[] = [];

    const result = await brain.run(
      {
        system: "sys",
        context: "ctx",
        prompt: "hi",
        tools: [{
          name: "board_propose",
          description: "Propose",
          parameters: { type: "object", properties: { title: { type: "string" } } },
        }],
      },
      { onEvent: (event) => events.push(event) },
      { onToolCall: async () => ({ ok: true }) },
    );

    assert.deepEqual(
      events.filter((event) => event.type !== "usage.reported").map((event) => event.type),
      ["tool.started", "plan.updated", "tool.completed", "output.delta"],
    );
    assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 3, cacheReadTokens: 1, totalTokens: 8 });
    assert.equal(result.providerSessionId, null);
    assert.equal(result.text, "done");

    assert.equal(requests.length, 2);
    const toolMessage = requests[1].messages.at(-1) as { role: string; tool_call_id: string; content: string };
    assert.equal(toolMessage.role, "tool");
    assert.equal(toolMessage.tool_call_id, "call-1");
    assert.equal(toolMessage.content, JSON.stringify({ ok: true }));
  });
});
