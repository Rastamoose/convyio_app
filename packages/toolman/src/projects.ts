import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { LocalMount, StoredToolman } from "./installation";
import { saveInstallation } from "./installation";

/**
 * Registers a local folder as a live mount. The folder is the resource;
 * git state is irrelevant here — later git integration is a different pipe.
 */
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
      kind: "directory",
    }),
  });
  if (!response.ok) throw new Error(`Project registration returned HTTP ${response.status}.`);
  const body = (await response.json()) as { project: { id: string; name: string } };
  const mount: LocalMount = {
    mountKey,
    projectId: body.project.id,
    projectName: body.project.name,
    kind: "directory",
    absolutePath,
  };
  const next = { ...installation, mounts: [...installation.mounts.filter((item) => item.projectId !== mount.projectId), mount] };
  await saveInstallation(next, env);
  return { installation: next, mount };
}
