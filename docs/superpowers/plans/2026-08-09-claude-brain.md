# ClaudeBrain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ClaudeBrain`, a second `Brain` implementation in `packages/agent` using `@anthropic-ai/claude-agent-sdk`, selectable via `AGENT_PROVIDER`, authenticating via a pre-logged-in `claude` CLI subscription session (no API key).

**Architecture:** Extract the implicit interface `GeminiBrain` already exposes into a real `Brain` interface (`packages/agent/src/brain.ts`). Add `ClaudeBrain` (`packages/agent/src/claudeBrain.ts`) implementing it, wrapping the SDK's `query()`. Wire provider selection into `config.ts`/`index.ts`. `AgentRunner` and everything else in `packages/agent` is untouched except its constructor's parameter type.

**Tech Stack:** TypeScript, Node.js (`tsx`), `@anthropic-ai/claude-agent-sdk` (new dep, v0.3.226 confirmed on the npm registry), `zod` v4 (new dep, required as a peer of the SDK), `node:test` (existing test runner).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-09-claude-brain-design.md` — read it first, this plan implements it exactly.
- No `ANTHROPIC_API_KEY` fallback path — subscription auth only (spec §3, Decisions #1).
- Claude Code's native tools (Bash, Write, Edit, Glob, …) stay enabled, ungated, alongside board tools — accepted MVP debt (spec Decisions #2). Do not add approval-gating logic; that's explicitly a follow-up.
- Full token-level streaming from the start (`includePartialMessages: true`) — not the coarser block-level fallback discussed earlier.
- `AGENT_PROVIDER` defaults to `"gemini"` — zero behavior change for anyone not opting in.
- Reuse the existing `MAX_TOOL_ROUNDS` constant for `maxTurns` — no new turn-cap config knob.
- Never touch `package-lock.json` by hand — only via `npm install`.
- `AGENTS_PROGRAMMING_STANDARD.md` §1: search before writing, read before editing, evidence before assertion — quote real command output for every verification step, don't assert without running it.

---

## Task 1: Extract the `Brain` interface

**Files:**
- Create: `packages/agent/src/brain.ts`
- Modify: `packages/agent/src/geminiBrain.ts`
- Modify: `packages/agent/src/tools.ts`
- Modify: `packages/agent/src/runner.ts`
- Modify: `packages/agent/test/runner.test.ts`

**Interfaces:**
- Produces: `Brain` interface (`run(input: BrainInput, callbacks: BrainCallbacks, options?: BrainRunOptions): Promise<string>`), `BrainInput`, `BrainCallbacks`, `BrainRunOptions`, `ToolDeclaration`, `ToolExecutor`, `MAX_TOOL_ROUNDS`, `buildPromptText(input: BrainInput): string` — all from `packages/agent/src/brain.ts`. Every later task imports from here, not from `geminiBrain.ts`.

This is a pure refactor (no behavior change) — the regression guard is the existing test suite passing before and after, not a new test.

- [ ] **Step 1: Create `packages/agent/src/brain.ts`**

```ts
export const MAX_TOOL_ROUNDS = 12;

export interface BrainCallbacks {
  onThought(thought: string): void;
  onText(text: string): void;
}

/** JSON-schema-shaped tool declaration, mapped to each provider's own format. */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<
      string,
      { type: string; description?: string; items?: { type: string } }
    >;
    required?: string[];
  };
}

export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface BrainInput {
  system: string;
  context: string;
  prompt: string;
  /** Images the triggering messages carried; data is base64-encoded bytes. */
  images?: { mimeType: string; data: string }[];
  tools?: ToolDeclaration[];
}

export interface BrainRunOptions {
  signal?: AbortSignal;
  /** Invoked for each tool call the model makes; result is fed back. */
  onToolCall?: ToolExecutor;
}

/** A concrete LLM backend the agent can run a batch of work through. */
export interface Brain {
  run(input: BrainInput, callbacks: BrainCallbacks, options?: BrainRunOptions): Promise<string>;
}

export function buildPromptText(input: BrainInput): string {
  return `<context>\n${input.context}\n</context>\n\n${input.prompt}`;
}
```

- [ ] **Step 2: Rewrite `packages/agent/src/geminiBrain.ts` to use `brain.ts`**

Full replacement content:

```ts
import {
  GoogleGenAI,
  Type,
  type Content,
  type FunctionDeclaration,
  type Part,
  type Schema,
} from "@google/genai";
import {
  MAX_TOOL_ROUNDS,
  buildPromptText,
  type Brain,
  type BrainCallbacks,
  type BrainInput,
  type BrainRunOptions,
  type ToolDeclaration,
} from "./brain";

export class GeminiBrain implements Brain {
  private ai: GoogleGenAI;

