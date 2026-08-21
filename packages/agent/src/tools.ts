import type {
  AuthzDenyCode,
  BoardItem,
  ProjectAction,
  ProtectedResourceKind,
  ResourceManifestEntry,
  WorkCapability,
} from "@workspace/shared";
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
        constraints: {
          type: "array",
          items: { type: "string" },
          description: "Known constraints that must remain true",
        },
        assumed_owner_id: { type: "string", description: "Proposed owner actor id" },
        assumed_project_id: { type: "string", description: "Likely project or resource id" },
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
    name: "context_manifest",
    description:
      "List the workspace resources you can discover and whether their contents are accessible. " +
      "Call this first whenever the user refers to a channel, project, folder, or file by name. " +
      "Use the returned id (not the name) for context_request_access and read tools. This returns metadata only.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "context_channel_read",
    description:
      "Read at most 20 recent messages from a granted channel. " +
      "If you do not have access, this will automatically request it and pause until approved. " +
      "Use the exact channel_id from context_manifest.",
    parameters: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        before: { type: "number", description: "Optional exclusive timestamp for older messages" },
      },
      required: ["channel_id"],
    },
  },
  {
    name: "context_channel_search",
    description:
      "Search message text in a granted channel and return at most 20 matches. " +
      "If you do not have access, this will automatically request it and pause until approved. " +
      "Use the exact channel_id from context_manifest.",
    parameters: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        query: { type: "string" },
      },
      required: ["channel_id", "query"],
    },
  },
  {
    name: "context_request_access",
    description:
      "Request durable read/list/search access to one protected resource from the manifest. " +
      "Use the exact resource_id returned by context_manifest. " +
      "Call this immediately when the user asks you to use a resource you cannot access; do not ask the human for permission first. " +
      "The run will pause and continue automatically once the grant is approved.",
    parameters: {
      type: "object",
      properties: {
        resource_kind: { type: "string", description: "channel, git_project, local_project, or workspace_file" },
        resource_id: { type: "string" },
        reason: { type: "string", description: "Why the current request needs this resource" },
      },
      required: ["resource_kind", "resource_id", "reason"],
    },
  },
  {
    name: "context_note_list",
    description: "List active workspace guidance and your persistent notebook entries.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "context_note_save",
    description: "Save one concise persistent note to your own Convyio notebook.",
    parameters: {
      type: "object",
      properties: { body: { type: "string" } },
      required: ["body"],
    },
  },
  {
    name: "project_list",
    description: "List shared projects, assignment status, stable project ids, owners, and pending access requests.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "project_request_access",
    description:
      "Request access to an unassigned shared project. The folder owner must approve it. " +
      "The run will pause and continue automatically once the access is approved.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        reason: { type: "string", description: "Why this task needs the folder" },
      },
      required: ["project_id", "reason"],
    },
  },
  {
    name: "project_read_file",
    description: "Read a text file from an assigned local folder.",
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
    description: "List files in an assigned local folder.",
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
    description: "Search text in an assigned local folder.",
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
    description: "Write a text file in an assigned folder. Include board_item_ref for ticket work; omit it for a bounded chat edit so the server can request the required human grant.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        path: { type: "string" },
        content: { type: "string" },
        board_item_ref: { type: "string" },
      },
      required: ["project_id", "path", "content"],
    },
  },
  {
    name: "project_edit_file",
    description: "Replace one exact string in an assigned folder. Include board_item_ref for ticket work; omit it for a bounded chat edit.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        board_item_ref: { type: "string" },
      },
      required: ["project_id", "path", "old_string", "new_string"],
    },
  },
  {
    name: "project_delete_file",
    description: "Delete one file in an assigned folder. Include board_item_ref for ticket work; omit it for a bounded chat edit.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        path: { type: "string" },
        board_item_ref: { type: "string" },
      },
      required: ["project_id", "path"],
    },
  },
  {
    name: "project_move_file",
    description: "Move or rename one file in an assigned folder. Include board_item_ref for ticket work; omit it for a bounded chat edit.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        board_item_ref: { type: "string" },
      },
      required: ["project_id", "from", "to"],
    },
  },
  {
    name: "project_run_command",
    description:
      "Run a non-interactive command in the assigned project checkout. Include board_item_ref for ticket work; " +
      "omit it for a bounded chat action that may request approval. This is not an OS sandbox.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        command: { type: "string" },
        board_item_ref: { type: "string" },
      },
      required: ["project_id", "command"],
    },
  },
  {
    name: "project_git_status",
    description: "Show branch, working tree, and ahead/behind state for an assigned Git project. Read-only.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string" } },
      required: ["project_id"],
    },
  },
  ...["fetch", "pull", "push"].map((operation): ToolDeclaration => ({
    name: `project_git_${operation}`,
    description: `${operation} the assigned Git project. Include board_item_ref for ticket work; omit it for a bounded chat action that may request approval.`,
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        board_item_ref: { type: "string" },
      },
      required: ["project_id"],
    },
  })),
  {
    name: "project_git_branch",
    description: "Create and publish a branch in an assigned Git project. Include board_item_ref for ticket work; omit it for a bounded chat action that may request approval.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        name: { type: "string" },
        start_point: { type: "string" },
        board_item_ref: { type: "string" },
      },
      required: ["project_id", "name"],
    },
  },
  {
    name: "project_git_commit",
    description: "Commit all approved working-tree changes as the current agent. Include board_item_ref for ticket work; omit it for a bounded chat action that may request approval.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        message: { type: "string" },
        board_item_ref: { type: "string" },
      },
      required: ["project_id", "message"],
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
  CHECKOUT_UNAVAILABLE: "The assigned folder is not available. The owner's Toolman node may be offline.",
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
  /** Channel name used as the origin thread for Plans and Tickets. */
  channel?: string | null;
  /** Channel id used as the origin for resource access requests. */
  channelId?: string | null;
  /** Fired when the run pauses for a human approval decision. */
  onRunSuspended?(reason: string): void;
  /** Fired when a paused run resumes after approval or denial. */
  onRunResumed?(): void;
}

