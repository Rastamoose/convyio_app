import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ACTION_CAPABILITY,
  DEFAULT_CAPABILITIES,
  WORKABLE_STATUSES,
  type Actor,
  type AuthzDenyCode,
  type AuthzResult,
  type ToolmanAction,
} from "@workspace/shared";
import type { BoardService } from "./BoardService";
import { normalizeWorkspacePath, scopeAllows } from "./scope";

export interface ToolmanResult {
  ok: boolean;
  code?: AuthzDenyCode;
  error?: string;
  output?: string;
  executionId?: string;
}

/**
 * Tools that never change the world. Anything not listed here — including
 * tools that do not exist yet — is treated as mutating (fail closed).
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_files",
  "search_files",
  "project_read_file",
  "project_list_files",
  "project_search_files",
  "project_git_status",
]);

export function isMutating(toolName: string): boolean {
  return !READ_ONLY_TOOLS.has(toolName);
}

const SHELL_TIMEOUT_MS = 120_000;
const SHELL_MAX_OUTPUT = 256 * 1024;
/** Transport and model context both need a ceiling on tool output. */
const OUTPUT_CLIP = 16_000;

function clip(text: string): string {
  return text.length <= OUTPUT_CLIP
    ? text
    : `${text.slice(0, OUTPUT_CLIP)}\n…[${text.length - OUTPUT_CLIP} more characters truncated]`;
}

/**
 * Single authorization decision for agent actions. Kept as a pure function —
 * separate from the filesystem mechanics in Toolman — so the policy can be
 * unit-tested without touching disk. Humans are not gated by the board;
 * agent mutations require a workable item whose scope covers the target path.
 */
export async function authorizeMutation(
  actor: Actor,
  boardItemRef: string | null,
  action: { name: string; path?: string; projectId?: string; extraPaths?: string[] },
  board: BoardService,
  options: { chatGrant?: boolean } = {},
): Promise<AuthzResult> {
  const mutating = isMutating(action.name);
  if (actor.kind === "human" || !mutating) {
    return { allow: true, item: undefined };
  }
  if (action.name.startsWith("project_") && !action.projectId) {
    return { allow: false, code: "PROJECT_REQUIRED", message: `${action.name} requires a project` };
  }
  if (!boardItemRef) {
    if (options.chatGrant) {
      const required = ACTION_CAPABILITY[action.name];
      if (!required) {
        return {
          allow: false,
          code: "UNKNOWN_ACTION",
          message: `${action.name} is not a classified capability and cannot be authorized`,
        };
      }
      if (action.path && normalizeWorkspacePath(action.path) === null) {
        return {
          allow: false,
          code: "SCOPE_VIOLATION",
          message: `${action.path} is outside the workspace sandbox`,
        };
      }
      return { allow: true };
    }
    return {
      allow: false,
      code: "NO_BOARD_REF",
      message: "mutating actions require a board_item_ref for an approved board item",
    };
  }
  const item = await board.findAnywhere(boardItemRef);
  if (!item) {
    return { allow: false, code: "ITEM_NOT_FOUND", message: `no board item ${boardItemRef}` };
  }
  if (item.workspaceId !== actor.workspaceId) {
    return { allow: false, code: "ITEM_WRONG_SERVER", message: `${boardItemRef} belongs to another server` };
  }
  if (item.deletedAt) {
    return { allow: false, code: "ITEM_DELETED", message: `${item.ref} was deleted; halt this work` };
  }
  if (!WORKABLE_STATUSES.has(item.status)) {
    return {
      allow: false,
      code: "ITEM_NOT_WORKABLE",
      message: `${item.ref} is ${item.status}; mutating work requires approved or in_progress`,
    };
  }
  if (!item.owner || item.owner !== actor.id) {
    return {
      allow: false,
      code: "OWNER_MISMATCH",
      message: `${item.ref} is owned by someone else`,
    };
  }
  if (action.projectId) {
    if (!item.projectId) {
      return {
        allow: false,
        code: "PROJECT_REQUIRED",
        message: `${item.ref} is not bound to a project`,
      };
    }
    if (item.projectId !== action.projectId) {
      return {
        allow: false,
        code: "PROJECT_MISMATCH",
        message: `${item.ref} authorizes ${item.projectId}, not ${action.projectId}`,
      };
    }
  }
  // The item must grant this class of action. An unclassified tool has no
  // capability and can never be granted one, so new tools fail closed.
  const required = ACTION_CAPABILITY[action.name];
  const granted = item.capabilities ?? DEFAULT_CAPABILITIES;
  if (!required || !granted.includes(required)) {
    return {
      allow: false,
      code: "CAPABILITY_MISSING",
      message: required
        ? `${item.ref} does not grant ${required} (grants: ${granted.join(", ")})`
        : `${action.name} is not a classified capability and cannot be authorized`,
    };
  }
  if (!item.scopePaths && item.origin === "agent") {
    // Agent proposals always carry scope (enforced at creation); an
    // agent-origin item without one fails closed rather than granting
    // unrestricted access.
    return {
      allow: false,
      code: "SCOPE_VIOLATION",
      message: `${item.ref} declares no scope_paths; agent items cannot authorize unscoped work`,
    };
  }
  // Path scope binds file actions. A shell command's writes are not statically
  // knowable, so shell_repo is bounded by the sandbox root instead — that
  // coarseness is why it is a separate capability a human must grant.
  if (required !== "shell_repo" && item.scopePaths) {
    const paths = [action.path, ...(action.extraPaths ?? [])].filter((value): value is string => Boolean(value));
    const blocked = paths.find((candidate) => !scopeAllows(item.scopePaths!, candidate));
    if (!action.path || blocked) {
      return {
        allow: false,
        code: "SCOPE_VIOLATION",
        message: `${blocked ?? action.path ?? "(no path)"} is outside ${item.ref}'s scope (${item.scopePaths.join(", ")})`,
      };
    }
  }
  return { allow: true, item };
}