  constructor(
    apiKey: string,
    private model: string,
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async run(input: BrainInput, callbacks: BrainCallbacks, options?: BrainRunOptions): Promise<string> {
    // Image parts go before the text: Gemini's image-understanding docs
    // recommend placing images ahead of the text prompt for best results.
    const contents: Content[] = [
      {
        role: "user",
        parts: [
          ...(input.images ?? []).map((image): Part => ({ inlineData: image })),
          { text: buildPromptText(input) },
        ],
      },
    ];
    const tools = input.tools?.length
      ? [{ functionDeclarations: input.tools.map(toFunctionDeclaration) }]
      : undefined;

    let finalText = "";

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await this.ai.models.generateContentStream({
        model: this.model,
        contents,
        config: {
          systemInstruction: input.system,
          thinkingConfig: { includeThoughts: true },
          abortSignal: options?.signal,
          tools,
        },
      });

      const modelParts: Part[] = [];
      const functionCalls: { name: string; args: Record<string, unknown> }[] = [];

      for await (const chunk of response) {
        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          modelParts.push(part);
          if (part.functionCall?.name) {
            functionCalls.push({
              name: part.functionCall.name,
              args: (part.functionCall.args ?? {}) as Record<string, unknown>,
            });
          } else if (part.text) {
            if (part.thought) {
              callbacks.onThought(part.text);
            } else {
              callbacks.onText(part.text);
              finalText += part.text;
            }
          }
        }
      }

      if (functionCalls.length === 0 || !options?.onToolCall) break;

      contents.push({ role: "model", parts: modelParts });
      const responses: Part[] = [];
      for (const call of functionCalls) {
        const result = await options.onToolCall(call.name, call.args);
        responses.push({
          functionResponse: { name: call.name, response: result },
        });
      }
      contents.push({ role: "user", parts: responses });
    }

    return finalText.trim() || "(no response)";
  }
}

function toFunctionDeclaration(tool: ToolDeclaration): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: toSchema(tool.parameters),
  };
}

function toSchema(param: ToolDeclaration["parameters"]): Schema {
  const properties: Record<string, Schema> = {};
  for (const [key, value] of Object.entries(param.properties)) {
    properties[key] = {
      type: typeFor(value.type),
      ...(value.description ? { description: value.description } : {}),
      ...(value.items ? { items: { type: typeFor(value.items.type) } } : {}),
    };
  }
  return { type: Type.OBJECT, properties, required: param.required };
}

function typeFor(t: string): Type {
  switch (t) {
    case "number":
      return Type.NUMBER;
    case "integer":
      return Type.INTEGER;
    case "boolean":
      return Type.BOOLEAN;
    case "array":
      return Type.ARRAY;
    default:
      return Type.STRING;
  }
}
```

(Only change from today's file: the five types + `MAX_TOOL_ROUNDS` + `buildContents` are gone, replaced by the `./brain` import; `buildContents(input)` call becomes `buildPromptText(input)`; class gains `implements Brain`.)

- [ ] **Step 3: Update `packages/agent/src/tools.ts`'s import**

Change line 2 from:

```ts
import type { ToolDeclaration, ToolExecutor } from "./geminiBrain";
```

to:

```ts
import type { ToolDeclaration, ToolExecutor } from "./brain";
```

Nothing else in `tools.ts` changes.

- [ ] **Step 4: Update `packages/agent/src/runner.ts`'s brain type**

Change line 4 from:

```ts
import type { GeminiBrain } from "./geminiBrain";
```

to:

```ts
import type { Brain } from "./brain";
```

And change the constructor parameter (currently `private brain: GeminiBrain,`) to:

```ts
    private brain: Brain,
