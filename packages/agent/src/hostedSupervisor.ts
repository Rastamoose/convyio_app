import path from "node:path";
import { runAgent } from "./runtime";
import type { HostedUsageLimiter } from "./hostedLimiter";

export interface HostedWorkspace {
  id: string;
  name: string;
  actorId: string;
  wsUrl: string;
}

export interface HostedSupervisorOptions {
  apiUrl: string;
  token: string;
  name: string;
  provider: "gemini" | "claude";
  model?: string;
  geminiApiKey?: string;
  workspace: string;
  dataDir: string;
  charter: string;
  limiter: HostedUsageLimiter;
  pollMs?: number;
  fetchWorkspaces?: () => Promise<HostedWorkspace[]>;
}

export class HostedSupervisor {
  private connections = new Map<string, { close(): void }>();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private options: HostedSupervisorOptions) {}

  start(): void {
    void this.sync();
    this.timer = setInterval(() => void this.sync(), this.options.pollMs ?? 15_000);
    this.timer.unref?.();
  }

  async sync(): Promise<void> {
    if (this.closed) return;
    let workspaces: HostedWorkspace[];
    try {
      workspaces = await (this.options.fetchWorkspaces ?? (() => fetchHostedWorkspaces(this.options)))();
    } catch (error) {
      console.warn("[hosted] could not list workspaces:", error instanceof Error ? error.message : error);
      return;
    }
    const live = new Set(workspaces.map((workspace) => workspace.id));
    for (const [id, connection] of this.connections) {
      if (live.has(id)) continue;
      connection.close();
      this.connections.delete(id);
    }
    for (const workspace of workspaces) {
      if (this.connections.has(workspace.id) || this.closed) continue;
      const connection = await runAgent({
        mode: "legacy",
        name: this.options.name,
        wsUrl: workspace.wsUrl,
        token: this.options.token,
        provider: this.options.provider,
        model: this.options.model,
        geminiApiKey: this.options.geminiApiKey,
        workspace: this.options.workspace,
        dataDir: path.join(this.options.dataDir, workspace.id),
        charter: this.options.charter,
        limiter: this.options.limiter,
        ownProcess: false,
      });
      if (this.closed) {
        connection.close();
        return;
      }
      this.connections.set(workspace.id, connection);
    }
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
  }
}

export function httpUrlFromWs(wsUrl: string): string {
  return wsUrl.replace(/^ws/i, "http");
}

async function fetchHostedWorkspaces(options: HostedSupervisorOptions): Promise<HostedWorkspace[]> {
  const response = await fetch(`${options.apiUrl.replace(/\/$/, "")}/api/hosted-agent/workspaces`, {
    headers: { Authorization: `Bearer ${options.token}` },
  });
  if (!response.ok) {
    throw new Error(`hosted workspace list returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as { workspaces: HostedWorkspace[] };
  return body.workspaces;
}
