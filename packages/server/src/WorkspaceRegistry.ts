import { createHash } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Auth } from "./auth/Auth";
import type { Sessions } from "./board/sessions";
import type { WorkspaceDb } from "./db";
import type { DemoScript } from "./demo/script";
import type { GitHub } from "./projects/GitHub";
import { WorkspaceRuntime } from "./WorkspaceRuntime";

export class WorkspaceRegistry {
  private runtimes = new Map<string, Promise<WorkspaceRuntime>>();

  constructor(
    private rootDb: WorkspaceDb,
    private sessions: Sessions,
    private auth: Auth | null,
    private agentToken: string | null,
    private supabase: SupabaseClient,
    private github: GitHub,
    private dataDir: string,
    private defaultWorkspaceId: string,
    private demoScripts: Map<string, DemoScript>,
    private demoSeedRoot: string,
  ) {}

  async get(workspaceId: string): Promise<WorkspaceRuntime | null> {
    const existing = this.runtimes.get(workspaceId);
    if (existing) return existing;
    const db = await this.rootDb.scope(workspaceId);
    if (!db) return null;
    const creating = WorkspaceRuntime.create({
      db,
      sessions: this.sessions,
      auth: this.auth,
      agentToken: this.agentToken,
      supabase: this.supabase,
      github: this.github,
      dataDir: this.dataDir,
      demoScripts: workspaceId === this.defaultWorkspaceId ? this.demoScripts : undefined,
      demoSeedRoot: workspaceId === this.defaultWorkspaceId ? this.demoSeedRoot : undefined,
    });
    this.runtimes.set(workspaceId, creating);
    try {
      return await creating;
    } catch (error) {
      this.runtimes.delete(workspaceId);
      throw error;
    }
  }

  async require(workspaceId: string): Promise<WorkspaceRuntime> {
    const runtime = await this.get(workspaceId);
    if (!runtime) throw new Error(`unknown workspace ${workspaceId}`);
    return runtime;
  }

  async addOfflineMember(workspaceId: string, actorId: string): Promise<void> {
    const runtime = this.runtimes.get(workspaceId);
    if (runtime) await (await runtime).hub.addOfflineMember(actorId);
  }

  async workspaceForAgentPairing(pairingCode: string): Promise<WorkspaceRuntime | null> {
    const [row] = await this.rootDb.sql<{ workspace_id: string }[]>`
      SELECT i.workspace_id
      FROM agent_pairings p
      JOIN agent_invites i ON i.id = p.invite_id
      WHERE p.token_hash = ${hashToken(pairingCode)}
    `;
    return row ? this.get(row.workspace_id) : null;
  }

  async workspaceForAgentInstallation(token: string): Promise<WorkspaceRuntime | null> {
    const [row] = await this.rootDb.sql<{ workspace_id: string }[]>`
      SELECT i.workspace_id
      FROM agent_installations installation
      JOIN agent_invites i ON i.id = installation.invite_id
      WHERE installation.token_hash = ${hashToken(token)}
    `;
    return row ? this.get(row.workspace_id) : null;
  }

  async workspaceForToolmanPairing(pairingCode: string): Promise<WorkspaceRuntime | null> {
    const [row] = await this.rootDb.sql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM toolman_pairings
      WHERE token_hash = ${hashToken(pairingCode)}
    `;
    return row ? this.get(row.workspace_id) : null;
  }

  async workspaceForToolmanInstallation(token: string): Promise<WorkspaceRuntime | null> {
    const [row] = await this.rootDb.sql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM toolman_nodes
      WHERE token_hash = ${hashToken(token)}
    `;
    return row ? this.get(row.workspace_id) : null;
  }

  attach(server: HttpServer): void {
    server.on("upgrade", (request, socket, head) => {
      void this.routeUpgrade(request, socket, head).catch(() => socket.destroy());
    });
  }

  async close(): Promise<void> {
    const runtimes = await Promise.all([...this.runtimes.values()]);
    await Promise.all(runtimes.map((runtime) => runtime.close()));
    this.runtimes.clear();
  }

  private async routeUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const parts = pathname.split("/").filter(Boolean);
    let workspaceId: string;
    let target: "hub" | "toolman";
    if (parts.length === 0) {
      workspaceId = this.defaultWorkspaceId;
      target = "hub";
    } else if (parts.length === 1 && parts[0] === "toolman") {
      workspaceId = this.defaultWorkspaceId;
      target = "toolman";
    } else if (parts.length === 2 && (parts[0] === "ws" || parts[0] === "toolman")) {
      workspaceId = decodeURIComponent(parts[1]);
      target = parts[0] === "ws" ? "hub" : "toolman";
    } else {
      socket.destroy();
      return;
    }
    const runtime = await this.get(workspaceId);
    if (!runtime) {
      socket.destroy();
      return;
    }
    if (target === "hub") runtime.hub.handleUpgrade(request, socket, head);
    else runtime.toolmanGateway.handleUpgrade(request, socket, head);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
