# ClaudeBrain: a second LLM provider for packages/agent

Date: 2026-08-09
Status: approved for planning

## Context

`packages/agent` is the workspace's AI participant: a standalone process that
joins the server over the same websocket protocol a human client uses, and is
bound by the same board-authorization boundary (`Toolman`). Today it has
exactly one LLM backend, `GeminiBrain` (`@google/genai`, `GEMINI_API_KEY`).
`ARCHITECTURE.md` already flags this as deliberate: "no interface: single
implementation by design; extract one when a second provider exists."

The trigger for this work: investigating how Block's `buzz` app lets agents
ride an existing Claude Pro/Max subscription instead of a metered API key —
it shells out to the `claude` CLI (via the Claude Agent SDK) and lets that
CLI's own `claude login` session provide auth. We want the same pattern here,
as the first of two new providers (Claude now, OpenAI/Codex as a smaller
follow-up once this one is proven).

## Goal

Add `ClaudeBrain`, a second implementation of a newly-extracted `Brain`
interface, using `@anthropic-ai/claude-agent-sdk` (confirmed on the npm
registry this session: v0.3.226, peer deps `zod ^4.0.0`,
`@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`).
Provider is chosen via a new `AGENT_PROVIDER` env var; default stays
`"gemini"`, so this ships with zero behavior change until someone opts in.

Out of scope for this spec: the OpenAI/Codex provider (follow-up), and
properly gating Claude Code's built-in tools through board approval (accepted
MVP debt, recorded below).

## Architecture

### 1. Extract `Brain` (`packages/agent/src/brain.ts`)

Move out of `geminiBrain.ts`, unchanged in shape: `BrainInput`,
`BrainCallbacks`, `BrainRunOptions`, `ToolDeclaration`, `ToolExecutor`, and
the `MAX_TOOL_ROUNDS` constant (currently a private module constant in
`geminiBrain.ts`; both brains need it, so it becomes a shared export). Add
the interface itself:

```ts
export interface Brain {
  run(input: BrainInput, callbacks: BrainCallbacks, options?: BrainRunOptions): Promise<string>;
}
```

`GeminiBrain` and `ClaudeBrain` both implement it. `tools.ts` and `runner.ts`
import these types from `brain.ts` instead of `geminiBrain.ts`.
`AgentRunner`'s only change is its constructor parameter type:
`GeminiBrain` → `Brain`.

### 2. Provider selection

`config.ts` adds:
- `AGENT_PROVIDER = process.env.AGENT_PROVIDER ?? "gemini"` (`"gemini" | "claude"`)
- `AGENT_MODEL` default becomes provider-dependent: `"gemini-2.5-flash"` for
  gemini, `"claude-sonnet-5"` for claude, when unset.
- `CLAUDE_WORKDIR = process.env.CLAUDE_WORKDIR ?? path.resolve(process.cwd(), "data", "workspace")`
  — mirrors the *server's* `Toolman` sandbox root (`path.join(config.dataDir, "workspace")`,
  where the server's `DATA_DIR` defaults to `<repo root>/data`), not the
  agent's own `DATA_DIR` (which is a different path: the agent's private
  memory/pending-work store, `data/agents/<name>/`). Both defaults assume
  `process.cwd()` is the repo root, matching how the agent's own `DATA_DIR`
  default already works and how `DEPLOY.md`'s bare-metal commands invoke
  both processes. Confirmed by reading `packages/server/src/index.ts:31`
  and `packages/server/src/config.ts:15` this session — not guessed.

`index.ts`'s startup guard only requires `GEMINI_API_KEY` when
`AGENT_PROVIDER === "gemini"`. For `"claude"`, no key is required or read —
auth is entirely the pre-authenticated `claude` CLI's job (see §3).

### 3. `ClaudeBrain` (`packages/agent/src/claudeBrain.ts`)

Wraps `query()` from `@anthropic-ai/claude-agent-sdk`. Per `run()` call:

- **Auth**: none configured by us. `query()` shells out to the `claude` CLI
  on `PATH`; that CLI must already be authenticated via an interactive
  `claude login` on the host running the agent process. There is no
  `ANTHROPIC_API_KEY` fallback path — a deliberate choice (see Decisions).
- **Tools — board tools**: `TOOL_DECLARATIONS` (from `tools.ts`) are bridged
  into an in-process MCP server via `createSdkMcpServer()` + `tool()` (zod
  schema per declaration — this is what pulls in the `zod ^4` peer dep),
  built fresh inside each `run()` call so it closes over that call's
  `options.onToolCall` (the same per-batch executor `AgentRunner` already
  constructs with its `onProposed`/`onTaskActive`/`onActivity` hooks — no
  change to how `runner.ts` builds it).
- **Tools — native**: Claude Code's built-in toolset (Bash, Read, Write,
  Edit, Glob, WebFetch, …) is left enabled alongside the board tools. This is
  the accepted MVP gap — see Decisions.
