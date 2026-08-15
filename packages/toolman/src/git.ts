import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sanitizeRemoteUrl } from "@workspace/shared";

const execFileAsync = promisify(execFile);

export interface GitInfo {
  root: string;
  headRevision: string;
  branch: string | null;
  defaultBranch: string | null;
  remoteUrl: string | null;
  dirty: boolean;
}

export async function inspectGit(cwd: string): Promise<GitInfo> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const dirty = (await git(root, ["status", "--porcelain"])) !== "";
  const headRevision = (await git(root, ["rev-parse", "HEAD"])).trim();
  const branch = await optionalGit(root, ["symbolic-ref", "--short", "HEAD"]);
  const remoteUrl = await optionalGit(root, ["remote", "get-url", "origin"]);
  const defaultBranch = await detectDefaultBranch(root);
  return {
    root,
    headRevision,
    branch,
    defaultBranch,
    remoteUrl: remoteUrl ? sanitizeRemoteUrl(remoteUrl) : null,
    dirty,
  };
}

export async function createWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  baseRevision: string,
): Promise<void> {
  const existing = await optionalGit(repoRoot, ["rev-parse", "--verify", branch]);
  if (existing) {
    await git(repoRoot, ["worktree", "add", "--force", worktreePath, branch]);
    return;
  }
  await git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseRevision]);
}

export async function listWorktrees(repoRoot: string): Promise<string[]> {
  const output = await optionalGit(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!output) return [];
  return output
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

async function detectDefaultBranch(root: string): Promise<string | null> {
  const symbolic = await optionalGit(root, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic?.startsWith("refs/remotes/origin/")) return symbolic.slice("refs/remotes/origin/".length);
  for (const candidate of ["main", "master"]) {
    if (await optionalGit(root, ["rev-parse", "--verify", `refs/heads/${candidate}`])) return candidate;
  }
  return null;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", timeout: 15_000 });
  return stdout;
}

async function optionalGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await git(cwd, args)).trim() || null;
  } catch {
    return null;
  }
}
