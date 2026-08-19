import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { configRoot, safeSegment } from "./paths";

const nodeSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  createdBy: z.string().min(1),
  createdAt: z.number(),
  revokedAt: z.number().nullable(),
});

const exchangeSchema = z.object({
  node: nodeSchema,
  installation: z.object({
    id: z.string().min(1),
    nodeId: z.string().min(1),
    createdAt: z.number(),
  }),
  installationToken: z.string().min(1),
  workspace: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  apiUrl: z.string().url(),
  wsUrl: z.string().url(),
});

const mountSchema = z.object({
  mountKey: z.string().min(1),
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  kind: z.enum(["git", "directory"]),
  absolutePath: z.string().min(1),
});

const storedSchema = exchangeSchema.extend({
  serverOrigin: z.string().url(),
  pairedAt: z.number(),
  mounts: z.array(mountSchema).default([]),
});

export type StoredToolman = z.infer<typeof storedSchema>;
export type LocalMount = z.infer<typeof mountSchema>;

export async function exchangePairing(
  serverInput: string,
  pairingCode: string,
  fetcher: typeof fetch = fetch,
): Promise<StoredToolman> {
  const serverOrigin = validatedServerOrigin(serverInput);
  const response = await fetcher(new URL("/api/toolman/pairings/exchange", serverOrigin), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairingCode }),
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("Pairing code is invalid, expired, or already used.");
    throw new Error(`Pairing server returned HTTP ${response.status}.`);
  }
  const parsed = exchangeSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Pairing server returned an invalid response.");
  verifyReturnedOrigins(serverOrigin, parsed.data.apiUrl, parsed.data.wsUrl);
  return { ...parsed.data, serverOrigin, pairedAt: Date.now(), mounts: [] };
}

export async function saveInstallation(installation: StoredToolman, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const root = configRoot(env);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  const destination = path.join(root, `${safeSegment(installation.node.id)}.json`);
  const temporary = path.join(root, `.${safeSegment(installation.node.id)}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(installation, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, destination);
  await fs.chmod(destination, 0o600);
  return destination;
}

export async function loadInstallation(
  ref?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredToolman> {
  const installations = await listInstallations(env);
  if (installations.length === 0) throw new Error("No paired Toolman node found. Run `convyio-toolman pair` first.");
  if (!ref) {
    if (installations.length === 1) return installations[0]!;
    throw new Error(`More than one paired Toolman node. Choose one:\n${formatInstallations(installations)}`);
  }
  const exact = installations.find((item) => item.node.id === ref);
  if (exact) return exact;
  const lowered = ref.toLowerCase();
  const matches = installations.filter(
    (item) => item.node.name.toLowerCase() === lowered || item.workspace.name.toLowerCase() === lowered,
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`More than one paired Toolman node matches ${JSON.stringify(ref)}. Use its id:\n${formatInstallations(matches)}`);
  }
  throw new Error(`No paired Toolman node matches ${JSON.stringify(ref)}.\n${formatInstallations(installations)}`);
}

export async function listInstallations(env: NodeJS.ProcessEnv = process.env): Promise<StoredToolman[]> {
  const root = configRoot(env);
  let files: string[];
  try {
    files = (await fs.readdir(root)).filter((file) => file.endsWith(".json")).sort();
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const loaded: StoredToolman[] = [];
  for (const file of files) {
    const parsed = storedSchema.safeParse(JSON.parse(await fs.readFile(path.join(root, file), "utf8")));
    if (parsed.success) loaded.push(parsed.data);
  }
  return loaded;
}

export async function savePairedInstallation(
  installation: StoredToolman,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const previous = (await listInstallations(env)).find((item) => item.node.id === installation.node.id);
  return saveInstallation({ ...installation, mounts: previous?.mounts ?? installation.mounts }, env);
}

export interface InstallationStatus {
  health: "ready" | "offline" | "revoked" | "unreachable";
  mounts: Array<{ mountKey: string; projectId: string }> | null;
}

export async function installationStatus(
  installation: StoredToolman,
  fetcher: typeof fetch = fetch,
): Promise<InstallationStatus> {
  try {
    const response = await fetcher(new URL("/api/toolman/installation", installation.serverOrigin), {
      headers: { Authorization: `Bearer ${installation.installationToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401) return { health: "revoked", mounts: null };
    if (!response.ok) return { health: "unreachable", mounts: null };
    const parsed = z.object({
      node: z.object({ health: z.enum(["ready", "offline"]) }),
      mounts: z.array(z.object({ mountKey: z.string().min(1), projectId: z.string().min(1) })).optional(),
    }).safeParse(await response.json());
    return parsed.success
      ? { health: parsed.data.node.health, mounts: parsed.data.mounts ?? null }
      : { health: "unreachable", mounts: null };
  } catch {
    return { health: "unreachable", mounts: null };
  }
}

export async function installationHealth(
  installation: StoredToolman,
  fetcher: typeof fetch = fetch,
): Promise<InstallationStatus["health"]> {
  return (await installationStatus(installation, fetcher)).health;
}

export async function prepareInstallationForRun(
  installation: StoredToolman,
  fetcher: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredToolman> {
  const status = await installationStatus(installation, fetcher);
  if (status.health === "revoked") {
    throw new Error(
      `Toolman node ${installation.node.name} was revoked. Create a new pairing for the same device name in Resources, then run the pair command again.`,
    );
  }
  return reconcileInstallationMounts(installation, status, env);
}

export async function reconcileInstallationMounts(
  installation: StoredToolman,
  status: InstallationStatus,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredToolman> {
  if (!status.mounts) return installation;
  const active = new Set(status.mounts.map((mount) => mount.mountKey));
  const mounts = installation.mounts.filter((mount) => active.has(mount.mountKey));
  if (mounts.length === installation.mounts.length) return installation;
  const reconciled = { ...installation, mounts };
  await saveInstallation(reconciled, env);
  return reconciled;
}

export async function clearInstallations(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Promise<string[]> {
  const installations = await listInstallations(env);
  const names: string[] = [];
  for (const installation of installations) {
    await fetcher(new URL("/api/toolman/installation", installation.serverOrigin), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${installation.installationToken}` },
    }).catch(() => undefined);
    await fs.unlink(path.join(configRoot(env), `${safeSegment(installation.node.id)}.json`));
    names.push(installation.node.name);
  }
  return names;
}

function formatInstallations(installations: StoredToolman[]): string {
  return installations
    .map((item) => `  ${item.node.id} · ${item.node.name} · ${item.workspace.name}`)
    .join("\n");
}

export function validatedServerOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Server URL must be an absolute http(s) origin.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Server URL must be http or https.");
  if (url.username || url.password) throw new Error("Server URL must not include credentials.");
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("Server URL must be an origin, with no path.");
  return url.origin;
}

function verifyReturnedOrigins(expected: string, apiUrl: string, wsUrl: string): void {
  const api = new URL(apiUrl);
  const ws = new URL(wsUrl);
  if (api.origin !== expected) throw new Error("Pairing server returned a different API origin.");
  if ((ws.protocol === "wss:" ? "https:" : "http:") + "//" + ws.host !== expected) {
    throw new Error("Pairing server returned a websocket origin that does not match.");
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "ENOENT";
}