- **cwd**: set to `CLAUDE_WORKDIR` (defaults to the same directory Toolman
  sandboxes file actions to), so native-tool file/bash activity defaults to
  a sane location even though nothing enforces staying inside it.
- **canUseTool**: wired as a stub that currently allows every call
  unconditionally, with a comment marking it as the exact seam for routing
  through board approval later.
- **Streaming (full token-level, per your call)**: `includePartialMessages: true`.
  Iterate the `Query` async generator; for `type: 'stream_event'` messages,
  read the wrapped `BetaRawMessageStreamEvent` — `content_block_delta` with
  `delta.type === 'text_delta'` → `callbacks.onText(delta.text)`,
  `delta.type === 'thinking_delta'` → `callbacks.onThought(delta.thinking)`.
  This is the same raw per-token SSE shape as the plain Anthropic Messages
  API streaming, so granularity matches `GeminiBrain`'s today.
- **Final text**: taken from `SDKResultSuccess.result` (the SDK's own
  authoritative final string) rather than manually concatenated from deltas.
- **Images**: `BrainInput.images` sent as an `SDKUserMessage` with
  Anthropic-style base64 `image` content blocks, alongside the text prompt —
  `query()`'s `prompt` accepts `string | AsyncIterable<SDKUserMessage>`.
- **Abort**: `options?.signal` (an `AbortSignal`) bridges to the SDK's
  `Options.abortController` (which wants a full `AbortController`, not just
  a signal) by constructing one and forwarding `abort()` when the incoming
  signal fires.
- **Turn cap**: `maxTurns: MAX_TOOL_ROUNDS` — reuses the existing constant
  (currently 12) so both providers cap agentic looping by the same number,
  no new config knob.
- **Errors**: any `SDKResultError` / `SDKAssistantMessageError` is thrown as
  an `Error` whose message includes a recognizable substring
  (`"authentication"`, `"rate limit"`, etc.) so `runner.ts`'s existing
  `friendlyErrorMessage()` string-matching keeps working unmodified across
  both providers.

### 4. Deployment note (not solved here, documented)

Subscription auth means the `claude` CLI's credential/session state must
persist on whatever host runs `packages/agent`. For a bare-metal deploy
that's a one-time `claude login` on that machine. For the Docker path
(`DEPLOY.md`), it means mounting a volume for the CLI's credential
directory, the same way `data/` is already mounted — flagged in `DEPLOY.md`,
not solved in this pass.

## Decisions a reader would not predict

Two entries land in `ARCHITECTURE.md`'s decision log as part of this change:

1. **Claude subscription auth, no API-key fallback.** `ClaudeBrain`
   authenticates exclusively via a pre-logged-in `claude` CLI subprocess
   (`claude login`, riding an existing Pro/Max subscription), deliberately
   with no `ANTHROPIC_API_KEY` escape hatch. Consequence: every host running
   the agent with `AGENT_PROVIDER=claude` needs an interactive one-time login
   step; headless/CI deploys of the Claude provider aren't possible until
   that changes.
2. **Claude Code's built-in tools (Bash, Write, Edit, …) are enabled
   ungated, alongside the existing board tools.** This bypasses the
   documented invariant in `AGENTS.md`: *"Do not add agent write paths that
   bypass \[Toolman]."* Accepted as MVP debt: `board_propose`/`write_file`/etc.
   remain the scope-checked path, but `ClaudeBrain` additionally has an
   unchecked path via Claude Code's own tools once its cwd is reached
   (or escaped via Bash `cd`). Consequence: with `AGENT_PROVIDER=claude`, the
   board is no longer a complete permission boundary — a human approval on a
   board item is not required for Claude to write files or run commands.
   Follow-up: route `ClaudeBrain`'s `canUseTool` callback through the same
   board-approval flow `board_propose`/`write_file` already use, closing this
   gap before any non-MVP use.

`AGENTS.md:15`'s invariant line gets a caveat noting this exception exists
today, scoped to `AGENT_PROVIDER=claude`.

## Testing

`packages/agent/test/claudeBrain.test.ts` (node:test, matching the existing
suite style), stubbing the SDK's `query()`. Covers:
- board-tool round trip (declaration → `tool()` wrapper → `onToolCall` → SDK
  tool result) using a fake `ToolExecutor`
- streaming: a fake sequence of `stream_event` messages maps to the right
  `onText`/`onThought` calls in the right order
- final-result extraction from `SDKResultSuccess`
- error mapping: a fake `SDKResultError` becomes a thrown `Error` whose
  message contains the substring `friendlyErrorMessage()` expects

No live network or `claude` CLI calls in tests.

## Open risk, not a blocker

`@anthropic-ai/claude-agent-sdk` wants `zod ^4`; `server`/`shared` are on
`zod ^3.24.1`. Checked this session: `packages/agent` currently has no
runtime import of anything zod-based from `@workspace/shared` (only
type-only imports plus one plain type-guard function), so npm should be able
to nest a separate `zod` v4 copy under the SDK without touching the v3 used
elsewhere in the monorepo. To be confirmed at `npm install` time before any
code is written that depends on it holding.
