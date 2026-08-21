import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Registers a paired runner with whatever supervisor the OS already ships, so
 * it comes back on login, on crash, and on reboot without anyone opening a
 * terminal. Everything here stays in *per-user* scope on purpose: a user
 * systemd unit, a LaunchAgent, and an onlogon scheduled task all install
 * without sudo, admin, or a polkit prompt. The moment this needs elevation it
 * has stopped being something a normal user can set up unattended.
 *
 * Machine off means agent off, which is the intended behaviour — the runner
 * joins asleep and only its creator can wake it from the web.
 */

export interface ServiceTarget {
  /** Agent name as `convyio-agent run <name>` expects it. */
  name: string;
  /** Absolute path to the CLI entry this process was launched from. */
  script: string;
  /** Node binary to run it with. */
  node: string;
}

export type ServicePlatform = "linux" | "darwin" | "win32";

export function currentPlatform(): ServicePlatform {
  const platform = os.platform();
  if (platform === "linux" || platform === "darwin" || platform === "win32") return platform;
  throw new Error(`convyio-agent service is not supported on ${platform}. Run \`convyio-agent run\` instead.`);
}

/** Filesystem-safe, collision-resistant id for an agent name. */
export function serviceSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || "agent";
}

export function systemdUnit(target: ServiceTarget): string {
  return [
    "[Unit]",
    `Description=Convyio agent runner (${target.name.replace(/[\r\n]/g, " ")})`,
    "After=network-online.target",
    "Wants=network-online.target",
    // The default gives up after 5 restarts in 10s, which would strand the
    // agent in exactly the state this service exists to prevent.
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    `ExecStart=${shellQuote(target.node)} ${shellQuote(target.script)} run ${shellQuote(target.name)}`,
    "Restart=always",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function launchAgentPlist(label: string, target: ServiceTarget): string {
  const args = [target.node, target.script, "run", target.name]
    .map((arg) => `      <string>${xmlEscape(arg)}</string>`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    "    <key>Label</key>",
    `    <string>${xmlEscape(label)}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    args,
    "    </array>",
    "    <key>RunAtLoad</key>",
    "    <true/>",
    "    <key>KeepAlive</key>",
    "    <true/>",
    "  </dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** systemd needs literal quotes around arguments that contain whitespace. */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function systemdUnitPath(slug: string): string {
  const home = os.homedir();
  const base = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, "systemd", "user", `convyio-agent-${slug}.service`);
}

function launchAgentPath(label: string): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

export async function installService(
  target: ServiceTarget,
  platform: ServicePlatform = currentPlatform(),
): Promise<string> {
  const slug = serviceSlug(target.name);
  if (platform === "linux") {
    const unitPath = systemdUnitPath(slug);
    await fs.mkdir(path.dirname(unitPath), { recursive: true });
    await fs.writeFile(unitPath, systemdUnit(target), "utf8");
    await execFileAsync("systemctl", ["--user", "daemon-reload"]);
    await execFileAsync("systemctl", ["--user", "enable", "--now", `convyio-agent-${slug}.service`]);
    return unitPath;
  }
  if (platform === "darwin") {
    const label = `com.convyio.agent.${slug}`;
    const plistPath = launchAgentPath(label);
    await fs.mkdir(path.dirname(plistPath), { recursive: true });
    await fs.writeFile(plistPath, launchAgentPlist(label, target), "utf8");
    // bootout first so a reinstall replaces the old definition instead of
    // failing with "service already loaded".
    await execFileAsync("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}/${label}`]).catch(() => undefined);
    await execFileAsync("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? ""}`, plistPath]);
    return plistPath;
  }
  const taskName = `Convyio Agent ${slug}`;
  // No /rl highest: that would require an administrator, and this deliberately
  // runs as the logged-in user with no elevation.
  await execFileAsync("schtasks", [
    "/create", "/f",
    "/tn", taskName,
    "/sc", "onlogon",
    "/tr", `"${target.node}" "${target.script}" run "${target.name}"`,
  ]);
  return taskName;
}

export async function uninstallService(
  name: string,
  platform: ServicePlatform = currentPlatform(),
): Promise<void> {
  const slug = serviceSlug(name);
  if (platform === "linux") {
    await execFileAsync("systemctl", ["--user", "disable", "--now", `convyio-agent-${slug}.service`]).catch(() => undefined);
    await fs.rm(systemdUnitPath(slug), { force: true });
    await execFileAsync("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
    return;
  }
  if (platform === "darwin") {
    const label = `com.convyio.agent.${slug}`;
    await execFileAsync("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}/${label}`]).catch(() => undefined);
    await fs.rm(launchAgentPath(label), { force: true });
    return;
  }
  await execFileAsync("schtasks", ["/delete", "/f", "/tn", `Convyio Agent ${slug}`]).catch(() => undefined);
}

export function serviceStatusCommand(name: string, platform: ServicePlatform = currentPlatform()): string {
  const slug = serviceSlug(name);
  if (platform === "linux") return `journalctl --user -fu convyio-agent-${slug}`;
  if (platform === "darwin") return `launchctl print gui/$(id -u)/com.convyio.agent.${slug}`;
  return `schtasks /query /tn "Convyio Agent ${slug}"`;
}