```

Nothing else in `runner.ts` changes — it only ever calls `this.brain.run(...)`, which is already the `Brain` interface shape.

- [ ] **Step 5: Update `packages/agent/test/runner.test.ts`**

Change line 10 from:

```ts
import type { BrainInput, GeminiBrain } from "../src/geminiBrain";
```

to:

```ts
import type { Brain, BrainInput } from "../src/brain";
```

Then find both occurrences of `as unknown as GeminiBrain` (currently at the two `brain = {...} as unknown as GeminiBrain` stub declarations) and change each to `as unknown as Brain`.

- [ ] **Step 6: Verify no regression**

Run:

```bash
npx tsc --noEmit -p packages/agent
npm test -w @workspace/agent
```

Expected: both exit 0, all existing tests (`geminiBrain.test.ts`, `tools.test.ts`, `runner.test.ts`, `memory.test.ts`, `pendingWork.test.ts`) still pass, unchanged in count and content. Quote the actual output when reporting this step done — do not assert it passed without having run it.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/brain.ts packages/agent/src/geminiBrain.ts packages/agent/src/tools.ts packages/agent/src/runner.ts packages/agent/test/runner.test.ts
git commit -m "$(cat <<'EOF'
Extract Brain interface from GeminiBrain

Pure refactor, no behavior change: GeminiBrain's implicit run()
contract becomes an explicit Brain interface in a new brain.ts, so a
second provider can implement it. Per ARCHITECTURE.md's note to
extract this "when a second provider exists".

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add the SDK dependencies

**Files:**
- Modify: `packages/agent/package.json`

**Interfaces:**
- Produces: `@anthropic-ai/claude-agent-sdk` and `zod` importable from `packages/agent/src/*.ts`.
- Consumes: nothing from earlier tasks.

This task's only job is proving the install works cleanly given the `zod` version split noted in the spec's Open Risk — `server`/`shared` are pinned to `zod ^3.24.1`, the SDK wants `zod ^4.0.0`.

- [ ] **Step 1: Install the dependencies into the agent workspace**

```bash
npm install @anthropic-ai/claude-agent-sdk@^0.3.226 zod@^4.0.0 -w @workspace/agent
```

- [ ] **Step 2: Verify both zod majors coexist without an unmet-peer error**

```bash
npm ls zod
```

Expected: no `UNMET DEPENDENCY`/`invalid` warnings; the tree shows `zod@3.24.x` (used by `@workspace/server`/`@workspace/shared`) and `zod@4.x` (used by `@workspace/agent`) both resolved. If npm instead reports a conflict or silently collapses to one version such that `packages/agent`'s `zod` import would resolve to v3, stop and report the discrepancy — do not force-resolve or downgrade the SDK.

- [ ] **Step 3: Verify `packages/agent/package.json` picked up both deps**

```bash
git diff packages/agent/package.json
```

Expected: `"@anthropic-ai/claude-agent-sdk": "^0.3.226"` and `"zod": "^4.0.0"` added under `"dependencies"`.

- [ ] **Step 4: Commit**

```bash
git add packages/agent/package.json package-lock.json
git commit -m "$(cat <<'EOF'
Add @anthropic-ai/claude-agent-sdk and zod deps to packages/agent

Confirmed on the npm registry this session: claude-agent-sdk@0.3.226
(peer deps zod ^4.0.0, @anthropic-ai/sdk >=0.93.0,
@modelcontextprotocol/sdk ^1.29.0). zod v4 coexists alongside the v3
pinned in server/shared — packages/agent has no runtime zod import
from @workspace/shared today, only type-only imports.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `ClaudeBrain` core — request, streaming, errors

**Files:**
- Create: `packages/agent/src/claudeBrain.ts`
- Create: `packages/agent/test/claudeBrain.test.ts`

**Interfaces:**
- Consumes: `Brain`, `BrainInput`, `BrainCallbacks`, `BrainRunOptions`, `MAX_TOOL_ROUNDS`, `buildPromptText` from `./brain` (Task 1). `query`, `type Options`, `type SDKMessage`, `type SDKUserMessage` from `@anthropic-ai/claude-agent-sdk` (Task 2).
- Produces: `ClaudeBrain` class implementing `Brain`, constructor `(model: string, cwd: string)`. Tool bridging (`mcpServers`) is added in Task 4 — this task's `ClaudeBrain` runs without board tools, native Claude Code tools only.

This is TDD: each step below writes one test, verifies it fails, then the implementation step after step 5 makes all of them pass at once (the class is one coherent unit — splitting the implementation itself into 5 micro-diffs would be artificial).

- [ ] **Step 1: Write `packages/agent/test/claudeBrain.test.ts` with the core test cases**

```ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CanUseTool, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeBrain } from "../src/claudeBrain";
import type { BrainCallbacks } from "../src/brain";

// query() is the brain's network boundary (spawns the bundled claude CLI
// binary); the stub below stands in for it and records the request the
// brain assembles. No real subprocess or credentials are touched.

interface RecordedRequest {
  prompt: unknown;
  options: Record<string, unknown>;
}

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
  (brain as unknown as { query: typeof query }).query = query;
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

  test("caps turns at MAX_TOOL_ROUNDS and reuses it for maxTurns", async () => {
    const { brain, requests } = stubbedBrain([resultMessage("ok")]);

    await brain.run({ system: "sys", context: "ctx", prompt: "hi" }, noopCallbacks);

    assert.equal(requests[0].options.maxTurns, 12);
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
});
```

- [ ] **Step 2: Run the test file to verify it fails (no implementation yet)**

```bash
npx tsx --test packages/agent/test/claudeBrain.test.ts
```

Expected: FAIL — `Cannot find module '../src/claudeBrain'` (the file doesn't exist yet).

- [ ] **Step 3: Create `packages/agent/src/claudeBrain.ts`**

```ts
import {
  query as claudeQuery,
  type Options,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  MAX_TOOL_ROUNDS,
  buildPromptText,
  type Brain,
  type BrainCallbacks,
  type BrainInput,
  type BrainRunOptions,
} from "./brain";

export class ClaudeBrain implements Brain {
  private query = claudeQuery;

  constructor(
    private model: string,
    private cwd: string,
  ) {}

  async run(input: BrainInput, callbacks: BrainCallbacks, options?: BrainRunOptions): Promise<string> {
    const abortController = new AbortController();
    if (options?.signal) {
      if (options.signal.aborted) abortController.abort();
      options.signal.addEventListener("abort", () => abortController.abort());
    }

    const claudeOptions: Options = {
      model: this.model,
      cwd: this.cwd,
      systemPrompt: input.system,
      abortController,
      includePartialMessages: true,
      maxTurns: MAX_TOOL_ROUNDS,
      // ponytail: always-allow stub. Native Claude Code tools (Bash, Write,
      // Edit, ...) run ungated for MVP — board-approval routing for them is
      // deferred debt, see ARCHITECTURE.md's 2026-08-09 decision log entry.
      canUseTool: async () => ({ behavior: "allow" }),
    };

    const stream = this.query({ prompt: buildClaudePrompt(input), options: claudeOptions });

    let finalText = "";
    for await (const message of stream) {
      if (message.type === "stream_event") {
        const event = message.event;
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            callbacks.onText(event.delta.text);
          } else if (event.delta.type === "thinking_delta") {
            callbacks.onThought(event.delta.thinking);
          }
        }
      } else if (message.type === "result") {
        if (message.subtype === "success") {
          finalText = message.result;
        } else {
          throw new Error(
            `claude agent sdk error (${message.subtype}): ${message.errors.join("; ") || "no details"}`,
          );
        }
      }
    }

    return finalText.trim() || "(no response)";
  }
}

function buildClaudePrompt(input: BrainInput): string | AsyncIterable<SDKUserMessage> {
  const text = buildPromptText(input);
  if (!input.images?.length) return text;
  const images = input.images;
  return (async function* (): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          ...images.map((image) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: image.mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
              data: image.data,
            },
          })),
          { type: "text" as const, text },
        ],
      },
    };
  })();
}
```

- [ ] **Step 4: Run typecheck**

```bash
npx tsc --noEmit -p packages/agent
```

Expected: exit 0. If the `content_block_delta`/`text_delta`/`thinking_delta` field names don't match, `tsc` will point at the exact mismatch — fix against the real type (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`'s `BetaRawMessageStreamEvent`, re-exported from `@anthropic-ai/sdk`), don't loosen with `any`.

- [ ] **Step 5: Run the test file to verify it passes**

```bash
npx tsx --test packages/agent/test/claudeBrain.test.ts
```

Expected: PASS, all 8 tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/claudeBrain.ts packages/agent/test/claudeBrain.test.ts
git commit -m "$(cat <<'EOF'
Add ClaudeBrain core: request, streaming, error mapping

Implements Brain via @anthropic-ai/claude-agent-sdk's query(). No
board-tool bridging yet (Task 4) — native Claude Code tools only,
gated by an always-allow canUseTool stub (deferred MVP debt, see
ARCHITECTURE.md). Full token-level streaming via
includePartialMessages, matching GeminiBrain's granularity.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `ClaudeBrain` — board tool bridging

**Files:**
- Modify: `packages/agent/src/claudeBrain.ts`
- Modify: `packages/agent/test/claudeBrain.test.ts`

**Interfaces:**
- Consumes: `ToolDeclaration`, `ToolExecutor` from `./brain` (Task 1). `tool`, `createSdkMcpServer` from `@anthropic-ai/claude-agent-sdk`. `z` from `zod`.
- Produces: when `BrainInput.tools` and `BrainRunOptions.onToolCall` are both present, `ClaudeBrain.run()` registers them as an in-process MCP server named `"board"`, alongside the native toolset.

- [ ] **Step 1: Add the failing test to `packages/agent/test/claudeBrain.test.ts`**

Add this `import` alongside the existing ones at the top:

```ts
import type { ToolDeclaration, ToolExecutor } from "../src/brain";
```

Add this test inside the existing `describe("ClaudeBrain", ...)` block:

```ts
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
```

`createSdkMcpServer` is a second network-adjacent boundary the brain calls (it registers a live local MCP transport) — like `query`, it needs to be stubbed rather than exercised for real, so the test can capture exactly what tool list was registered without depending on `@modelcontextprotocol/sdk`'s internal `McpServer` object shape. Add this helper and stubbing alongside the existing `stubbedBrain` function (replace the whole function):

```ts
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
```

(This replaces the `stubbedBrain` written in Task 3 — same signature and behavior, plus the new `createSdkMcpServer` stub field.)

- [ ] **Step 2: Run the test file to verify the two new tests fail**

```bash
npx tsx --test packages/agent/test/claudeBrain.test.ts
```

Expected: the two new tests FAIL (`mcpServers` is `undefined`, or `createSdkMcpServer`/`this.createSdkMcpServer` doesn't exist on `ClaudeBrain` yet); all prior tests still PASS.

- [ ] **Step 3: Add tool bridging to `packages/agent/src/claudeBrain.ts`**

Replace the full file content with:

```ts
import {
  query as claudeQuery,
  tool,
  createSdkMcpServer as claudeCreateSdkMcpServer,
  type Options,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  MAX_TOOL_ROUNDS,
  buildPromptText,
  type Brain,
  type BrainCallbacks,
  type BrainInput,
  type BrainRunOptions,
  type ToolDeclaration,
  type ToolExecutor,
} from "./brain";

export class ClaudeBrain implements Brain {
  private query = claudeQuery;
  private createSdkMcpServer = claudeCreateSdkMcpServer;

  constructor(
    private model: string,
    private cwd: string,
  ) {}

  async run(input: BrainInput, callbacks: BrainCallbacks, options?: BrainRunOptions): Promise<string> {
    const abortController = new AbortController();
    if (options?.signal) {
      if (options.signal.aborted) abortController.abort();
      options.signal.addEventListener("abort", () => abortController.abort());
    }

    const boardServer =
      input.tools?.length && options?.onToolCall
        ? this.createSdkMcpServer({
            name: "board",
            version: "1.0.0",
            tools: input.tools.map((decl) => toSdkTool(decl, options.onToolCall!)),
          })
        : undefined;

    const claudeOptions: Options = {
      model: this.model,
      cwd: this.cwd,
      systemPrompt: input.system,
      abortController,
      includePartialMessages: true,
      maxTurns: MAX_TOOL_ROUNDS,
      // ponytail: always-allow stub. Native Claude Code tools (Bash, Write,
      // Edit, ...) run ungated for MVP — board-approval routing for them is
      // deferred debt, see ARCHITECTURE.md's 2026-08-09 decision log entry.
      canUseTool: async () => ({ behavior: "allow" }),
      ...(boardServer ? { mcpServers: { board: boardServer } } : {}),
    };

    const stream = this.query({ prompt: buildClaudePrompt(input), options: claudeOptions });

    let finalText = "";
    for await (const message of stream) {
      if (message.type === "stream_event") {
        const event = message.event;
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            callbacks.onText(event.delta.text);
          } else if (event.delta.type === "thinking_delta") {
            callbacks.onThought(event.delta.thinking);
          }
        }
      } else if (message.type === "result") {
        if (message.subtype === "success") {
          finalText = message.result;
        } else {
          throw new Error(
            `claude agent sdk error (${message.subtype}): ${message.errors.join("; ") || "no details"}`,
          );
        }
      }
    }

    return finalText.trim() || "(no response)";
  }
}

function buildClaudePrompt(input: BrainInput): string | AsyncIterable<SDKUserMessage> {
  const text = buildPromptText(input);
  if (!input.images?.length) return text;
  const images = input.images;
  return (async function* (): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          ...images.map((image) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: image.mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
              data: image.data,
            },
          })),
          { type: "text" as const, text },
        ],
      },
    };
  })();
}

function toSdkTool(decl: ToolDeclaration, executor: ToolExecutor) {
  return tool(decl.name, decl.description, toZodShape(decl.parameters), async (args) => {
    const result = await executor(decl.name, args as Record<string, unknown>);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}

function toZodShape(params: ToolDeclaration["parameters"]): Record<string, z.ZodTypeAny> {
  const required = new Set(params.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(params.properties)) {
    const field = zodFieldFor(prop);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}

function zodFieldFor(prop: { type: string; description?: string; items?: { type: string } }): z.ZodTypeAny {
  const base = ((): z.ZodTypeAny => {
    switch (prop.type) {
      case "number":
        return z.number();
      case "integer":
        return z.number().int();
      case "boolean":
        return z.boolean();
      case "array":
        return z.array(zodFieldFor(prop.items ?? { type: "string" }));
      default:
        return z.string();
    }
  })();
  return prop.description ? base.describe(prop.description) : base;
}
```

- [ ] **Step 4: Run typecheck**

```bash
npx tsc --noEmit -p packages/agent
```

Expected: exit 0. `tool()`'s handler argument type is `InferShape<Schema>`, which for a dynamically-built `Record<string, z.ZodTypeAny>` shape will be a fairly loose inferred type — if `tsc` complains that `args` in `toSdkTool`'s handler isn't assignable to `Record<string, unknown>`, adjust the cast on that line (it's already written as `args as Record<string, unknown>` to handle this), don't change `toZodShape`'s signature.

- [ ] **Step 5: Run the full test file to verify all tests pass**

```bash
npx tsx --test packages/agent/test/claudeBrain.test.ts
```

Expected: PASS, all 10 tests green (8 from Task 3 + 2 new).

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/claudeBrain.ts packages/agent/test/claudeBrain.test.ts
git commit -m "$(cat <<'EOF'
Bridge board tools into ClaudeBrain via an in-process MCP server

TOOL_DECLARATIONS (passed as BrainInput.tools, same as GeminiBrain
already receives them) are wrapped with the SDK's tool()/
createSdkMcpServer() and registered under mcpServers.board, closing
over that run's onToolCall executor. Native Claude Code tools stay
available alongside them, per the MVP tradeoff already recorded.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire provider selection (`config.ts`, `index.ts`)

**Files:**
- Modify: `packages/agent/src/config.ts`
- Modify: `packages/agent/src/index.ts`

**Interfaces:**
- Consumes: `ClaudeBrain` (Task 4), `GeminiBrain`, `Brain` (Task 1).
- Produces: `AGENT_PROVIDER: "gemini" | "claude"`, `CLAUDE_WORKDIR: string` exported from `config.ts`, both consumed only by `index.ts`.

No new automated test: the branch being added (`AGENT_PROVIDER === "claude" ? ... : ...`) is a one-line ternary, not the kind of logic `AGENTS_PROGRAMMING_STANDARD.md` §11 requires a test for, and `config.ts`/`index.ts` have no existing test file to extend (they're startup wiring, verified by running the process, not unit tests). Verification is a manual dev-run smoke check in Step 3.

- [ ] **Step 1: Rewrite `packages/agent/src/config.ts`**

Full replacement content:

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// dotenv.config() with no path defaults to CWD, but npm workspaces run this
// script with cwd = packages/agent, not the repo root where .env lives. Point
// at it explicitly so `npm run dev` picks up the root .env either way.
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

export const AGENT_NAME = process.env.AGENT_NAME ?? "noodle";
export const WS_URL = process.env.WS_URL ?? "ws://localhost:3001";
/** Join secret for auth-enabled servers; omitted on guest-mode servers. */
export const AGENT_TOKEN = process.env.AGENT_TOKEN;

