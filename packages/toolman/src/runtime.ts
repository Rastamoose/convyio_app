import { WebSocket } from "ws";
import type { ProjectAction, ProjectAssignment } from "@workspace/shared";
import { deleteFile, editTextFile, listFiles, moveFile, PathDeniedError, readTextFile, writeTextFile } from "./fsSafe";
import { runCommand, type RunningCommand } from "./command";
import type { StoredToolman } from "./installation";
import { ensureWorktree } from "./projects";

interface ExecuteFrame {
  type: "toolman_execute";
  requestId: string;
  action: ProjectAction;
  checkoutKey: string;
  agentId: string;
  projectId: string;
}

/**
 * Outbound node session. The local process owns checkout paths and never
 * sends them back; the server only ever sees opaque keys and results.
 */
export async function runNode(installation: StoredToolman): Promise<void> {
  const socketUrl = new URL(installation.wsUrl);
  if (socketUrl.pathname === "/") socketUrl.pathname = "/toolman";
  const socket = new WebSocket(socketUrl);
  const inflight = new Map<string, RunningCommand>();
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "toolman_hello", token: installation.installationToken }));

  socket.on("message", (raw) => {
    void handle(JSON.parse(raw.toString()) as Record<string, unknown>).catch((err) => {
      console.warn("[toolman] execute failed:", err instanceof Error ? err.message : err);
    });
  });

  async function handle(event: Record<string, unknown>): Promise<void> {
    if (event.type === "toolman_assignment_sync") {
      const assignments = Array.isArray(event.assignments) ? event.assignments as Array<{ projectId: string; agentId: string; agentName?: string }> : [];
      for (const assignment of assignments) {
        const mount = installation.mounts.find((item) => item.projectId === assignment.projectId);
        if (!mount) continue;
        await ensureWorktree(installation, mount, assignment.agentId, assignment.agentName ?? assignment.agentId).catch((err) => {
          console.warn("[toolman] worktree reconcile failed:", err instanceof Error ? err.message : err);
        });
      }
      return;
    }
    if (event.type === "toolman_cancel" && typeof event.requestId === "string") {
      inflight.get(event.requestId)?.cancel();
      return;
    }
    if (event.type !== "toolman_execute") return;
    const frame = event as unknown as ExecuteFrame;
    const mount = installation.mounts.find((item) => item.projectId === frame.projectId);
    if (!mount) {
      socket.send(JSON.stringify({ type: "toolman_execution_result", requestId: frame.requestId, ok: false, error: "this node does not mount that project" }));
      return;
    }
    const assignment = {
      projectId: frame.projectId,
      agentId: frame.agentId,
      checkoutKey: frame.checkoutKey,
    } as Pick<ProjectAssignment, "projectId" | "agentId" | "checkoutKey">;
    const checkout = await ensureWorktree(installation, mount, assignment.agentId, assignment.agentId);
    const result = await runAction(checkout.checkoutPath, frame.action, (running) => {
      inflight.set(frame.requestId, running);
    });
    inflight.delete(frame.requestId);
    socket.send(JSON.stringify({ type: "toolman_execution_result", requestId: frame.requestId, ...result }));
  }
}

async function runAction(
  root: string,
  action: ProjectAction,
  track: (running: RunningCommand) => void,
): Promise<{ ok: boolean; output?: string; error?: string }> {
  try {
    switch (action.kind) {
      case "project_read_file":
        return { ok: true, output: await readTextFile(root, action.path) };
      case "project_list_files":
        return { ok: true, output: (await listFiles(root, action.path ?? ".")).join("\n") || "(empty)" };
      case "project_search_files": {
        const running = runCommand(
          root,
          `grep -rIn --exclude-dir=node_modules --exclude-dir=.git -m 100 -e ${shellQuote(action.query)} -- ${shellQuote(action.path ?? ".")}`,
        );
        track(running);
        const result = await running.promise;
        return { ok: true, output: result.output || "(no matches)" };
      }
      case "project_write_file":
        await writeTextFile(root, action.path, action.content);
        return { ok: true, output: `wrote ${action.content.length} bytes to ${action.path}` };
      case "project_edit_file":
        await editTextFile(root, action.path, action.oldString, action.newString);
        return { ok: true, output: `edited ${action.path}` };
      case "project_delete_file":
        await deleteFile(root, action.path);
        return { ok: true, output: `deleted ${action.path}` };
      case "project_move_file":
        await moveFile(root, action.from, action.to);
        return { ok: true, output: `moved ${action.from} → ${action.to}` };
      case "project_run_command": {
        const running = runCommand(root, action.command);
        track(running);
        const result = await running.promise;
        if (result.cancelled) return { ok: false, error: "cancelled", output: result.output };
        if (result.timedOut) return { ok: false, error: "command timed out", output: result.output };
        return result.exitCode === 0
          ? { ok: true, output: result.output }
          : { ok: false, error: `exit ${result.exitCode ?? "?"}`, output: result.output };
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof PathDeniedError || err instanceof Error ? err.message : String(err) };
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
