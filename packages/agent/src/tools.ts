import type {
  AuthzDenyCode,
  ProjectAction,
  ProtectedResourceKind,
  ResourceManifestEntry,
} from "@workspace/shared";
import type { ToolDeclaration, ToolExecutor } from "./brain";
import type { BoardClient } from "./boardClient";

// The board (board_list/board_propose*/board_start/board_complete/board_block) has
// no tool declaration and no executor case — agents have no path to it at all, not
// even a dead one. Every mutating action below always requests a normal human
// chat-grant approval (see Toolman.authorizeMutation's chatGrant branch); nothing
// here can supply a board item ref to route around it. The board's own
// implementation (BoardService, board/api.ts, the Board tab) is untouched — humans
// can still use it — agents just have no tool that references it.
export const TOOL_DECLARATIONS: ToolDeclaration[] = [
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
    description: "Write a file in the shared workspace. Mutating: a human will be asked to approve it.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root" },
        content: { type: "string", description: "Full file content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "append_file",
    description: "Append to a file in the shared workspace. Mutating: a human will be asked to approve it.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root" },
        content: { type: "string", description: "Content to append" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "run_shell",
    description: "Run a shell command in the workspace root (tests, builds, git). Mutating: a human will be asked to approve it.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command line to run via sh -c" },
      },
      required: ["command"],
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
    description:
      "Save one concise persistent note to your own Convyio notebook, scoped to the channel you're in. " +
      "It resurfaces only in this channel, not others — it's about this channel's work, not general knowledge.",
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
    description: "Write a text file in an assigned folder. Mutating: a human will be asked to approve it.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["project_id", "path", "content"],
    },
  },
  {
    name: "project_edit_file",
    description: "Replace one exact string in an assigned folder. Mutating: a human will be asked to approve it.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["project_id", "path", "old_string", "new_string"],
    },
  },
  {
    name: "project_delete_file",
    description: "Delete one file in an assigned folder. Mutating: a human will be asked to approve it.",
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
    name: "project_move_file",
    description: "Move or rename one file in an assigned folder. Mutating: a human will be asked to approve it.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
      },
      required: ["project_id", "from", "to"],
    },
  },
  {
    name: "project_run_command",
    description:
      "Run a non-interactive command in the assigned project checkout. Mutating: a human will be asked to " +
      "approve it. This is not an OS sandbox.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        command: { type: "string" },
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
  {
    name: "project_git_fetch",
    description: "Recompute sync status for an assigned Git project. Mutating: a human will be asked to approve it.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string" } },
      required: ["project_id"],
    },
  },
  {
    name: "project_git_pull",
    description: "Not applicable — reads are always live from GitHub, so there is nothing to pull.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string" } },
      required: ["project_id"],
    },
  },
  {
    name: "project_git_push",
    description:
      "Push queued commits straight to the real branch, bypassing review. Default workflow is project_git_open_pull instead — only push directly if the user explicitly asked you to push. Mutating: a human will be asked to approve it.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string" } },
      required: ["project_id"],
    },
  },
  {
    name: "project_git_branch",
    description:
      "Create and publish a branch in an assigned Git project. Default workflow: make your own branch here before committing, rather than committing straight to the default branch. Mutating: a human will be asked to approve it.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        name: { type: "string" },
        start_point: { type: "string" },
      },
      required: ["project_id", "name"],
    },
  },
  {
    name: "project_git_commit",
    description: "Commit all approved working-tree changes as the current agent. Mutating: a human will be asked to approve it.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        message: { type: "string" },
      },
      required: ["project_id", "message"],
    },
  },
  {
    name: "project_git_open_pull",
    description:
      "Open a pull request from your branch into base (defaults to the project's default branch). This is the default way to land work — prefer it over project_git_push/project_git_merge_pull unless the user explicitly asked you to push or merge directly. Mutating: a human will be asked to approve it.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        head: { type: "string", description: "Your branch (created with project_git_branch)." },
        base: { type: "string", description: "Defaults to the project's default branch." },
      },
      required: ["project_id", "title", "body", "head"],
    },
  },
  {
    name: "project_git_merge_pull",
    description:
      "Merge an existing pull request. Only do this if the user explicitly asked you to merge or resolve conflicts — normally a human merges after review. If GitHub reports a conflict, pull the target branch's current content, resolve it in your branch with project_edit_file, commit, and try again. Mutating: a human will be asked to approve it.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        number: { type: "number" },
      },
      required: ["project_id", "number"],
    },
  },
];

