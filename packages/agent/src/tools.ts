import type { BoardItem } from "@workspace/shared";
import type { ToolDeclaration, ToolExecutor } from "./geminiBrain";
import type { BoardClient } from "./boardClient";

export const TOOL_DECLARATIONS: ToolDeclaration[] = [
  {
    name: "board_list",
    description: "List the current board items with their refs and statuses.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "board_propose",
    description:
      "Propose a new board item when needed work is not covered by any approved item. " +
      "Propose scopes, not steps. A human must approve it before the work can happen; " +
      "after proposing, tell the team briefly and either continue on another approved item or stop.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "What you want to add/change (one short line)" },
        why: { type: "string", description: "Why this is needed (one line)" },
        effect: { type: "string", description: "Expected effect once done (one line)" },
        scope_paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Workspace-relative paths the work will touch. An entry ending in \"/\" grants " +
            "that directory subtree; otherwise exactly that file. Approval authorizes only " +
            "this scope — mutations outside it are refused.",
        },
      },
      required: ["title", "why", "effect", "scope_paths"],
    },
  },
  {
    name: "board_start",
    description: "Mark an approved board item as in_progress before working on it.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Board item ref, e.g. task-3" },
      },
      required: ["ref"],
    },
  },
  {
    name: "board_complete",
    description: "Mark a board item's work as done once it is finished.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Board item ref, e.g. task-3" },
      },
      required: ["ref"],
    },
  },
  {
    name: "board_block",
    description:
      "Mark an in_progress board item as blocked while you wait on a human " +
      "(e.g. an open question or an approval on another proposal).",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Board item ref, e.g. task-3" },
        reason: { type: "string", description: "What you are waiting on" },
      },
      required: ["ref", "reason"],
    },
  },
  {
    name: "read_file",
    description: "Read a file from the shared workspace. Read-only; needs no board item.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description: "List files in a workspace directory. Read-only; needs no board item.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory relative to the workspace root; omit for the root" },
      },
    },
  },
  {
    name: "write_file",
    description:
      "Write a file in the shared workspace. Mutating: requires board_item_ref for an " +
      "approved or in_progress board item, or the toolman will refuse.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root" },
        content: { type: "string", description: "Full file content to write" },
        board_item_ref: { type: "string", description: "Backing board item ref, e.g. task-3" },
      },
      required: ["path", "content", "board_item_ref"],
    },
  },
  {
    name: "append_file",
    description:
      "Append to a file in the shared workspace. Mutating: requires board_item_ref for an " +
      "approved or in_progress board item, or the toolman will refuse.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root" },
        content: { type: "string", description: "Content to append" },
        board_item_ref: { type: "string", description: "Backing board item ref, e.g. task-3" },
      },
      required: ["path", "content", "board_item_ref"],
    },
  },
];

export interface ToolHooks {
  /** Fired when the agent files a proposal (so it can block on it). */
  onProposed(item: BoardItem): void;
  /** Fired when a tool call runs against a workable item (current task). */
  onTaskActive(item: BoardItem): void;
  /** Fired so tool activity shows up in the visible run trace. */
  onActivity(line: string): void;
}

export function createToolExecutor(board: BoardClient, hooks: ToolHooks): ToolExecutor {
  return async (name, args) => {
    const str = (key: string): string => String(args[key] ?? "");
    try {
      switch (name) {
        case "board_list": {
          hooks.onActivity("board_list");
          return { board: board.summary() };
        }
        case "board_propose": {
          const item = await board.propose({
            title: str("title"),
            why: str("why"),
            effect: str("effect"),
            // An omitted/empty scope goes through as [] so the server's
            // SCOPE_REQUIRED rejection reaches the model verbatim.
            scopePaths: Array.isArray(args.scope_paths) ? args.scope_paths.map(String) : [],
          });
          hooks.onProposed(item);
          hooks.onActivity(`proposed ${item.ref}: ${item.title}`);
          return {
            ref: item.ref,
            status: item.status,
            note: "Proposal filed; a human must approve it. Tell the team briefly, then continue on another approved item or end your turn.",
          };
        }
        case "board_start": {
          const item = await board.start(str("ref"));
          hooks.onTaskActive(item);
          hooks.onActivity(`started ${item.ref}`);
          return { ref: item.ref, status: item.status };
        }
        case "board_complete": {
          const item = await board.complete(str("ref"));
          hooks.onActivity(`completed ${item.ref}`);
          return { ref: item.ref, status: item.status };
        }
        case "board_block": {
          const item = await board.block(str("ref"), str("reason"));
          hooks.onActivity(`blocked ${item.ref}: ${str("reason")}`);
          return { ref: item.ref, status: item.status };
        }
        case "read_file": {
          hooks.onActivity(`read_file ${str("path")}`);
          const result = await board.requestAction({ kind: "read_file", path: str("path") }, null);
          return result.ok ? { content: result.output } : { error: result.error };
        }
        case "list_files": {
          const path = args.path ? str("path") : undefined;
          hooks.onActivity(`list_files ${path ?? "."}`);
          const result = await board.requestAction({ kind: "list_files", path }, null);
          return result.ok ? { listing: result.output } : { error: result.error };
        }
        case "write_file":
        case "append_file": {
          const ref = str("board_item_ref");
          const item = board.resolve(ref);
          if (item && (item.status === "approved" || item.status === "in_progress")) {
            hooks.onTaskActive(item);
          }
          hooks.onActivity(`${name} ${str("path")} (${ref || "no ref"})`);
          const result = await board.requestAction(
            { kind: name, path: str("path"), content: str("content") },
            ref || null,
          );
          if (!result.ok && result.code) {
            hooks.onActivity(`toolman denied ${name}: ${result.code}`);
            return {
              denied: result.code,
              error: result.error,
              note:
                result.code === "SCOPE_VIOLATION"
                  ? "That path is outside the backing item's approved scope_paths. Stay within the approved scope, or board_propose a new item covering that path."
                  : "No workable board item authorizes this. Use board_propose to request the scope, then wait for approval.",
            };
          }
          return result.ok ? { done: result.output } : { error: result.error };
        }
        default:
          return { error: `unknown tool: ${name}` };
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      hooks.onActivity(`${name} failed: ${detail}`);
      return { error: detail };
    }
  };
}