async function findManifestEntry(
  board: BoardClient,
  kind: ProtectedResourceKind,
  idOrName: string,
): Promise<ResourceManifestEntry | null> {
  const exact = board.resourceManifest()?.resources.find((r) => r.kind === kind && r.id === idOrName);
  if (exact) return exact;
  const byName = board.resourceManifest()?.resources.filter(
    (r) => r.kind === kind && r.name.toLowerCase() === idOrName.toLowerCase(),
  );
  if (byName && byName.length === 1) return byName[0];
  if (byName && byName.length > 1) return null; // ambiguous; require id
  // Refresh and try again
  await board.refreshManifest();
  const exact2 = board.resourceManifest()?.resources.find((r) => r.kind === kind && r.id === idOrName);
  if (exact2) return exact2;
  const byName2 = board.resourceManifest()?.resources.filter(
    (r) => r.kind === kind && r.name.toLowerCase() === idOrName.toLowerCase(),
  );
  if (byName2 && byName2.length === 1) return byName2[0];
  return null;
}

interface AccessWaitResult {
  granted: boolean;
  message: string;
}

async function ensureResourceAccess(
  board: BoardClient,
  resourceKind: ProtectedResourceKind,
  resourceId: string,
  resourceName: string,
  reason: string,
  originChannelId?: string | null,
): Promise<AccessWaitResult> {
  if (resourceKind === "git_project" || resourceKind === "local_project") {
    return ensureProjectAccess(board, resourceId, reason);
  }
  const denied: AccessWaitResult = {
    granted: false,
    message: `Access to '${resourceName}' was denied or not granted in time.`,
  };
  try {
    await board.requestResourceAccess({ resourceKind, resourceId, reason, originChannelId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ALREADY_GRANTED")) return { granted: true, message: "" };
    if (!message.includes("ALREADY_PENDING")) throw err;
  }
  return (await board.waitForResourceAccess(`${resourceKind}:${resourceId}`))
    ? { granted: true, message: "" }
    : denied;
}

async function ensureProjectAccess(
  board: BoardClient,
  projectId: string,
  reason: string,
): Promise<AccessWaitResult> {
  const denied: AccessWaitResult = {
    granted: false,
    message: "Project access was denied or not granted in time.",
  };
  try {
    const { request } = await board.requestProjectAccess(projectId, reason);
    if (request.status === "approved") return { granted: true, message: "" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ALREADY_ASSIGNED")) return { granted: true, message: "" };
    if (message.includes("ALREADY_PENDING")) {
      // already pending; wait for the grant
    } else {
      throw err;
    }
  }
  return (await board.waitForResourceAccess(`project:${projectId}`))
    ? { granted: true, message: "" }
    : denied;
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
            ...(Array.isArray(args.constraints) ? { constraints: args.constraints.map(String) } : {}),
            ...(str("assumed_owner_id") ? { assumedOwnerId: str("assumed_owner_id") } : {}),
            ...(str("assumed_project_id") ? { assumedProjectId: str("assumed_project_id") } : {}),
            ...(hooks.channel ? { channel: hooks.channel } : {}),
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
            ...(hooks.channel ? { channel: hooks.channel } : {}),
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
        case "context_manifest": {
          hooks.onActivity("context_manifest");
          const manifest = await board.refreshManifest();
          return { workspace_id: manifest.workspaceId, seq: manifest.seq, resources: manifest.resources };
        }
        case "context_channel_read": {
          const before = typeof args.before === "number" && Number.isFinite(args.before) ? args.before : undefined;
          const channel = await findManifestEntry(board, "channel", str("channel_id"));
          if (!channel) throw new Error("NOT_FOUND: no such channel; check context_manifest");
          hooks.onActivity(`context_channel_read ${channel.id}`);
          if (channel.access === "granted") {
            const messages = await board.readChannel(channel.id, before);
            return { messages };
          }
          const access = await ensureResourceAccess(board, "channel", channel.id, channel.name, "User asked to read messages from this channel.", hooks.channelId);
          if (!access.granted) return { requested: true, status: "pending", message: access.message };
          const messages = await board.readChannel(channel.id, before);
          return { messages };
        }
        case "context_channel_search": {
          const channel = await findManifestEntry(board, "channel", str("channel_id"));
          if (!channel) throw new Error("NOT_FOUND: no such channel; check context_manifest");
          hooks.onActivity(`context_channel_search ${channel.id}`);
          if (channel.access === "granted") {
            const messages = await board.searchChannel(channel.id, str("query"));
            return { messages };
          }
          const access = await ensureResourceAccess(board, "channel", channel.id, channel.name, "User asked to search messages in this channel.", hooks.channelId);
          if (!access.granted) return { requested: true, status: "pending", message: access.message };
          const messages = await board.searchChannel(channel.id, str("query"));
          return { messages };
        }
        case "context_request_access": {
          const resourceKind = str("resource_kind");
          if (!["channel", "git_project", "local_project", "workspace_file"].includes(resourceKind)) {
            return { error: "resource_kind must be channel, git_project, local_project, or workspace_file" };
          }
          let resourceId = str("resource_id");
          let resourceName = resourceId;
          if (resourceKind === "channel") {
            const channel = await findManifestEntry(board, "channel", resourceId);
            if (!channel) throw new Error("NOT_FOUND: no such channel; check context_manifest");
            resourceId = channel.id;
            resourceName = channel.name;
            if (channel.access === "granted") {
              return { granted: true, status: "granted", message: `You already have access to the '${channel.name}' channel.` };
            }
          }
          hooks.onActivity(`context_request_access ${resourceKind}:${resourceId}`);
          const access = await ensureResourceAccess(board, resourceKind as ProtectedResourceKind, resourceId, resourceName, str("reason"), hooks.channelId);
          return access.granted
            ? { granted: true, status: "granted", message: `Access to '${resourceName}' has been approved.` }
            : { requested: true, status: "pending", message: access.message };
        }
        case "context_note_list": {
          hooks.onActivity("context_note_list");
          const notes = await board.listContextNotes();
          return { notes };
        }
        case "context_note_save": {
          hooks.onActivity("context_note_save");
          const note = await board.saveContextNote(str("body"));
          return { saved: true, note_id: note.id };
        }
        case "project_list": {
          hooks.onActivity("project_list");
          const projects = await board.refreshProjectAccess();
          return {
            projects: projects.map(({ project, assignment, request }) => ({
              id: project.id,
              name: project.name,
              kind: project.kind,
              owner: project.createdByName ?? project.createdBy,
              folder_policy: project.accessMode,
              assignment_status: assignment?.status ?? null,
              access_request_pending: Boolean(request),
            })),
          };
        }
        case "project_request_access": {
          const projectId = str("project_id");
          const reason = str("reason");
          hooks.onActivity(`project_request_access ${projectId}`);
          const access = await ensureProjectAccess(board, projectId, reason);
          return access.granted
            ? { granted: true, status: "approved", message: `Access to the project has been approved.` }
            : { requested: true, status: "pending", message: access.message };
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
        case "project_git_status": {
          hooks.onActivity(`${name} ${str("project_id")}`);
          const result = await board.requestAction(
            { kind: "project_git_status", projectId: str("project_id") },
            null,
            hooks.conversationId ?? null,
          );
          return result.ok ? { status: result.output } : { error: result.error };
        }
        case "project_git_fetch":
        case "project_git_pull":
        case "project_git_push":
        case "project_git_branch":
        case "project_git_commit": {
          const ref = str("board_item_ref");
          const item = board.resolve(ref);
          if (item && (item.status === "approved" || item.status === "in_progress")) hooks.onTaskActive(item);
          hooks.onActivity(`${name} ${str("project_id")} (${ref || "no ref"})`);
          const action = name === "project_git_branch"
            ? {
                kind: "project_git_branch" as const,
                projectId: str("project_id"),
                name: str("name"),
                ...(args.start_point ? { startPoint: str("start_point") } : {}),
              }
            : name === "project_git_commit"
              ? { kind: "project_git_commit" as const, projectId: str("project_id"), message: str("message") }
              : name === "project_git_fetch"
                ? { kind: "project_git_fetch" as const, projectId: str("project_id") }
                : name === "project_git_pull"
                  ? { kind: "project_git_pull" as const, projectId: str("project_id") }
                  : { kind: "project_git_push" as const, projectId: str("project_id") };
          const result = await board.requestAction(action, ref || null, hooks.conversationId ?? null);
          if (!result.ok && result.code) {
            hooks.onActivity(`toolman denied ${name}: ${result.code}`);
            return { denied: result.code, error: result.error, note: DENIAL_NOTES[result.code] };
          }
          return result.ok ? { done: result.output } : { error: result.error };
        }
        case "project_write_file":
        case "project_edit_file":
        case "project_delete_file":
        case "project_move_file":
        case "project_run_command": {
          const ref = str("board_item_ref");
          const item = board.resolve(ref);
          if (item && (item.status === "approved" || item.status === "in_progress")) hooks.onTaskActive(item);
          const target = str("path") || str("from") || str("command");
          hooks.onActivity(`${name} ${target} (${ref || "chat grant"})`);
          let action: ProjectAction;
          if (name === "project_run_command") {
            action = { kind: name, projectId: str("project_id"), command: str("command") };
          } else if (name === "project_edit_file") {
            action = {
              kind: name,
              projectId: str("project_id"),
              path: str("path"),
              oldString: str("old_string"),
              newString: str("new_string"),
            };
          } else if (name === "project_delete_file") {
            action = { kind: name, projectId: str("project_id"), path: str("path") };
          } else if (name === "project_move_file") {
            action = { kind: name, projectId: str("project_id"), from: str("from"), to: str("to") };
          } else {
            action = { kind: name, projectId: str("project_id"), path: str("path"), content: str("content") };
          }
          const result = await board.requestAction(
            action,
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
