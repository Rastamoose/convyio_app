import type { WorkspaceInfo } from "./protocol";

export type AgentProvider = "claude" | "codex";
export type AgentAccessMode = "workspace" | "creator" | "selected";

export interface AgentAccessPolicy {
  mode: AgentAccessMode;
  selectedActorIds: string[];
}

export interface AgentInvite {
  id: string;
  workspaceId: string;
  actorId: string;
  name: string;
  provider: AgentProvider;
  instructions: string;
  requestedModel: string | null;
  access: AgentAccessPolicy;
  configRevision: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
}

export interface AgentPairing {
  id: string;
  agentId: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  revokedAt: number | null;
}

export interface AgentPairingResponse {
  pairing: AgentPairing;
  pairingCode: string;
}

export interface AgentInstallation {
  id: string;
  agentId: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface AgentPairingExchangeResponse {
  installation: AgentInstallation;
  installationToken: string;
  agent: AgentInvite;
  workspace: WorkspaceInfo;
  apiUrl: string;
  wsUrl: string;
}
