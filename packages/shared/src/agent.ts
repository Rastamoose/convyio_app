export type AgentProvider = "claude" | "codex";

export interface AgentInvite {
  id: string;
  actorId: string;
  name: string;
  provider: AgentProvider;
  createdBy: string;
  createdAt: number;
  revokedAt: number | null;
}
