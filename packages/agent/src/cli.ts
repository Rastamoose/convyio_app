#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { clearInstallations, exchangePairing, listInstallationMetadata, loadInstallation, saveInstallation } from "./installation";

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
      case "connect":
        await connect(args, io.out);
        return 0;
      case "service":
        await service(args, io.out);
        return 0;
      case "run": {
        if (args[0]?.startsWith("-")) throw new Error("Usage: convyio-agent run [name]");
        const installation = await loadInstallation(args.length === 0 ? undefined : args.join(" "));
        const { runAgent } = await import("./runtime");
        await runAgent({ mode: "installation", installation });
        return 0;
      }
      case "status":
        if (args.length > 0) throw new Error("Usage: convyio-agent status");
        await status(io.out);
        return 0;
      case "unpair":
        if (args.length > 0) throw new Error("Usage: convyio-agent unpair");
        await unpair(io.out);
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
  out(`Start it with: convyio-agent run ${/\s/.test(installation.agent.name) ? `"${installation.agent.name}"` : installation.agent.name}`);
}

/**
 * The one-command path: pair, then hand the runner to the OS supervisor so it
 * is simply *there* on every login instead of something to remember to start.
 * It joins active by default — putting it to sleep is the creator's call, from the web.
 */
async function connect(args: string[], out: (message: string) => void): Promise<void> {
  const options = parsePairArgs(args);
  const installation = await exchangePairing(options.server, options.code, options.workspace);
  await saveInstallation(installation);
  const name = installation.agent.name;
  out(`Paired ${name} (${installation.agent.id}) with ${installation.workspace.name}.`);

  const { installService, serviceStatusCommand } = await import("./service");
  try {
    const location = await installService({ name, runRef: installation.agent.id, script: cliEntrypoint(), node: process.execPath });
    out(`Installed a login service for ${name} (${location}).`);
    out(`It now starts on login and restarts on crash. Logs: ${serviceStatusCommand(name)}`);
  } catch (error) {
    // Pairing already succeeded and is worth keeping; only the convenience
    // layer failed, and `run` still works by hand.
    out(`Paired, but the login service could not be installed: ${error instanceof Error ? error.message : String(error)}`);
    out(`Start it manually with: convyio-agent run ${quoted(name)}`);
    return;
  }
  out("Open Convyio and press Wake up on the agent to start it. Only you can, as its creator.");
}

async function service(args: string[], out: (message: string) => void): Promise<void> {
  const [action, ...rest] = args;
  const name = rest.length === 0 ? undefined : rest.join(" ");
  if (action === "install") {
    const installation = await loadInstallation(name);
    const { installService, serviceStatusCommand } = await import("./service");
    const location = await installService({
      name: installation.agent.name,
      runRef: installation.agent.id,
      script: cliEntrypoint(),
      node: process.execPath,
    });
    out(`Installed a login service for ${installation.agent.name} (${location}).`);
    out(`Logs: ${serviceStatusCommand(installation.agent.name)}`);
    return;
  }
  if (action === "uninstall") {
    const installation = await loadInstallation(name);
    const { uninstallService } = await import("./service");
    await uninstallService(installation.agent.name);
    out(`Removed the login service for ${installation.agent.name}. The pairing is untouched.`);
    return;
  }
  throw new Error("Usage: convyio-agent service install|uninstall [name]");
}

/** Resolve the real bundle path: a global install puts a symlink on PATH, and
 *  a supervisor started years later must not depend on that link surviving. */
function cliEntrypoint(): string {
  const entry = process.argv[1];
  if (!entry) throw new Error("could not determine the convyio-agent entrypoint");
  return realpathSync(entry);
}

function quoted(name: string): string {
  return /\s/.test(name) ? `"${name}"` : name;
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

async function unpair(out: (message: string) => void): Promise<void> {
  const names = await clearInstallations();
  if (names.length === 0) {
    out("No paired agents to clear.");
    return;
  }
  const { uninstallService } = await import("./service");
  for (const name of names) {
    // Credentials are already gone, so a login service left running would
    // just crash-loop forever trying to use them. Best-effort: a service
    // may never have been installed for this agent.
    await uninstallService(name).catch(() => undefined);
  }
  out(`Cleared ${names.length} paired agent${names.length === 1 ? "" : "s"}:`);
  for (const name of names) out(`  ${name}`);
}

function parsePairArgs(args: string[]): { server: string; code: string; workspace: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || !["--server", "--code", "--workspace"].includes(flag)) {
      throw new Error("Usage: convyio-agent pair --server <https-origin> --code <one-time-code> [--workspace <path>]");
    }
    if (values.has(flag)) throw new Error(`${flag} may be provided only once.`);
    values.set(flag, value);
  }
  const server = values.get("--server");
  const code = values.get("--code");
  if (!server || !code) {
    throw new Error("Usage: convyio-agent pair --server <https-origin> --code <one-time-code> [--workspace <path>]");
  }
  return { server, code, workspace: values.get("--workspace") ?? process.cwd() };
}

function usage(): string {
  return [
    "Usage:",
    "  convyio-agent connect --server <https-origin> --code <one-time-code> [--workspace <path>]",
    "      Pair, then install a login service so the runner is always there.",
    "  convyio-agent pair --server <https-origin> --code <one-time-code> [--workspace <path>]",
    "  convyio-agent run [name]",
    "  convyio-agent service install|uninstall [name]",
    "  convyio-agent status",
    "  convyio-agent unpair",
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
