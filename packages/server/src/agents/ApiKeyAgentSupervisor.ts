import type { AgentInvite } from "@workspace/shared";
import type { runAgent as runAgentType } from "@workspace/agent/runtime";
import { decrypt } from "../crypto/secretBox";
import type { AgentInvites } from "../auth/AgentInvites";

type RunAgent = typeof runAgentType;

/**
 * Runs OpenAI hosted agents (invite has a stored API key) in-process,
 * connecting over the same AgentSocket -> Hub websocket path a CLI-paired
 * agent uses. One instance per workspace, held by WorkspaceRuntime.
 *
 * Minting an installation here skips the pairing-code step entirely — that
 * ceremony exists only so a human can type/paste a short-lived code into a
 * terminal, which doesn't apply when the server is granting itself an
 * installation for a key it already has.
 */
export class ApiKeyAgentSupervisor {
  private connections = new Map<string, { close(): void }>();

  constructor(
    private agentInvites: Pick<AgentInvites, "mintInstallation" | "listOpenAiWithKeys">,
    private workspace: { id: string; name: string },
    private port: number,
    private runAgent: RunAgent,
    private decryptKey: (ciphertext: string) => string = decrypt,
  ) {}

  async start(invite: AgentInvite, apiKey: string): Promise<void> {
    const minted = await this.agentInvites.mintInstallation(invite.id);
    if (!minted) return; // invite was revoked between creation and start
    const apiUrl = `http://127.0.0.1:${this.port}`;
    const connection = await this.runAgent({
      mode: "installation",
      apiKey,
      ownProcess: false,
      installation: {
        installation: minted.installation,
        installationToken: minted.installationToken,
        agent: minted.invite,
        workspace: this.workspace,
        apiUrl,
        wsUrl: `ws://127.0.0.1:${this.port}/ws/${encodeURIComponent(this.workspace.id)}`,
        serverOrigin: apiUrl,
        workspacePath: apiUrl,
        pairedAt: Date.now(),
      },
    });
    this.connections.get(invite.actorId)?.close();
    this.connections.set(invite.actorId, connection);
  }

  stop(actorId: string): void {
    this.connections.get(actorId)?.close();
    this.connections.delete(actorId);
  }

  async syncAll(): Promise<void> {
    const stored = await this.agentInvites.listOpenAiWithKeys();
    for (const { invite, apiKeyCiphertext } of stored) {
      try {
        await this.start(invite, this.decryptKey(apiKeyCiphertext));
      } catch (error) {
        console.warn(`[hosted-agent] could not start ${invite.id}:`, error instanceof Error ? error.message : error);
      }
    }
  }

  closeAll(): void {
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
  }
}
