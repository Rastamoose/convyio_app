import type { AuthzDenyCode, BoardItem, WorkCapability } from "@workspace/shared";
import type { ToolDeclaration, ToolExecutor } from "./brain";
import type { BoardClient } from "./boardClient";

export const TOOL_DECLARATIONS: ToolDeclaration[] = [
  {
    name: "board_list",
    description: "List the current board items with their refs and statuses.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "board_propose_plan",
    description:
      "Propose a read-only megaplan: objective, outline, impact map and at least one clarification. " +
      "Acceptance does not authorize mutations. After proposing, wait for a human to accept it.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short plan title" },
        objective: { type: "string", description: "What done looks like" },
        outline: { type: "array", items: { type: "string" }, description: "Ordered high-level steps" },
        clarifications: {
          type: "array",
          items: { type: "string" },
          description: "At least one clarifying question you asked, and the answer",
        },
      },
      required: ["title", "objective", "outline", "clarifications"],
    },
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
        plan_id: { type: "string", description: "Accepted plan this ticket belongs to, e.g. plan-1" },
        owner: { type: "string", description: "Actor id that will own the work" },
        acceptance_criteria: {
          type: "array",
          items: { type: "string" },
          description: "How we will know this ticket is done",
        },
        project_id: { type: "string", description: "Project this ticket authorizes, when the work is in a mounted project" },
        scope_paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Workspace-relative paths the work will touch. An entry ending in \"/\" grants " +
            "that directory subtree; otherwise exactly that file. Approval authorizes only " +
            "this scope — mutations outside it are refused. Paths are relative to the project root when project_id is set.",
        },
        capabilities: {
          type: "array",
          items: { type: "string", enum: ["file_write", "shell_repo", "network"] },
          description:
            "What the work needs to do. Omit for plain file edits (the default). " +
            "Ask for shell_repo only if you must run commands — it is coarse, since a " +
            "command's writes cannot be bounded by scope_paths — and network only if " +
            "the work installs packages or reaches outside the machine.",
        },
      },
      required: ["title", "why", "effect", "scope_paths", "plan_id", "acceptance_criteria"],
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
        evidence: { type: "string", description: "How the acceptance criteria were verified" },
      },
      required: ["ref", "evidence"],
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
    name: "search_files",
    description:
      "Search file contents across the workspace (like grep). Read-only; needs no board item.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text or basic regex to search for" },
        path: { type: "string", description: "Directory to search under; omit for the whole workspace" },
      },
      required: ["query"],
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
  {
    name: "run_shell",
    description:
      "Run a shell command in the workspace root (tests, builds, git). Mutating: requires " +
      "board_item_ref for an item that grants the shell_repo capability, or it will be refused.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command line to run via sh -c" },
        board_item_ref: { type: "string", description: "Backing board item ref, e.g. task-3" },
      },
      required: ["command", "board_item_ref"],
    },
  },
  {
    name: "project_read_file",
    description: "Read a text file from an assigned project checkout.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        path: { type: "string" },
      },
      required: ["project_id", "path"],
    },
  },
  {
    name: "project_list_files",
    description: "List files in an assigned project checkout.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        path: { type: "string" },
      },
      required: ["project_id"],
    },
  },
  {
    name: "project_search_files",
    description: "Search text in an assigned project checkout.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        query: { type: "string" },
        path: { type: "string" },
      },
      required: ["project_id", "query"],
    },
  },
  {
    name: "project_write_file",
    description: "Write a text file in an assigned project worktree. Requires a workable project-bound ticket.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        path: { type: "string" },
        content: { type: "string" },
        board_item_ref: { type: "string" },
      },
      required: ["project_id", "path", "content", "board_item_ref"],
    },
  },
  {
    name: "project_edit_file",
    description: "Replace one exact string in a project file. Requires a workable project-bound ticket.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        board_item_ref: { type: "string" },
      },
      required: ["project_id", "path", "old_string", "new_string", "board_item_ref"],
    },
  },
  {
    name: "project_run_command",
    description:
      "Run a non-interactive command, including ordinary Git commands, in the agent's assigned worktree. " +
      "Requires a workable project-bound ticket with shell_repo. This is not an OS sandbox.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        command: { type: "string" },
        board_item_ref: { type: "string" },
      },
      required: ["project_id", "command", "board_item_ref"],
    },
  },
];