/** Which LLM backend the agent runs against. */
export const AGENT_PROVIDER: "gemini" | "claude" =
  process.env.AGENT_PROVIDER === "claude" ? "claude" : "gemini";

/** No default on purpose: a missing key must fail loudly at startup (index.ts). Gemini provider only. */
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

export const AGENT_MODEL =
  process.env.AGENT_MODEL ?? (AGENT_PROVIDER === "claude" ? "claude-sonnet-5" : "gemini-2.5-flash");

/**
 * cwd Claude Code's native tools (Bash, Write, Edit, ...) operate in.
 * Mirrors the server's Toolman sandbox root (packages/server/src/index.ts's
 * `path.join(config.dataDir, "workspace")`), not this process's own
 * DATA_DIR (which is this agent's private memory/pending-work store).
 * Both assume process.cwd() is the repo root, same as DATA_DIR below.
 */
export const CLAUDE_WORKDIR =
  process.env.CLAUDE_WORKDIR ?? path.resolve(process.cwd(), "data", "workspace");

export const CHARTER_PATH = process.env.CHARTER_PATH ?? path.resolve(__dirname, "../charter.md");
export const DATA_DIR = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data", "agents", AGENT_NAME);
```

- [ ] **Step 2: Update `packages/agent/src/index.ts`**

Change the import block (currently lines 3–11) from:

```ts
import {
  AGENT_MODEL,
  AGENT_NAME,
  AGENT_TOKEN,
  CHARTER_PATH,
  DATA_DIR,
  GEMINI_API_KEY,
  WS_URL,
} from "./config";
import { AgentSocket } from "./socket";
import { GeminiBrain } from "./geminiBrain";
```

to:

```ts
import {
  AGENT_MODEL,
  AGENT_NAME,
  AGENT_PROVIDER,
  AGENT_TOKEN,
  CHARTER_PATH,
  CLAUDE_WORKDIR,
  DATA_DIR,
  GEMINI_API_KEY,
  WS_URL,
} from "./config";
import { AgentSocket } from "./socket";
import type { Brain } from "./brain";
import { GeminiBrain } from "./geminiBrain";
import { ClaudeBrain } from "./claudeBrain";
```

Add this function above `async function main()`:

```ts
function createBrain(): Brain {
  if (AGENT_PROVIDER === "claude") {
    return new ClaudeBrain(AGENT_MODEL, CLAUDE_WORKDIR);
  }
  return new GeminiBrain(GEMINI_API_KEY!, AGENT_MODEL);
}
```

Change the startup guard (currently):

```ts
  if (!GEMINI_API_KEY) {
    console.error("[agent] Missing GEMINI_API_KEY. Set it in the environment and restart.");
    process.exit(1);
  }
