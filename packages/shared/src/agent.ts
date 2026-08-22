import type { AgentRuntimeSummary, WorkspaceInfo } from "./protocol";

export type AgentProvider = "claude" | "codex" | "openai";
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

/** A listed agent: its profile plus the runner's live connection/health state
 *  (GET /api/agents adds this; it isn't stored, only computed per request). */
export interface AgentSummary extends AgentInvite {
  runtime: AgentRuntimeSummary;
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