/**
 * What the model should do about each refusal. The denial itself is enforced
 * server-side; this only tells the model how to get unstuck.
 */
const DENIAL_NOTES: Record<AuthzDenyCode, string> = {
  NO_BOARD_REF:
    "No workable board item authorizes this. Use board_propose to request the scope, then wait for approval.",
  ITEM_NOT_FOUND: "That ref does not exist. Check board_list, or board_propose a new item.",
  ITEM_WRONG_SERVER: "That item belongs to another workspace. Propose the work here instead.",
  ITEM_NOT_WORKABLE:
    "That item is not approved or in_progress yet. Wait for a human to approve it before working.",
  ITEM_DELETED: "That item was deleted. Stop this work and tell the team.",
  SCOPE_VIOLATION:
    "That path is outside the backing item's approved scope_paths. Stay within the approved scope, or board_propose a new item covering that path.",
  OWNER_MISMATCH:
    "That ticket is owned by someone else. Do not work it; propose a handoff if needed.",
  PROJECT_REQUIRED: "That action needs a project.",
  PROJECT_MISMATCH: "That action named the wrong project.",
  PROJECT_UNASSIGNED: "You are not assigned to that project.",
  CHECKOUT_UNAVAILABLE: "The assigned checkout is not ready.",
  OWNER_OFFLINE: "The folder owner is offline, so local files are unavailable. Wait until they return.",
  FOLDER_DENIED: "The folder owner has denied local access. Do not retry; ask them to change the folder policy.",
  UNKNOWN_ACTION: "That action is not classified and cannot be authorized.",
  CAPABILITY_MISSING:
    "That item does not grant this kind of action. Propose a new item requesting the capability you need (e.g. shell_repo) and explain why.",
  PLAN_MODE:
    "The conversation is in plan mode: nothing may change yet. Finish the plan and tell the team what you would do.",
  APPROVAL_DENIED: "A human declined this action. Do not retry it; ask what they would prefer.",
  APPROVAL_UNAVAILABLE:
    "The permission could not be recorded, so nothing ran. Report this and stop — do not retry mutations.",
};

