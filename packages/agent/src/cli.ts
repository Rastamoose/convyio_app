#!/usr/bin/env node
import { exchangePairing, listInstallationMetadata, loadInstallation, saveInstallation } from "./installation";

export async function runCli(
  argv: string[],
  io: { out(message: string): void; error(message: string): void } = {
    out: (message) => console.log(message),
    error: (message) => console.error(message),
  },
): Promise<number> {
  try {
    requireSupportedNode();
    const [command, ...args] = argv;
    switch (command) {
      case "pair":
        await pair(args, io.out);
        return 0;
      case "run": {
        if (args.length > 1 || args[0]?.startsWith("-")) throw new Error("Usage: convyio-agent run [agent-id]");
        const installation = await loadInstallation(args[0]);
        const { runAgent } = await import("./runtime");
        await runAgent({ mode: "installation", installation });
        return 0;
      }
      case "status":
        if (args.length > 0) throw new Error("Usage: convyio-agent status");
        await status(io.out);
        return 0;
      case "help":
      case "--help":
      case "-h":
      case undefined:
        io.out(usage());
        return command ? 0 : 1;
      default:
        throw new Error(`Unknown command ${JSON.stringify(command)}.\n${usage()}`);
    }
  } catch (error) {
    io.error(`convyio-agent: ${redact(error instanceof Error ? error.message : String(error))}`);
    return 1;
  }
}

async function pair(args: string[], out: (message: string) => void): Promise<void> {
  const options = parsePairArgs(args);
  const installation = await exchangePairing(options.server, options.code, options.workspace);
  await saveInstallation(installation);
  out(`Paired ${installation.agent.name} (${installation.agent.id}) with ${installation.workspace.name}.`);
  out(`Workspace: ${installation.workspacePath}`);
  out(`Start it with: convyio-agent run ${installation.agent.id}`);
}

async function status(out: (message: string) => void): Promise<void> {
  const agents = await listInstallationMetadata();
  if (agents.length === 0) {
    out("No paired agents found.");
    return;
  }
  for (const agent of agents) {
    out(JSON.stringify(agent));
  }
}

function parsePairArgs(args: string[]): { server: string; code: string; workspace: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || !["--server", "--code", "--workspace"].includes(flag)) {
      throw new Error("Usage: convyio-agent pair --server <https-origin> --code <one-time-code> --workspace <path>");
    }
    if (values.has(flag)) throw new Error(`${flag} may be provided only once.`);
    values.set(flag, value);
  }
  const server = values.get("--server");
  const code = values.get("--code");
  const workspace = values.get("--workspace");
  if (!server || !code || !workspace) {
    throw new Error("Usage: convyio-agent pair --server <https-origin> --code <one-time-code> --workspace <path>");
  }
  return { server, code, workspace };
}

function usage(): string {
  return [
    "Usage:",
    "  convyio-agent pair --server <https-origin> --code <one-time-code> --workspace <path>",
    "  convyio-agent run [agent-id]",
    "  convyio-agent status",
  ].join("\n");
}

function redact(message: string): string {
  return message
    .replace(/(pairing(?:Code| code)?|installationToken|authToken|token|secret|password)(\s*[=:]\s*|\s+)[^\s,;]+/gi, "$1$2[redacted]")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]");
}

export function requireSupportedNode(version = process.versions.node): void {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(`Node.js 22 or newer is required (current: ${version}). Upgrade Node.js and run convyio-agent again.`);
  }
}

process.exitCode = await runCli(process.argv.slice(2));
