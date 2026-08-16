#!/usr/bin/env node
import path from "node:path";
import { clearInstallations, exchangePairing, listInstallations, loadInstallation, saveInstallation } from "./installation";
import { addProject } from "./projects";

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
      case "pair": {
        const options = parseFlags(args, ["--server", "--code"]);
        const installation = await exchangePairing(required(options, "--server"), required(options, "--code"));
        await saveInstallation(installation);
        io.out(`Paired Toolman node ${installation.node.name} with ${installation.workspace.name}.`);
        io.out("Attach a project with: convyio-toolman project add <path>");
        return 0;
      }
      case "project": {
        if (args[0] !== "add" || !args[1]) {
          throw new Error("Usage: convyio-toolman project add <path> [--name <name>] [--node <name-or-id>]");
        }
        const flags = parseFlags(args.slice(2), ["--name", "--node"]);
        const installation = await loadInstallation(flags.get("--node"));
        const added = await addProject(installation, path.resolve(args[1]), flags.get("--name"));
        io.out(`Attached ${added.mount.projectName} (${added.mount.kind}).`);
        return 0;
      }
      case "run": {
        if (args[0]?.startsWith("-")) throw new Error("Usage: convyio-toolman run [name-or-id]");
        const installation = await loadInstallation(args.length ? args.join(" ") : undefined);
        const { runNode } = await import("./runtime");
        io.out(`Toolman node ${installation.node.name} connecting to ${installation.workspace.name}…`);
        await runNode(installation);
        return 0;
      }
      case "status": {
        const installations = await listInstallations();
        if (installations.length === 0) {
          io.out("No paired Toolman node.");
          return 0;
        }
        for (const item of installations) {
          io.out(`${item.node.name} · ${item.workspace.name} · ${item.mounts.length} project(s)`);
          for (const mount of item.mounts) io.out(`  ${mount.projectName} (${mount.kind})`);
        }
        return 0;
      }
      case "unpair": {
        const names = await clearInstallations();
        io.out(names.length === 0 ? "No paired Toolman node to clear." : `Cleared ${names.join(", ")}.`);
        return 0;
      }
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
    io.error(`convyio-toolman: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function parseFlags(args: string[], allowed: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || !allowed.includes(flag)) throw new Error(usage());
    values.set(flag, value);
  }
  return values;
}

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value) throw new Error(usage());
  return value;
}

function usage(): string {
  return [
    "Usage:",
    "  convyio-toolman pair --server <https-origin> --code <one-time-code>",
    "  convyio-toolman project add <path> [--name <name>] [--node <name-or-id>]",
    "  convyio-toolman run [name-or-id]",
    "  convyio-toolman status",
    "  convyio-toolman unpair",
  ].join("\n");
}

export function requireSupportedNode(version = process.versions.node): void {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(`Node.js 22 or newer is required (current: ${version}).`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