```

to:

```ts
  if (AGENT_PROVIDER === "gemini" && !GEMINI_API_KEY) {
    console.error("[agent] Missing GEMINI_API_KEY. Set it in the environment and restart.");
    process.exit(1);
  }
```

Change the brain construction line (currently `const brain = new GeminiBrain(GEMINI_API_KEY, AGENT_MODEL);`) to:

```ts
  const brain = createBrain();
```

- [ ] **Step 3: Typecheck and smoke-run with the default provider**

```bash
npx tsc --noEmit -p packages/agent
```

Expected: exit 0.

```bash
GEMINI_API_KEY=fake-key-for-smoke-test WS_URL=ws://localhost:9999 timeout 3 npx tsx packages/agent/src/index.ts; echo "exit: $?"
```

Expected: the process starts, logs a websocket connection attempt/failure against the unreachable `localhost:9999` (proving `createBrain()` picked `GeminiBrain` without throwing, since `AGENT_PROVIDER` is unset → defaults to `"gemini"` → the `GEMINI_API_KEY` guard passes), then is killed by `timeout` after 3s. This does not need a real Gemini key — it only proves the process reaches the socket-connect stage, not that a live run succeeds. Report the actual log output.

- [ ] **Step 4: Smoke-run with the Claude provider selected**

```bash
AGENT_PROVIDER=claude WS_URL=ws://localhost:9999 timeout 3 npx tsx packages/agent/src/index.ts; echo "exit: $?"
```

Expected: the process starts **without** exiting 1 on the `GEMINI_API_KEY` guard (proving the guard is now provider-conditional) and attempts the same websocket connection. It does not need a working `claude` CLI login to reach this point — `ClaudeBrain` isn't invoked until a run actually starts. Report the actual log output. If it exits 1 with the "Missing GEMINI_API_KEY" message, the guard change in Step 2 is wrong — fix it before proceeding.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/config.ts packages/agent/src/index.ts
git commit -m "$(cat <<'EOF'
Wire AGENT_PROVIDER to select GeminiBrain or ClaudeBrain

Defaults to "gemini" (no behavior change for existing deployments).
GEMINI_API_KEY is only required when the gemini provider is active.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Docs

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `DEPLOY.md`
- Modify: `ARCHITECTURE.md`
- Modify: `AGENTS.md`

**Interfaces:** none — documentation only, no code.

- [ ] **Step 1: Update `.env.example`**

Change:

```
# --- Agent (optional — without a key the workspace runs with no AI agent) ---
# GEMINI_API_KEY=your-gemini-api-key
# AGENT_NAME=noodle
# AGENT_MODEL=gemini-2.5-flash
```

to:

```
# --- Agent (optional — without a key the workspace runs with no AI agent) ---
# AGENT_PROVIDER=gemini            # "gemini" (default) or "claude"
# GEMINI_API_KEY=your-gemini-api-key   # gemini provider only
# AGENT_NAME=noodle
# AGENT_MODEL=gemini-2.5-flash     # or claude-sonnet-5 for the claude provider
# claude provider: no API key. Run `claude login` once on this host so the
# bundled claude CLI has a subscription session before starting the agent.
# CLAUDE_WORKDIR=./data/workspace  # cwd for Claude Code's native file/bash tools
```

- [ ] **Step 2: Update `README.md`**

Change (currently lines 19–20):

```
Set `GEMINI_API_KEY` in `.env` for the agent. Env overrides: `PORT`,
`CORS_ORIGIN`, `DATA_DIR` (server), `WS_URL` (agent), `VITE_WS_URL` (client).
```

to:

```
Set `GEMINI_API_KEY` in `.env` for the agent (default provider), or set
`AGENT_PROVIDER=claude` to run it against a Claude subscription instead — see
`DEPLOY.md` for what that requires. Env overrides: `PORT`, `CORS_ORIGIN`,
`DATA_DIR` (server), `WS_URL` (agent), `VITE_WS_URL` (client).
```

- [ ] **Step 3: Update `DEPLOY.md`**

Add two rows to the environment table (after the `AGENT_MODEL` row):

```
| `AGENT_PROVIDER`   | agent   | `gemini`                   | `gemini` or `claude`. `claude` needs no API key but does need a `claude login` session — see below. |
| `CLAUDE_WORKDIR`   | agent   | `./data/workspace`         | cwd for Claude Code's native file/bash tools when `AGENT_PROVIDER=claude`. |
```

Add a new section after "## Quick start — bare metal" (before "## Reverse proxy + TLS"):

```markdown
## Claude provider (subscription auth)

