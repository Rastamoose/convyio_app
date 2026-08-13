import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const agentSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  actorId: z.string().min(1),
  name: z.string().min(1),
  provider: z.enum(["claude", "codex"]),
  instructions: z.string(),
  requestedModel: z.string().nullable(),
  access: z.object({ mode: z.enum(["workspace", "creator", "selected"]), selectedActorIds: z.array(z.string()) }),
  configRevision: z.number().int().positive(),
  createdBy: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  revokedAt: z.number().nullable(),
});

const exchangeSchema = z.object({
  installation: z.object({
    id: z.string().min(1),
    agentId: z.string().min(1),
    createdAt: z.number(),
    lastUsedAt: z.number().nullable(),
  }),
  installationToken: z.string().min(1),
  agent: agentSchema,
  workspace: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  apiUrl: z.string().url(),
  wsUrl: z.string().url(),
});

const storedInstallationSchema = exchangeSchema.extend({
  serverOrigin: z.string().url(),
  workspacePath: z.string().min(1),
  pairedAt: z.number(),
});

export type StoredInstallation = z.infer<typeof storedInstallationSchema>;

export function installationRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
  return path.join(configHome, "convyio", "agents");
}

export async function exchangePairing(
  serverInput: string,
  pairingCode: string,
  workspaceInput: string,
  fetcher: typeof fetch = fetch,
): Promise<StoredInstallation> {
  const serverOrigin = validatedServerOrigin(serverInput);
  const workspacePath = await resolveWorkspace(workspaceInput);
  const response = await fetcher(new URL("/api/agent-pairings/exchange", serverOrigin), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairingCode }),
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("Pairing code is invalid, expired, or already used. Create a new pairing code and try again.");
    throw new Error(`Pairing server returned HTTP ${response.status}. Check the server URL and try again.`);
  }

  const parsed = exchangeSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Pairing server returned an invalid response. Upgrade convyio-agent or contact the server administrator.");
  verifyReturnedOrigins(serverOrigin, parsed.data.apiUrl, parsed.data.wsUrl);
  if (parsed.data.installation.agentId !== parsed.data.agent.id) {
    throw new Error("Pairing server returned mismatched agent metadata.");
  }
  return { ...parsed.data, serverOrigin, workspacePath, pairedAt: Date.now() };
}

export async function saveInstallation(
  installation: StoredInstallation,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const root = installationRoot(env);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  const destination = path.join(root, `${safeAgentId(installation.agent.id)}.json`);
  const temporary = path.join(root, `.${safeAgentId(installation.agent.id)}.${randomBytes(8).toString("hex")}.tmp`);
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
  agentId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredInstallation> {
  const root = installationRoot(env);
  let selected = agentId;
  if (!selected) {
    let files: string[];
    try {
      files = (await fs.readdir(root)).filter((file) => file.endsWith(".json"));
    } catch (error) {
      if (isNotFound(error)) throw new Error("No paired agents found. Run `convyio-agent pair ...` first.");
      throw error;
    }
    if (files.length === 0) throw new Error("No paired agents found. Run `convyio-agent pair ...` first.");
    if (files.length > 1) throw new Error("More than one paired agent exists. Pass an agent id: `convyio-agent run <agent-id>`.");
    selected = files[0].slice(0, -5);
  }
  const file = path.join(root, `${safeAgentId(selected)}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) throw new Error(`Agent ${JSON.stringify(selected)} is not paired on this machine.`);
    throw error;
  }
  const parsed = storedInstallationSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`Stored installation for ${JSON.stringify(selected)} is invalid. Pair the agent again.`);
  return parsed.data;
}

export async function listInstallationMetadata(env: NodeJS.ProcessEnv = process.env): Promise<Array<Record<string, unknown>>> {
  const root = installationRoot(env);
  let files: string[];
  try {
    files = (await fs.readdir(root)).filter((file) => file.endsWith(".json")).sort();
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const installations = await Promise.all(files.map((file) => loadInstallation(file.slice(0, -5), env)));
  return installations.map((item) => ({
    agentId: item.agent.id,
    name: item.agent.name,
    provider: item.agent.provider,
    server: item.serverOrigin,
    workspace: item.workspacePath,
    workspaceName: item.workspace.name,
    installationId: item.installation.id,
    pairedAt: new Date(item.pairedAt).toISOString(),
  }));
}

function validatedServerOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("--server must be a valid HTTPS origin, for example https://app.convyio.com.");
  }
  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(isLocalhost && url.protocol === "http:")) {
    throw new Error("--server must use HTTPS (plain HTTP is allowed only for localhost).");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("--server must be an origin only, without credentials, a path, query, or fragment.");
  }
  return url.origin;
}

async function resolveWorkspace(input: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await fs.realpath(path.resolve(input));
  } catch {
    throw new Error(`Workspace does not exist: ${JSON.stringify(input)}.`);
  }
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error(`Workspace is not a directory: ${JSON.stringify(input)}.`);
  return resolved;
}

function verifyReturnedOrigins(serverOrigin: string, apiUrl: string, wsUrl: string): void {
  const api = new URL(apiUrl);
  const ws = new URL(wsUrl);
  if (api.origin !== serverOrigin) throw new Error("Pairing server returned an API URL on a different origin.");
  const expectedWsProtocol = api.protocol === "https:" ? "wss:" : "ws:";
  if (ws.protocol !== expectedWsProtocol || ws.host !== api.host || ws.username || ws.password) {
    throw new Error("Pairing server returned an invalid websocket origin.");
  }
}

function safeAgentId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Agent id contains unsupported characters.");
  return value;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
