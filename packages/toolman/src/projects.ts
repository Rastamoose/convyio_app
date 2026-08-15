import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createWorktree, inspectGit } from "./git";
import type { LocalMount, StoredToolman } from "./installation";
import { saveInstallation } from "./installation";
import { dataRoot, safeSegment } from "./paths";

export async function addProject(
  installation: StoredToolman,
  inputPath: string,
  name: string | undefined,
  fetcher: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ installation: StoredToolman; mount: LocalMount }> {
  const absolutePath = path.resolve(inputPath);
  const stat = await fs.stat(absolutePath);
  if (!stat.isDirectory()) throw new Error("project path must be a directory");

  let kind: "git" | "directory" = "directory";
  let remoteUrl: string | null = null;
  let defaultBranch: string | null = null;
  let headRevision: string | null = null;
  let branch: string | null = null;
  let cleanliness: "clean" | "dirty" | "unknown" = "unknown";
  try {
    const git = await inspectGit(absolutePath);
    if (git.dirty) throw new Error("Git checkout is dirty. Commit or stash your own work before attaching it.");
    kind = "git";
    remoteUrl = git.remoteUrl;
    defaultBranch = git.defaultBranch;
    headRevision = git.headRevision;
    branch = git.branch;
    cleanliness = "clean";
  } catch (error) {
    if (error instanceof Error && error.message.includes("dirty")) throw error;
  }

  const projectName = name ?? path.basename(absolutePath);
  const mountKey = randomUUID();
  const response = await fetcher(new URL("/api/toolman/mounts", installation.serverOrigin), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${installation.installationToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mountKey,
      projectName,
      kind,
      remoteUrl,
      defaultBranch,
      headRevision,
      branch,
      cleanliness,
    }),
  });
  if (!response.ok) throw new Error(`Project registration returned HTTP ${response.status}.`);
  const body = (await response.json()) as { project: { id: string; name: string } };
  const mount: LocalMount = {
    mountKey,
    projectId: body.project.id,
    projectName: body.project.name,
    kind,
    absolutePath: kind === "git" ? (await inspectGit(absolutePath)).root : absolutePath,
  };
  const next = { ...installation, mounts: [...installation.mounts.filter((item) => item.projectId !== mount.projectId), mount] };
  await saveInstallation(next, env);
  return { installation: next, mount };
}

export async function ensureWorktree(
  installation: StoredToolman,
  mount: LocalMount,
  agentId: string,
  agentName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ checkoutPath: string; branch: string | null; baseRevision: string | null }> {
  if (mount.kind !== "git") {
    return { checkoutPath: mount.absolutePath, branch: null, baseRevision: null };
  }
  const git = await inspectGit(mount.absolutePath);
  if (git.dirty) throw new Error("Base checkout became dirty; refusing to create a worktree.");
  const checkoutPath = path.join(
    dataRoot(env),
    safeSegment(installation.node.id),
    safeSegment(mount.projectName),
    safeSegment(agentName || agentId),
  );
  const branch = `convyio/${safeSegment(agentName || agentId)}`;
  try {
    await fs.stat(checkoutPath);
  } catch {
    await fs.mkdir(path.dirname(checkoutPath), { recursive: true, mode: 0o700 });
    await createWorktree(git.root, checkoutPath, branch, git.headRevision);
  }
  return { checkoutPath, branch, baseRevision: git.headRevision };
}