Setting `AGENT_PROVIDER=claude` runs the agent against
`@anthropic-ai/claude-agent-sdk` instead of Gemini. It authenticates via a
Claude Pro/Max subscription, not an API key — there is no
`ANTHROPIC_API_KEY` path. The SDK bundles its own `claude` CLI binary (no
separate install needed), but that binary's credential store must hold a
session from an interactive `claude login`, run once on whatever host
executes `packages/agent`.

- **Bare metal**: run `claude login` once on the machine before starting the
  agent process.
- **Docker**: the container is otherwise stateless, so the CLI's credential
  directory needs its own mounted volume (the same pattern as `-v
  "$PWD/data:/data"` for `DATA_DIR`) so a login survives container restarts —
  not automated by the current Dockerfile/compose setup.

Also known gap, tracked in `ARCHITECTURE.md`: with this provider, Claude
Code's native Bash/Write/Edit tools run ungated alongside the board tools,
so a board approval is not required for every mutation the agent can make.
```

- [ ] **Step 4: Update `ARCHITECTURE.md`**

Replace the `packages/agent` unit list entry for `GeminiBrain` (currently):

```
- `GeminiBrain` — the concrete LLM client (no interface: single
  implementation by design; extract one when a second provider exists).
```

with:

```
- `Brain` (`brain.ts`) — the interface every LLM backend implements
  (`run(input, callbacks, options) -> text`), plus the shared tool/prompt
  shapes both backends use.