/**
 * The enforcement point. All agent actions on the world flow through here;
 * authorization is architectural, not prompted. Actions are confined to a
 * sandboxed workspace directory.
 */
export class Toolman {
  constructor(
    private board: BoardService,
    private workspaceRoot: string,
  ) {}

  async init(): Promise<void> {
    await fs.mkdir(this.workspaceRoot, { recursive: true });
  }

  /**
   * Layer 1 on its own: does the board authorize this at all? Exposed so the
   * hub can settle the hard ceiling before asking a human to approve something
   * the board would refuse anyway. `execute` re-checks, so this is an early
   * answer rather than a substitute for enforcement.
   */
  authorize(
    actor: Actor,
    action: ToolmanAction,
    boardItemRef: string | null,
    options: { chatGrant?: boolean } = {},
  ): Promise<AuthzResult> {
    return authorizeMutation(
      actor,
      boardItemRef,
      {
        name: action.kind,
        path: "path" in action ? action.path : "from" in action ? action.from : undefined,
        extraPaths: "to" in action ? [action.to] : undefined,
        projectId: "projectId" in action ? action.projectId : undefined,
      },
      this.board,
      options,
    );
  }

  async execute(
    actor: Actor,
    action: ToolmanAction,
    boardItemRef: string | null,
    options: { chatGrant?: boolean } = {},
  ): Promise<ToolmanResult> {
    const authz = await this.authorize(actor, action, boardItemRef, options);
    if (!authz.allow) {
      // Every denial is an audit record.
      console.warn(
        `[toolman] DENY ${actor.displayName} ${action.kind} ref=${boardItemRef ?? "-"} → ${authz.code}: ${authz.message}`,
      );
      return { ok: false, code: authz.code, error: authz.message };
    }

    if (action.kind.startsWith("project_")) {
      return {
        ok: false,
        code: "CHECKOUT_UNAVAILABLE",
        error: "project actions require a paired Toolman node",
      };
    }
    const target = this.sandboxed(
      "path" in action ? (action.path ?? ".") : "from" in action ? action.from : ".",
    );
    if (target === null) {
      console.warn(`[toolman] DENY ${actor.displayName} ${action.kind}: path escapes the workspace sandbox`);
      return { ok: false, error: "path escapes the workspace sandbox" };
    }

    try {
      switch (action.kind) {
        case "read_file": {
          const content = await fs.readFile(target, "utf-8");
          return { ok: true, output: content };
        }
        case "list_files": {
          const entries = await fs.readdir(target, { withFileTypes: true });
          const listing = entries
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .sort()
            .join("\n");
          return { ok: true, output: listing || "(empty)" };
        }
        case "write_file": {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, action.content);
          return { ok: true, output: `wrote ${action.content.length} bytes to ${action.path}` };
        }
        case "append_file": {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.appendFile(target, action.content);
          return { ok: true, output: `appended ${action.content.length} bytes to ${action.path}` };
        }
        case "run_shell":
          return await this.runShell(action.command);
        case "search_files": {
          // argv, never a shell string: the query is a search pattern and can
          // never become syntax. grep's exit 1 means "no matches", which is an
          // answer rather than a failure.
          const result = await this.spawn("grep", [
            "-rIn",
            "--exclude-dir=node_modules",
            "--exclude-dir=.git",
            "-m",
            "100",
            "-e",
            action.query,
            "--",
            target,
          ]);
          return result.ok ? result : { ok: true, output: result.output || "(no matches)" };
        }
        default:
          return {
            ok: false,
            code: "UNKNOWN_ACTION",
            error: `${action.kind} is not classified and cannot be authorized`,
          };
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, error: detail };
    }
  }

  /**
   * Runs a command in the sandbox root. The child gets a minimal environment —
   * the parent's process.env holds agent tokens, provider keys and the database
   * URL, none of which a tool may read or leak into its output.
   */
  private runShell(command: string): Promise<ToolmanResult> {
    return this.spawn("/bin/sh", ["-c", command]);
  }

  /**
   * Runs one program with an argument vector. Nothing is parsed as shell
   * syntax, so caller-supplied values cannot become commands.
   */
  private spawn(file: string, args: string[]): Promise<ToolmanResult> {
    return new Promise((resolve) => {
      execFile(
        file,
        args,
        {
          cwd: this.workspaceRoot,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: this.workspaceRoot, LANG: "C" },
          timeout: SHELL_TIMEOUT_MS,
          maxBuffer: SHELL_MAX_OUTPUT,
          killSignal: "SIGKILL",
        },
        (err, stdout, stderr) => {
          const output = clip(`${stdout}${stderr ? `\n${stderr}` : ""}`);
          if (err) {
            const timedOut = "killed" in err && err.killed;
            resolve({
              ok: false,
              error: timedOut ? `command timed out after ${SHELL_TIMEOUT_MS}ms` : err.message,
              output,
            });
            return;
          }
          resolve({ ok: true, output: output || "(no output)" });
        },
      );
    });
  }

  /** Resolve a path inside the workspace root, or null if it escapes. */
  private sandboxed(relative: string): string | null {
    const resolved = path.resolve(this.workspaceRoot, relative);
    if (resolved !== this.workspaceRoot && !resolved.startsWith(this.workspaceRoot + path.sep)) {
      return null;
    }
    return resolved;
  }
}
