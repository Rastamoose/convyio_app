import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActionResultEvent, BoardItem, ToolmanAction } from "@workspace/shared";
import type { BoardClient } from "../src/boardClient";
import { TOOL_DECLARATIONS, createToolExecutor, type ToolHooks } from "../src/tools";

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
    planId: null,
    acceptanceCriteria: [],
    verificationEvidence: null,
    impactMap: null,
    proposalWhy: "sessions are safer",
    proposalEffect: "auth uses sessions",
    projectId: null,
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
      plan_id: "plan-1",
      acceptance_criteria: ["Totals match"],
    });

    assert.deepEqual(proposeCalls, [
      {
        title: "Fix rounding",
        why: "invoices drift",
        effect: "totals match",
        planId: "plan-1",
        acceptanceCriteria: ["Totals match"],
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
    // The note must steer the model back inside the sandbox without inventing a board workflow.
    assert.match(String(result.note), /workspace sandbox/);
    assert.doesNotMatch(String(result.note), /board_propose/);
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

  test("a capability denial tells the model to ask the human, not propose a ticket", async () => {
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
    assert.doesNotMatch(String(result.note), /propose/);
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

  test("project discovery and access requests are available to the model", async () => {
    const requested: unknown[] = [];
    const access = [{
      project: {
        id: "project-1",
        workspaceId: "workspace-1",
        name: "notes",
        kind: "directory" as const,
        remoteUrl: null,
        defaultBranch: null,
        createdBy: "human-1",
        createdByName: "Dana",
        createdAt: 1,
        archivedAt: null,
        accessMode: "ask" as const,
      },
      assignment: null,
      request: null,
    }];
    const board = {
      refreshProjectAccess: async () => access,
      requestProjectAccess: async (projectId: string, reason: string) => {
        requested.push({ projectId, reason });
        return access;
      },
    } as unknown as BoardClient;
    const execute = createToolExecutor(board, noopHooks());

    const listed = await execute("project_list", {});
    await execute("project_request_access", { project_id: "project-1", reason: "edit the notes" });

    assert.deepEqual(listed.projects, [{
      id: "project-1",
      name: "notes",
      kind: "directory",
      owner: "Dana",
      folder_policy: "ask",
      assignment_status: null,
      access_request_pending: false,
    }]);
    assert.deepEqual(requested, [{ projectId: "project-1", reason: "edit the notes" }]);
  });

  test("project add, edit, delete, and move tools support bounded chat grants", async () => {
    const sent: { action: ToolmanAction; ref: string | null }[] = [];
    const board = {
      resolve: () => undefined,
      requestAction: async (action: ToolmanAction, ref: string | null): Promise<ActionResultEvent> => {
        sent.push({ action, ref });
        return { type: "action_result", requestId: "project-write", ok: true, output: "ok" };
      },
    } as unknown as BoardClient;
    const execute = createToolExecutor(board, noopHooks());

    await execute("project_write_file", { project_id: "project-1", path: "a.txt", content: "one" });
    await execute("project_edit_file", { project_id: "project-1", path: "a.txt", old_string: "one", new_string: "two" });
    await execute("project_move_file", { project_id: "project-1", from: "a.txt", to: "b.txt" });
    await execute("project_delete_file", { project_id: "project-1", path: "b.txt" });

    assert.deepEqual(sent, [
      { action: { kind: "project_write_file", projectId: "project-1", path: "a.txt", content: "one" }, ref: null },
      { action: { kind: "project_edit_file", projectId: "project-1", path: "a.txt", oldString: "one", newString: "two" }, ref: null },
      { action: { kind: "project_move_file", projectId: "project-1", from: "a.txt", to: "b.txt" }, ref: null },
      { action: { kind: "project_delete_file", projectId: "project-1", path: "b.txt" }, ref: null },
    ]);
    for (const name of ["project_write_file", "project_edit_file", "project_move_file", "project_delete_file"]) {
      assert.equal(TOOL_DECLARATIONS.find((tool) => tool.name === name)?.parameters.required?.includes("board_item_ref"), false);
    }
  });

  test("Git status is read-only while Git push carries the ticket and conversation", async () => {
    const sent: { action: ToolmanAction; ref: string | null; conversationId: string | null }[] = [];
    const board = {
      resolve: () => boardItem({ status: "approved" }),
      requestAction: async (
        action: ToolmanAction,
        ref: string | null,
        conversationId: string | null,
      ): Promise<ActionResultEvent> => {
        sent.push({ action, ref, conversationId });
        return { type: "action_result", requestId: "git-1", ok: true, output: "ok" };
      },
    } as unknown as BoardClient;
    const execute = createToolExecutor(board, { ...noopHooks(), conversationId: "conv-git" });

    await execute("project_git_status", { project_id: "project-1" });
    await execute("project_git_push", { project_id: "project-1", board_item_ref: "task-4" });

    assert.deepEqual(sent, [
      {
        action: { kind: "project_git_status", projectId: "project-1" },
        ref: null,
        conversationId: "conv-git",
      },
      {
        action: { kind: "project_git_push", projectId: "project-1" },
        ref: "task-4",
        conversationId: "conv-git",
      },
    ]);
  });

  test("unknown tool name yields an error result", async () => {
    const execute = createToolExecutor({} as unknown as BoardClient, noopHooks());
    const result = await execute("launch_missiles", {});
    assert.match(String(result.error), /unknown tool/);
    assert.match(String(result.error), /launch_missiles/);
  });
});