- `GeminiBrain` — the Gemini implementation of `Brain`.
- `ClaudeBrain` — the Claude implementation of `Brain`, via
  `@anthropic-ai/claude-agent-sdk`; subscription-authenticated (`claude
  login`), no API key path.
```

Add two entries to the end of the "Decisions a reader would not predict" list:

```
- 2026-08-09 — `ClaudeBrain` authenticates exclusively via a pre-logged-in
  `claude` CLI subprocess (subscription auth, `claude login`), deliberately
  with no `ANTHROPIC_API_KEY` fallback. Consequence: every host running the
  agent with `AGENT_PROVIDER=claude` needs a one-time interactive login;
  headless/CI deploys of this provider aren't possible until that changes.
- 2026-08-09 — `ClaudeBrain` leaves Claude Code's native tools (Bash, Write,
  Edit, ...) enabled ungated, alongside the existing board tools. This
  bypasses the invariant below ("no agent write paths bypass Toolman") for
  the claude provider specifically — accepted as MVP debt. Consequence: with
  `AGENT_PROVIDER=claude`, the board is not a complete permission boundary; a
  human board approval is not required for Claude to write files or run
  shell commands. Follow-up: route `ClaudeBrain`'s `canUseTool` callback
  through the same board-approval flow `board_propose`/`write_file` already
  use.
