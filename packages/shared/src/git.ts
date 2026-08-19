export type GitProvider = "github";
export type GitRepositoryState = "cloning" | "ready" | "error";

export interface GitAccount {
  id: string;
  provider: GitProvider;
  login: string;
  displayName: string;
  avatarUrl: string | null;
  scopes: string[];
  connectedAt: number;
}

export interface GitRemoteRepository {
  providerId: string;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
  updatedAt: number;
}

export interface GitSyncStatus {
  branch: string | null;
  localHead: string | null;
  remoteHead: string | null;
  aheadCount: number;
  behindCount: number;
  hasUncommittedChanges: boolean;
  hasUntrackedFiles: boolean;
  canPush: boolean;
  pushBlockReason: string | null;
  canPull: boolean;
  pullBlockReason: string | null;
}

export interface GitRepository {
  projectId: string;
  workspaceId: string;
  connectionId: string;
  provider: GitProvider;
  providerRepositoryId: string;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  state: GitRepositoryState;
  lastSyncedAt: number | null;
  lastError: string | null;
  linkedBy: string;
  linkedAt: number;
  sync: GitSyncStatus | null;
}

export interface GitBranch {
  name: string;
  sha: string;
  isDefault: boolean;
  channelName: string | null;
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  message: string;
  authorName: string;
  authorAvatarUrl: string | null;
  committedAt: number;
  htmlUrl: string;
}

export interface GitTreeEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
  size: number | null;
  sha: string;
}

export interface GitPullRequest {
  id: string;
  number: number;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  author: string;
  head: string;
  base: string;
  updatedAt: number;
  htmlUrl: string;
}

export interface GitPullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface GitCheck {
  id: string;
  name: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string | null;
}

export interface GitIssue {
  id: string;
  number: number;
  title: string;
  state: "open" | "closed";
  author: string;
  updatedAt: number;
  htmlUrl: string;
  labels: string[];
}
