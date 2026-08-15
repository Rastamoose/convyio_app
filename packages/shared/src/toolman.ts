import type { WorkCapability } from "./board";
import type { CheckoutStatus, MountCleanliness, ProjectKind } from "./project";

export const TOOLMAN_PROTOCOL_VERSION = 1;
export const DEFAULT_ARTIFACT_RETENTION_DAYS = 30;
export const MAX_FILE_BYTES = 1_048_576;
export const MAX_COMMAND_OUTPUT_BYTES = 10_485_760;
export const LIVE_OUTPUT_PREVIEW_BYTES = 262_144;

export type ToolmanNodeHealth = "checking" | "ready" | "offline" | "revoked";

export type ToolExecutionStatus =
  | "requested"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "failed"
  | "denied"
  | "cancelled";

export type ToolmanActionKind =
  | "project_read_file"
  | "project_list_files"
  | "project_search_files"
  | "project_write_file"
  | "project_edit_file"
  | "project_delete_file"
  | "project_move_file"
  | "project_run_command";

export const TOOLMAN_READ_ACTIONS: readonly ToolmanActionKind[] = [
  "project_read_file",
  "project_list_files",
  "project_search_files",
];

export const TOOLMAN_ACTION_CAPABILITY: Readonly<Partial<Record<ToolmanActionKind, WorkCapability>>> = {
  project_write_file: "file_write",
  project_edit_file: "file_write",
  project_delete_file: "file_write",
  project_move_file: "file_write",
  project_run_command: "shell_repo",
};

export type ProjectAction =
  | { kind: "project_read_file"; projectId: string; path: string }
  | { kind: "project_list_files"; projectId: string; path?: string }
  | { kind: "project_search_files"; projectId: string; query: string; path?: string }
  | { kind: "project_write_file"; projectId: string; path: string; content: string }
  | { kind: "project_edit_file"; projectId: string; path: string; oldString: string; newString: string }
  | { kind: "project_delete_file"; projectId: string; path: string }
  | { kind: "project_move_file"; projectId: string; from: string; to: string }
  | { kind: "project_run_command"; projectId: string; command: string };

export interface ToolmanNodeSummary {
  id: string;
  workspaceId: string;
  name: string;
  createdBy: string;
  createdByName?: string;
  createdAt: number;
  lastConnectedAt: number | null;
  revokedAt: number | null;
  health: ToolmanNodeHealth;
}

export interface ToolmanPairing {
  id: string;
  workspaceId: string;
  nodeName: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  revokedAt: number | null;
}

export interface ToolmanPairingResponse {
  pairing: ToolmanPairing;
  pairingCode: string;
}

export interface ToolmanInstallation {
  id: string;
  nodeId: string;
  createdAt: number;
}

export interface ToolArtifactRef {
  objectKey: string;
  sha256: string;
  bytes: number;
  contentType: string;
}

export interface ToolExecution {
  id: string;
  workspaceId: string;
  channelId: string | null;
  conversationId: string | null;
  runId: string | null;
  agentId: string;
  projectId: string;
  mountId: string;
  nodeId: string;
  boardItemRef: string | null;
  action: ToolmanActionKind;
  status: ToolExecutionStatus;
  summary: string;
  inputPreview: string;
  outputPreview: string | null;
  inputArtifact: ToolArtifactRef | null;
  outputArtifact: ToolArtifactRef | null;
  exitCode: number | null;
  error: string | null;
  startedAt: number;
  completedAt: number | null;
}

export interface ToolRetentionPolicy {
  workspaceId: string;
  artifactRetentionDays: number | null;
  maxArtifactBytes: number;
  updatedBy: string;
  updatedAt: number;
}

export interface ToolmanMountReport {
  mountKey: string;
  projectName: string;
  kind: ProjectKind;
  remoteUrl: string | null;
  defaultBranch: string | null;
  headRevision: string | null;
  branch: string | null;
  cleanliness: MountCleanliness;
}

export interface ToolmanCheckoutReport {
  projectId: string;
  agentId: string;
  checkoutKey: string;
  branch: string | null;
  baseRevision: string | null;
  status: CheckoutStatus;
  lastError: string | null;
}

export function isReadOnlyToolmanAction(kind: string): boolean {
  return (TOOLMAN_READ_ACTIONS as readonly string[]).includes(kind);
}

export function requiredCapability(kind: ToolmanActionKind): WorkCapability | undefined {
  return TOOLMAN_ACTION_CAPABILITY[kind];
}

export function sanitizeRemoteUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url.replace(/:([^/@]+)@/, ":****@");
  }
}