```

Update the constraint line (currently):

```
- The board is a permission boundary. No agent write path may bypass
  `Toolman.execute`; tools not known to be read-only are treated as
  mutating (fail closed).
```

to:

```
- The board is a permission boundary. No agent write path may bypass
  `Toolman.execute`; tools not known to be read-only are treated as
  mutating (fail closed). Exception, tracked above: `ClaudeBrain`'s native
  Claude Code tools (`AGENT_PROVIDER=claude`) currently bypass this —
  accepted MVP debt, not the general rule.
```

- [ ] **Step 5: Update `AGENTS.md`**

Update the invariant line (currently):

```
- One SQLite file (`data/board.db`: actors, messages, board_items, append-only board_events) is the workspace store. The board is a permission boundary: `authorizeMutation` in `packages/server/src/board/Toolman.ts` refuses any mutating agent action without a workable (approved/in_progress) board item whose `scope_paths` cover the target path. Tools not known read-only are treated as mutating (fail closed). Do not add agent write paths that bypass it.
```

to:

```
- One SQLite file (`data/board.db`: actors, messages, board_items, append-only board_events) is the workspace store. The board is a permission boundary: `authorizeMutation` in `packages/server/src/board/Toolman.ts` refuses any mutating agent action without a workable (approved/in_progress) board item whose `scope_paths` cover the target path. Tools not known read-only are treated as mutating (fail closed). Do not add agent write paths that bypass it. Known exception: with `AGENT_PROVIDER=claude`, `ClaudeBrain` leaves Claude Code's native Bash/Write/Edit tools enabled ungated — an accepted MVP gap recorded in `ARCHITECTURE.md`'s 2026-08-09 decision log, not a precedent for new bypasses.
```

- [ ] **Step 6: Read the full diff**

```bash
git diff .env.example README.md DEPLOY.md ARCHITECTURE.md AGENTS.md
```

Confirm every edit landed exactly as specified above and nothing else in these files changed.

- [ ] **Step 7: Commit**

```bash
git add .env.example README.md DEPLOY.md ARCHITECTURE.md AGENTS.md
git commit -m "$(cat <<'EOF'
Document AGENT_PROVIDER, Claude subscription auth, and the native-tool gap

Covers .env.example, README, DEPLOY's Claude-provider runbook (login
+ Docker credential volume), and ARCHITECTURE/AGENTS' decision log +
invariant caveat for the accepted Toolman-bypass MVP debt.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification (after all 6 tasks)

```bash
npm run typecheck
npm test
```

Expected: both exit 0 across every workspace (`shared`, `server`, `agent`, `client`), matching `AGENTS.md`'s documented commands. Quote the actual output. This is the acceptance gate for the whole plan — do not report it complete without having run it.

**Not covered by this plan, and not expected to be:** an actual live run against a real `claude login` session. That needs a real Claude subscription and cannot be exercised by an automated test; it's a manual check for whoever deploys this (`AGENT_PROVIDER=claude` + `claude login` + `@noodle hello` in the workspace chat).
