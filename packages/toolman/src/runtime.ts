import { WebSocket } from "ws";
import type { ProjectAction } from "@workspace/shared";
import {
  deleteFile,
  editTextFile,
  listFiles,
  moveFile,
  PathDeniedError,
  readTextFile,
  searchTextFiles,
  writeTextFile,
} from "./fsSafe";
import { runCommand, type RunningCommand } from "./command";
import { installationHealth, type StoredToolman } from "./installation";

interface ExecuteFrame {
  type: "toolman_execute";
  requestId: string;
  action: ProjectAction;
  checkoutKey: string;
  agentId: string;
  projectId: string;
}

const CONNECT_TIMEOUT_MS = 10_000;
const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 10_000;

/**
 * Outbound node session. The local process owns the live folder path and
 * never sends it back; the server only ever sees opaque keys and results.
 */
export async function runNode(installation: StoredToolman, signal?: AbortSignal): Promise<void> {
  const socketUrl = new URL(installation.wsUrl);
  if (socketUrl.pathname === "/") socketUrl.pathname = "/toolman";
  let retryMs = INITIAL_RETRY_MS;
  while (!signal?.aborted) {
    const connected = await runSession(socketUrl, installation, signal);
    if (signal?.aborted) return;
    if (!connected && await installationHealth(installation) === "revoked") {
      throw new Error(
        `Toolman node ${installation.node.name} was revoked. Create a new pairing for the same device name in Resources, then run the pair command again.`,
      );
    }
    const delayMs = connected ? INITIAL_RETRY_MS : retryMs;
    retryMs = connected ? INITIAL_RETRY_MS : Math.min(retryMs * 2, MAX_RETRY_MS);
    await waitForRetry(delayMs, signal);
  }
}

async function runSession(socketUrl: URL, installation: StoredToolman, signal?: AbortSignal): Promise<boolean> {
  const socket = new WebSocket(socketUrl);
  const inflight = new Map<string, RunningCommand>();
  let authenticated = false;

  // Without this, the function returns right after sending `hello` and the
  // CLI's `process.exit()` kills the process before any messages arrive.
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const connectTimer = setTimeout(() => socket.terminate(), CONNECT_TIMEOUT_MS);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      signal?.removeEventListener("abort", stop);
      for (const running of inflight.values()) running.cancel();
      inflight.clear();
      resolve(authenticated);
    };
    const stop = () => {
      socket.terminate();
      finish();
    };

    socket.once("open", () => {
      clearTimeout(connectTimer);
      socket.send(JSON.stringify({ type: "toolman_hello", token: installation.installationToken }));
    });
    socket.on("message", (raw) => {
      void handleFrame(socket, installation, inflight, raw.toString(), () => {
        authenticated = true;
      }).catch((err) => {
        console.warn("[toolman] execute failed:", err instanceof Error ? err.message : err);
      });
    });
    socket.once("close", finish);
    socket.on("error", () => {
      socket.terminate();
      finish();
    });
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
  });
}

async function handleFrame(
  socket: WebSocket,
  installation: StoredToolman,
  inflight: Map<string, RunningCommand>,
  raw: string,
  onWelcome: () => void,
): Promise<void> {
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch (error) {
    console.warn(
      "[toolman] ignoring malformed frame:",
      error instanceof Error ? error.message : error,
      JSON.stringify(raw.slice(0, 200)),
    );
    return;
  }
  if (!isRecord(event)) return;
  if (event.type === "toolman_welcome") {
    onWelcome();
    return;
  }
  if (event.type === "toolman_assignment_sync") return;
  if (event.type === "toolman_cancel" && typeof event.requestId === "string") {
    inflight.get(event.requestId)?.cancel();
    return;
  }
  if (event.type !== "toolman_execute") return;
  if (!isExecuteFrame(event)) {
    if (typeof event.requestId === "string") sendResult(socket, event.requestId, { ok: false, error: "invalid execution frame" });
    return;
  }
  const mount = installation.mounts.find((item) => item.projectId === event.projectId);
  if (!mount) {
    sendResult(socket, event.requestId, { ok: false, error: "this node does not mount that project" });
    return;
  }
  const result = await runAction(mount.absolutePath, event.action, (running) => {
    inflight.set(event.requestId, running);
  });
  inflight.delete(event.requestId);
  sendResult(socket, event.requestId, result);
}

function isExecuteFrame(event: Record<string, unknown>): event is Record<string, unknown> & ExecuteFrame {
  return (
    typeof event.requestId === "string" &&
    typeof event.projectId === "string" &&
    isRecord(event.action) &&
    typeof event.action.kind === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendResult(
  socket: WebSocket,
  requestId: string,
  result: { ok: boolean; output?: string; error?: string },
): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "toolman_execution_result", requestId, ...result }));
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
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
        const matches = await searchTextFiles(root, action.query, action.path ?? ".");
        return { ok: true, output: matches.join("\n") || "(no matches)" };
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
      case "project_git_status":
        return runGit(root, "status --short --branch", track);
      case "project_git_fetch":
        return runGit(root, "fetch --prune origin", track);
      case "project_git_pull":
        return runGit(root, "pull --ff-only", track);
      case "project_git_push":
        return runGit(root, "push", track);
      case "project_git_branch":
        return runGit(
          root,
          `switch -c ${shellQuote(action.name)}${action.startPoint ? ` ${shellQuote(action.startPoint)}` : ""}`,
          track,
        );
      case "project_git_commit":
        return runGit(
          root,
          `-c core.hooksPath=/dev/null add -A && git -c core.hooksPath=/dev/null commit -m ${shellQuote(action.message)}`,
          track,
        );
      default:
        return { ok: false, error: "unsupported project action" };
    }
  } catch (err) {
    return { ok: false, error: err instanceof PathDeniedError || err instanceof Error ? err.message : String(err) };
  }
}

async function runGit(
  root: string,
  command: string,
  track: (running: RunningCommand) => void,
): Promise<{ ok: boolean; output?: string; error?: string }> {
  const running = runCommand(root, `git ${command}`);
  track(running);
  const result = await running.promise;
  if (result.cancelled) return { ok: false, error: "cancelled", output: result.output };
  if (result.timedOut) return { ok: false, error: "command timed out", output: result.output };
  return result.exitCode === 0
    ? { ok: true, output: result.output || "(no output)" }
    : { ok: false, error: `exit ${result.exitCode ?? "?"}`, output: result.output };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