/**
 * What the model should do about each refusal. The denial itself is enforced
 * server-side; this only tells the model how to get unstuck.
 */
const DENIAL_NOTES: Record<AuthzDenyCode, string> = {
  NO_BOARD_REF: "This action is not authorized. Tell the human what you need and wait for their approval.",
  ITEM_NOT_FOUND: "That reference does not exist.",
  ITEM_WRONG_SERVER: "That reference belongs to another workspace.",
  ITEM_NOT_WORKABLE: "That is not workable yet.",
  ITEM_DELETED: "That was deleted. Stop this work and tell the team.",
  SCOPE_VIOLATION: "That path is outside the workspace sandbox. Stay within the workspace root.",
  OWNER_MISMATCH: "That is owned by someone else. Do not work it.",
  PROJECT_REQUIRED: "That action needs a project.",
  PROJECT_MISMATCH: "That action named the wrong project.",
  PROJECT_UNASSIGNED: "You are not assigned to that project.",
  CHECKOUT_UNAVAILABLE: "The assigned folder is not available. The owner's Toolman node may be offline.",
  OWNER_OFFLINE: "The folder owner is offline, so local files are unavailable. Wait until they return.",
  FOLDER_DENIED: "The folder owner has denied local access. Do not retry; ask them to change the folder policy.",
  UNKNOWN_ACTION: "That action is not classified and cannot be authorized.",
  CAPABILITY_MISSING: "That action is not authorized for you. Tell the human what you need and why.",
  PLAN_MODE:
    "The conversation is in plan mode: nothing may change yet. Finish the plan and tell the team what you would do.",
  APPROVAL_DENIED: "A human declined this action. Do not retry it; ask what they would prefer.",
  APPROVAL_UNAVAILABLE:
    "The permission could not be recorded, so nothing ran. Report this and stop — do not retry mutations.",
  HUMAN_ONLY:
    "Only a human can push to the real branch. Use project_git_commit to queue the change, then ask a human to push it.",
};

export interface ToolHooks {
  /** Fired so tool activity shows up in the visible run trace. */
  onActivity(line: string): void;
  /** Conversation the actions belong to; selects the server-side permission mode. */
  conversationId?: string | null;
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
    const num = (key: string): number => Number(args[key] ?? 0);
    try {
      switch (name) {
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
          const notes = await board.listContextNotes(hooks.channelId);
          return { notes };
        }
        case "context_note_save": {
          hooks.onActivity("context_note_save");
          const note = await board.saveContextNote(str("body"), hooks.channelId);
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
          hooks.onActivity(`${name} ${str("project_id")}`);
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
          const result = await board.requestAction(action, null, hooks.conversationId ?? null);
          if (!result.ok && result.code) {
            hooks.onActivity(`toolman denied ${name}: ${result.code}`);
            return { denied: result.code, error: result.error, note: DENIAL_NOTES[result.code] };
          }
          return result.ok ? { done: result.output } : { error: result.error };
        }
        case "project_git_open_pull":
        case "project_git_merge_pull": {
          hooks.onActivity(`${name} ${str("project_id")}`);
          const action = name === "project_git_open_pull"
            ? {
                kind: "project_git_open_pull" as const,
                projectId: str("project_id"),
                title: str("title"),
                body: str("body"),
                head: str("head"),
                ...(args.base ? { base: str("base") } : {}),
              }
            : { kind: "project_git_merge_pull" as const, projectId: str("project_id"), number: num("number") };
          const result = await board.requestAction(action, null, hooks.conversationId ?? null);
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
          const target = str("path") || str("from") || str("command");
          hooks.onActivity(`${name} ${target}`);
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
            null,
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
          const target = name === "run_shell" ? str("command") : str("path");
          hooks.onActivity(`${name} ${target}`);
          const result = await board.requestAction(
            name === "run_shell"
              ? { kind: "run_shell", command: str("command") }
              : { kind: name, path: str("path"), content: str("content") },
            null,
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