export interface ToolHooks {
  /** Fired when the agent files a proposal. */
  onProposed(item: BoardItem): void;
  /** Fired when a tool call runs against a workable item (current task). */
  onTaskActive(item: BoardItem): void;
  /** Fired so tool activity shows up in the visible run trace. */
  onActivity(line: string): void;
  /** Conversation the actions belong to; selects the server-side permission mode. */
  conversationId?: string | null;
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
        case "board_propose_plan": {
          const plan = await board.proposePlan({
            title: str("title"),
            objective: str("objective"),
            outline: Array.isArray(args.outline) ? args.outline.map(String) : [],
            clarifications: Array.isArray(args.clarifications) ? args.clarifications.map(String) : [],
          });
          hooks.onActivity(`proposed plan ${plan.ref}: ${plan.title}`);
          return {
            ref: plan.ref,
            status: plan.status,
            note: "Plan filed. A human must accept it; acceptance grants no mutating authority.",
          };
        }
        case "board_propose": {
          const item = await board.propose({
            title: str("title"),
            why: str("why"),
            effect: str("effect"),
            planId: str("plan_id"),
            ...(str("owner") ? { owner: str("owner") } : {}),
            acceptanceCriteria: Array.isArray(args.acceptance_criteria)
              ? args.acceptance_criteria.map(String)
              : [],
            // An omitted/empty scope goes through as [] so the server's
            // SCOPE_REQUIRED rejection reaches the model verbatim.
            scopePaths: Array.isArray(args.scope_paths) ? args.scope_paths.map(String) : [],
            ...(str("project_id") ? { projectId: str("project_id") } : {}),
            ...(Array.isArray(args.capabilities)
              ? { capabilities: args.capabilities.map(String) as WorkCapability[] }
              : {}),
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
          const item = await board.complete(str("ref"), str("evidence"));
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
        case "search_files": {
          const path = args.path ? str("path") : undefined;
          hooks.onActivity(`search_files ${str("query")}`);
          const result = await board.requestAction(
            { kind: "search_files", query: str("query"), ...(path ? { path } : {}) },
            null,
          );
          return result.ok ? { matches: result.output } : { error: result.error };
        }
        case "list_files": {
          const path = args.path ? str("path") : undefined;
          hooks.onActivity(`list_files ${path ?? "."}`);
          const result = await board.requestAction({ kind: "list_files", path }, null);
          return result.ok ? { listing: result.output } : { error: result.error };
        }
        case "project_read_file": {
          hooks.onActivity(`${name} ${str("path")}`);
          const result = await board.requestAction(
            { kind: "project_read_file", projectId: str("project_id"), path: str("path") },
            null,
            hooks.conversationId ?? null,
          );
          return result.ok ? { content: result.output } : { error: result.error };
        }
        case "project_list_files": {
          hooks.onActivity(`${name} ${str("path") || "."}`);
          const result = await board.requestAction(
            { kind: "project_list_files", projectId: str("project_id"), ...(args.path ? { path: str("path") } : {}) },
            null,
            hooks.conversationId ?? null,
          );
          return result.ok ? { content: result.output } : { error: result.error };
        }
        case "project_search_files": {
          hooks.onActivity(`${name} ${str("query")}`);
          const result = await board.requestAction(
            {
              kind: "project_search_files",
              projectId: str("project_id"),
              query: str("query"),
              ...(args.path ? { path: str("path") } : {}),
            },
            null,
            hooks.conversationId ?? null,
          );
          return result.ok ? { content: result.output } : { error: result.error };
        }
        case "project_write_file":
        case "project_edit_file":
        case "project_run_command": {
          const ref = str("board_item_ref");
          const item = board.resolve(ref);
          if (item && (item.status === "approved" || item.status === "in_progress")) hooks.onTaskActive(item);
          hooks.onActivity(`${name} ${str("path") || str("command")} (${ref || "no ref"})`);
          const result = await board.requestAction(
            name === "project_run_command"
              ? { kind: name, projectId: str("project_id"), command: str("command") }
              : name === "project_edit_file"
                ? {
                    kind: name,
                    projectId: str("project_id"),
                    path: str("path"),
                    oldString: str("old_string"),
                    newString: str("new_string"),
                  }
                : { kind: name, projectId: str("project_id"), path: str("path"), content: str("content") },
            ref || null,
            hooks.conversationId ?? null,
          );
          if (!result.ok && result.code) {
            hooks.onActivity(`toolman denied ${name}: ${result.code}`);
            return { denied: result.code, error: result.error, note: DENIAL_NOTES[result.code] };
          }
          return result.ok ? { done: result.output } : { error: result.error };
        }
        case "write_file":
        case "append_file":
        case "run_shell": {
          const ref = str("board_item_ref");
          const item = board.resolve(ref);
          if (item && (item.status === "approved" || item.status === "in_progress")) {
            hooks.onTaskActive(item);
          }
          const target = name === "run_shell" ? str("command") : str("path");
          hooks.onActivity(`${name} ${target} (${ref || "no ref"})`);
          const result = await board.requestAction(
            name === "run_shell"
              ? { kind: "run_shell", command: str("command") }
              : { kind: name, path: str("path"), content: str("content") },
            ref || null,
            hooks.conversationId ?? null,
          );
          if (!result.ok && result.code) {
            hooks.onActivity(`toolman denied ${name}: ${result.code}`);
            return { denied: result.code, error: result.error, note: DENIAL_NOTES[result.code] };
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
