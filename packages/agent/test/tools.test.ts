import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActionResultEvent, BoardItem, ToolmanAction } from "@workspace/shared";
import type { BoardClient } from "../src/boardClient";
import { createToolExecutor, type ToolHooks } from "../src/tools";

// The BoardClient is the network boundary (HTTP board API + websocket
// toolman); these stubs stand in for the server, never for the executor.

function boardItem(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    id: "item-1",
    workspaceId: "srv-1",
    ref: "task-1",
    title: "Migrate auth",
    description: null,
    status: "proposed",
    origin: "agent",
    createdBy: "agent-1",
    approvedBy: null,
    owner: null,
    proposalWhy: "sessions are safer",
    proposalEffect: "auth uses sessions",
    scopePaths: ["billing/"],
    capabilities: null,
    createdAt: 0,
    approvedAt: null,
    startedAt: null,
    completedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function noopHooks(overrides: Partial<ToolHooks> = {}): ToolHooks {
  return {
    onProposed: () => {},
    onTaskActive: () => {},
    onActivity: () => {},
    ...overrides,
  };
}

describe("tool executor", () => {
  test("board_propose forwards scope_paths to the board and returns the filed item", async () => {
    const filed = boardItem({ ref: "task-7", status: "proposed" });
    const proposeCalls: unknown[] = [];
    const board = {
      propose: async (fields: unknown) => {
        proposeCalls.push(fields);
        return filed;
      },
    } as unknown as BoardClient;
    const proposed: BoardItem[] = [];
    const execute = createToolExecutor(
      board,
      noopHooks({ onProposed: (item) => proposed.push(item) }),
    );

    const result = await execute("board_propose", {
      title: "Fix rounding",
      why: "invoices drift",
      effect: "totals match",
      scope_paths: ["billing/", "notes.md"],
    });

    assert.deepEqual(proposeCalls, [
      {
        title: "Fix rounding",
        why: "invoices drift",
        effect: "totals match",
        scopePaths: ["billing/", "notes.md"],
      },
    ]);
    assert.equal(result.ref, "task-7");
    assert.equal(result.status, "proposed");
    assert.deepEqual(proposed, [filed]);
  });

  test("a SCOPE_VIOLATION deny returns corrective guidance", async () => {
    const board = {
      resolve: () => undefined,
      requestAction: async (
        _action: ToolmanAction,
        _ref: string | null,
      ): Promise<ActionResultEvent> => ({
        type: "action_result",
        requestId: "r-1",
        ok: false,
        code: "SCOPE_VIOLATION",
        error: "path outside approved scope",
      }),
    } as unknown as BoardClient;
    const execute = createToolExecutor(board, noopHooks());

    const result = await execute("write_file", {
      path: "secrets/keys.txt",
      content: "x",
      board_item_ref: "task-1",
    });

    assert.equal(result.denied, "SCOPE_VIOLATION");
    assert.equal(result.error, "path outside approved scope");
    // The note must steer the model back inside the approved scope.
    assert.match(String(result.note), /scope_paths/);
    assert.match(String(result.note), /board_propose/);
  });

  test("run_shell carries the command and the conversation's mode context", async () => {
    const sent: { action: ToolmanAction; ref: string | null; conversationId: unknown }[] = [];
    const board = {
      resolve: () => undefined,
      requestAction: async (
        action: ToolmanAction,
        ref: string | null,
        conversationId: string | null,
      ): Promise<ActionResultEvent> => {
        sent.push({ action, ref, conversationId });
        return { type: "action_result", requestId: "r-1", ok: true, output: "3 tests passed" };
      },
    } as unknown as BoardClient;
    const execute = createToolExecutor(board, { ...noopHooks(), conversationId: "conv-9" });

    const result = await execute("run_shell", { command: "npm test", board_item_ref: "task-1" });

    assert.deepEqual(sent[0].action, { kind: "run_shell", command: "npm test" });
    assert.equal(sent[0].ref, "task-1");
    // Without the conversation the server cannot tell which permission mode
    // applies, so it must reach the toolman with every mutating call.
    assert.equal(sent[0].conversationId, "conv-9");
    assert.equal(result.done, "3 tests passed");
  });

  test("a capability denial tells the model to propose the capability", async () => {
    const board = {
      resolve: () => undefined,
      requestAction: async (): Promise<ActionResultEvent> => ({
        type: "action_result",
        requestId: "r-1",
        ok: false,
        code: "CAPABILITY_MISSING",
        error: "task-1 does not grant shell_repo",
      }),
    } as unknown as BoardClient;
    const execute = createToolExecutor(board, noopHooks());

    const result = await execute("run_shell", { command: "rm -rf /", board_item_ref: "task-1" });

    assert.equal(result.denied, "CAPABILITY_MISSING");
    assert.match(String(result.note), /shell_repo/);
  });

  test("search_files is read-only: no board ref is sent", async () => {
    const sent: { action: ToolmanAction; ref: string | null }[] = [];
    const board = {
      resolve: () => undefined,
      requestAction: async (action: ToolmanAction, ref: string | null): Promise<ActionResultEvent> => {
        sent.push({ action, ref });
        return { type: "action_result", requestId: "r-1", ok: true, output: "a.ts:1: hit" };
      },
    } as unknown as BoardClient;
    const execute = createToolExecutor(board, noopHooks());

    const result = await execute("search_files", { query: "TODO" });

    assert.deepEqual(sent[0].action, { kind: "search_files", query: "TODO" });
    assert.equal(sent[0].ref, null);
    assert.equal(result.matches, "a.ts:1: hit");
  });

  test("unknown tool name yields an error result", async () => {
    const execute = createToolExecutor({} as unknown as BoardClient, noopHooks());
    const result = await execute("launch_missiles", {});
    assert.match(String(result.error), /unknown tool/);
    assert.match(String(result.error), /launch_missiles/);
  });
});
