import fs from "node:fs/promises";
import path from "node:path";
import {
  WORKABLE_STATUSES,
  type Actor,
  type AuthzDenyCode,
  type AuthzResult,
  type ToolmanAction,
} from "@workspace/shared";
import type { BoardService } from "./BoardService";
import { scopeAllows } from "./scope";

export interface ToolmanResult {
  ok: boolean;
  code?: AuthzDenyCode;
  error?: string;
  output?: string;
}

/**
 * Tools that never change the world. Anything not listed here — including
 * tools that do not exist yet — is treated as mutating (fail closed).
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read_file", "list_files"]);

export function isMutating(toolName: string): boolean {
  return !READ_ONLY_TOOLS.has(toolName);
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
  action: { name: string; path?: string },
  board: BoardService,
): Promise<AuthzResult> {
  const mutating = isMutating(action.name);
  if (actor.kind === "human" || !mutating) {
    return { allow: true, item: undefined as never };
  }
  if (!boardItemRef) {
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
  if (item.scopePaths) {
    if (!action.path || !scopeAllows(item.scopePaths, action.path)) {
      return {
        allow: false,
        code: "SCOPE_VIOLATION",
        message: `${action.path ?? "(no path)"} is outside ${item.ref}'s scope (${item.scopePaths.join(", ")})`,
      };
    }
  } else if (item.origin === "agent") {
    // Agent proposals always carry scope (enforced at creation); an
    // agent-origin item without one fails closed rather than granting
    // unrestricted access.
    return {
      allow: false,
      code: "SCOPE_VIOLATION",
      message: `${item.ref} declares no scope_paths; agent items cannot authorize unscoped work`,
    };
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

  async execute(
    actor: Actor,
    action: ToolmanAction,
    boardItemRef: string | null,
  ): Promise<ToolmanResult> {
    const authz = await authorizeMutation(
      actor,
      boardItemRef,
      { name: action.kind, path: "path" in action ? action.path : undefined },
      this.board,
    );
    if (!authz.allow) {
      // Every denial is an audit record.
      console.warn(
        `[toolman] DENY ${actor.displayName} ${action.kind} ref=${boardItemRef ?? "-"} → ${authz.code}: ${authz.message}`,
      );
      return { ok: false, code: authz.code, error: authz.message };
    }

    const target = this.sandboxed("path" in action ? (action.path ?? ".") : ".");
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
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, error: detail };
    }
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
