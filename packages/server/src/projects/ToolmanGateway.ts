import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { ProjectAction, ProjectAssignment, ToolmanNodeSummary } from "@workspace/shared";
import type { ToolmanResult } from "../board/Toolman";
import type { ProjectStore } from "./ProjectStore";
import type { ToolmanNodes } from "./ToolmanNodes";

const EXECUTION_TIMEOUT_MS = 130_000;

interface NodeConnection {
  socket: WebSocket;
  node: ToolmanNodeSummary;
}

interface PendingExecution {
  resolve: (result: ToolmanResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Machine-level Toolman socket. Participant Hub traffic stays on `/`;
 * nodes authenticate here with their installation token and receive only
 * the executions the server has already authorized.
 */
export class ToolmanGateway {
  private wss: WebSocketServer;
  private nodes = new Map<string, NodeConnection>();
  private pending = new Map<string, PendingExecution>();

  constructor(
    server: HttpServer,
    private nodesStore: ToolmanNodes,
    private projects: ProjectStore,
  ) {
    this.wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      const pathname = (req.url ?? "/").split("?")[0];
      if (pathname !== "/toolman") return;
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req);
      });
    });
    this.wss.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EADDRINUSE") console.warn("[toolman] websocket error:", err.message);
    });
    this.wss.on("connection", (socket, request) => this.onConnection(socket, request));
  }

  findMount(mountId: string) {
    return this.nodesStore.findMountById(mountId);
  }

  isOnline(nodeId: string): boolean {
    const conn = this.nodes.get(nodeId);
    return Boolean(conn && conn.socket.readyState === WebSocket.OPEN);
  }

  async execute(assignment: ProjectAssignment, action: ProjectAction): Promise<ToolmanResult> {
    const mount = await this.nodesStore.findMountById(assignment.mountId);
    if (!mount) {
      return { ok: false, code: "CHECKOUT_UNAVAILABLE", error: "the assigned project mount is gone" };
    }
    const conn = this.nodes.get(mount.nodeId);
    if (!conn || conn.socket.readyState !== WebSocket.OPEN) {
      return { ok: false, code: "CHECKOUT_UNAVAILABLE", error: "the assigned Toolman node is offline" };
    }
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, error: "Toolman node timed out" });
      }, EXECUTION_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, timer });
      conn.socket.send(
        JSON.stringify({
          type: "toolman_execute",
          requestId,
          action,
          checkoutKey: assignment.checkoutKey,
          agentId: assignment.agentId,
          projectId: assignment.projectId,
        }),
      );
    });
  }

  cancel(requestId: string): void {
    for (const conn of this.nodes.values()) {
      if (conn.socket.readyState === WebSocket.OPEN) {
        conn.socket.send(JSON.stringify({ type: "toolman_cancel", requestId }));
      }
    }
  }

  private onConnection(socket: WebSocket, _request: IncomingMessage): void {
    let nodeId: string | null = null;
    socket.on("message", (raw) => {
      void this.onMessage(socket, raw.toString(), (id) => {
        nodeId = id;
      }).catch((err) => {
        console.warn("[toolman] node frame failed:", err instanceof Error ? err.message : err);
      });
    });
    socket.on("close", () => {
      if (!nodeId) return;
      const current = this.nodes.get(nodeId);
      if (current?.socket === socket) this.nodes.delete(nodeId);
    });
  }

  private async onMessage(
    socket: WebSocket,
    raw: string,
    bind: (nodeId: string) => void,
  ): Promise<void> {
    let event: { type?: string; token?: string; requestId?: string; ok?: boolean; output?: string; error?: string; exitCode?: number | null };
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      socket.close();
      return;
    }
    if (event.type === "toolman_hello") {
      if (!event.token) {
        socket.close();
        return;
      }
      const resolved = await this.nodesStore.resolveInstallation(event.token);
      if (!resolved) {
        socket.close();
        return;
      }
      bind(resolved.node.id);
      this.nodes.set(resolved.node.id, { socket, node: resolved.node });
      socket.send(JSON.stringify({ type: "toolman_welcome", node: resolved.node }));
      const assignments = await this.projectsForNode(resolved.node.id);
      socket.send(JSON.stringify({ type: "toolman_assignment_sync", assignments }));
      return;
    }
    if (event.type === "toolman_execution_result" && event.requestId) {
      const waiter = this.pending.get(event.requestId);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(event.requestId);
      waiter.resolve({
        ok: Boolean(event.ok),
        output: event.output,
        error: event.error,
      });
    }
  }

  private async projectsForNode(nodeId: string): Promise<ProjectAssignment[]> {
    const mounts = await this.nodesStore.mountsForNode(nodeId);
    const assignments: ProjectAssignment[] = [];
    for (const mount of mounts) {
      assignments.push(...(await this.projects.listAssignments(mount.projectId)).filter((row) => row.mountId === mount.id));
    }
    return assignments;
  }
}
