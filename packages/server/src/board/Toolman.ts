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

export interface ToolmanResult {
  ok: boolean;
  code?: AuthzDenyCode;
  error?: string;
  output?: string;
}

/**
 * Tool registry. Each tool declares whether it mutates the world; anything
 * not registered — or registered without the flag — is treated as mutating
 * (fail closed).
 */
const TOOL_REGISTRY: Record<string, { mutating: boolean }> = {
  read_file: { mutating: false },
  list_files: { mutating: false },
  write_file: { mutating: true },
  append_file: { mutating: true },
};

export function isMutating(toolName: string): boolean {
  return TOOL_REGISTRY[toolName]?.mutating ?? true;
}

/**
 * Single authorization entry point for the toolman (§5). Humans are not
 * gated by the board; agent mutations require a workable item.
 */
export function authorizeMutation(
  actor: Actor,
  boardItemRef: string | null,
  action: { name: string },
  board: BoardService,
): AuthzResult {
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
  const item = board.findAnywhere(boardItemRef);
  if (!item) {
    return { allow: false, code: "ITEM_NOT_FOUND", message: `no board item ${boardItemRef}` };
  }
  if (item.serverId !== actor.serverId) {
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
    const authz = authorizeMutation(actor, boardItemRef, { name: action.kind }, this.board);
    if (!authz.allow) {
      // Every denial is an audit record.
      console.warn(
        `[toolman] DENY ${actor.displayName} ${action.kind} ref=${boardItemRef ?? "-"} → ${authz.code}: ${authz.message}`,
      );
      return { ok: false, code: authz.code, error: authz.message };
    }

    let target: string;
    try {
      target = this.sandboxed("path" in action ? (action.path ?? ".") : ".");
    } catch {
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

  private sandboxed(relative: string): string {
    const resolved = path.resolve(this.workspaceRoot, relative);
    if (resolved !== this.workspaceRoot && !resolved.startsWith(this.workspaceRoot + path.sep)) {
      throw new Error("outside sandbox");
    }
    return resolved;
  }
}
