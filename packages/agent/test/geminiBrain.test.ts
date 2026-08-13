import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Part } from "@google/genai";
import { GeminiBrain } from "../src/geminiBrain";
import type { BrainCallbacks } from "../src/brain";

// GoogleGenAI is the brain's network boundary; the stub below stands in for
// it and records the request the brain assembles. The fake key never leaves
// the process because generateContentStream is replaced before any run.

interface RecordedRequest {
  contents: { role: string; parts: Part[] }[];
}

function stubbedBrain(): { brain: GeminiBrain; requests: RecordedRequest[] } {
  const brain = new GeminiBrain("fake-key", "fake-model");
  const requests: RecordedRequest[] = [];
  const ai = {
    models: {
      generateContentStream: async (request: RecordedRequest) => {
        requests.push(request);
        return (async function* () {
          yield { candidates: [{ content: { parts: [{ text: "ok" }] } }] };
        })();
      },
    },
  };
  (brain as unknown as { ai: typeof ai }).ai = ai;
  return { brain, requests };
}

const noopCallbacks: BrainCallbacks = { onEvent: () => {} };

describe("GeminiBrain", () => {
  test("image parts come before the text part in the first user content", async () => {
    const { brain, requests } = stubbedBrain();
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
    const parts = requests[0].contents[0].parts;
    assert.equal(parts.length, 3);
    assert.deepEqual(parts[0].inlineData, images[0]);
    assert.deepEqual(parts[1].inlineData, images[1]);
    assert.equal(parts[2].inlineData, undefined);
    assert.match(String(parts[2].text), /<context>\nctx\n<\/context>/);
    assert.match(String(parts[2].text), /what is pictured\?/);
  });

  test("no images means the single text part, unchanged", async () => {
    const { brain, requests } = stubbedBrain();

    await brain.run({ system: "sys", context: "ctx", prompt: "hello" }, noopCallbacks);

    const parts = requests[0].contents[0].parts;
    assert.equal(parts.length, 1);
    assert.equal(parts[0].text, "<context>\nctx\n</context>\n\nhello");
  });

  test("normalizes function lifecycle, plan updates, and exact streamed usage", async () => {
    const brain = new GeminiBrain("fake-key", "fake-model");
    let round = 0;
    const ai = {
      models: {
        generateContentStream: async () => {
          round += 1;
          return (async function* () {
            if (round === 1) {
              yield {
                candidates: [{ content: { parts: [{
                  functionCall: {
                    id: "call-1",
                    name: "board_propose",
                    args: { title: "Ship it" },
                  },
                }] } }],
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
              };
            } else {
              yield {
                candidates: [{ content: { parts: [{ text: "done" }] } }],
                usageMetadata: {
                  promptTokenCount: 5,
                  candidatesTokenCount: 3,
                  thoughtsTokenCount: 1,
                  totalTokenCount: 9,
                },
              };
            }
          })();
        },
      },
    };
    (brain as unknown as { ai: typeof ai }).ai = ai;
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
    assert.deepEqual(result.usage, {
      inputTokens: 15,
      outputTokens: 5,
      thoughtTokens: 1,
      totalTokens: 21,
    });
    assert.equal(result.providerSessionId, null);
    assert.equal(result.text, "done");
  });
});
