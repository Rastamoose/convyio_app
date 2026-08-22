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
 * joins active and only its creator can put it to sleep or wake it again from the web.
 */

export interface ServiceTarget {
  /** Agent name, used only for the service slug/label — cosmetic. */
  name: string;
  /** Agent id, what the service actually runs with. Two agents paired on the
   *  same machine can share a display name; ids never collide, so the
   *  unattended service can't deadlock on "more than one paired agent
   *  named X" the way a name-based target would. */
  runRef: string;
  /** Absolute path to the CLI entry this process was launched from. */
  script: string;
  /** Node binary to run it with. */
  node: string;
  /** Baked into the service definition at install time: a systemd/launchd
   *  user service starts with a clean environment, not the shell that ran
   *  `connect` — a provider whose credential is only a shell env var (no
   *  on-disk login like Claude's) would otherwise crash-loop forever unable
   *  to see it. */
  env?: Record<string, string>;
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
    ...Object.entries(target.env ?? {}).map(([key, value]) => systemdEnvironmentLine(key, value)),
    `ExecStart=${shellQuote(target.node)} ${shellQuote(target.script)} run ${shellQuote(target.runRef)}`,
    "Restart=always",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function launchAgentPlist(label: string, target: ServiceTarget): string {
  const args = [target.node, target.script, "run", target.runRef]
    .map((arg) => `      <string>${xmlEscape(arg)}</string>`)
    .join("\n");
  const envEntries = Object.entries(target.env ?? {});
  const environmentBlock = envEntries.length === 0 ? [] : [
    "    <key>EnvironmentVariables</key>",
    "    <dict>",
    ...envEntries.flatMap(([key, value]) => [
      `      <key>${xmlEscape(key)}</key>`,
      `      <string>${xmlEscape(value)}</string>`,
    ]),
    "    </dict>",
  ];
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
    ...environmentBlock,
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

/** systemd's unit-file quoting is shell-like: wrap the assignment in quotes
 *  and escape the characters that would otherwise end the quoted string. */
function systemdEnvironmentLine(key: string, value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `Environment="${key}=${escaped}"`;
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

function windowsWrapperPath(slug: string): string {
  return path.join(os.homedir(), ".convyio", "agents", `${slug}.cmd`);
}

/** `set "KEY=VALUE"` (quotes around the whole assignment) survives `&`, `|`,
 *  spaces, and the other cmd.exe metacharacters an inline command line
 *  wouldn't — a literal `"` in the value is the one thing this can't carry,
 *  which real API keys don't contain. */
export function windowsWrapperScript(target: ServiceTarget): string {
  const envLines = Object.entries(target.env ?? {}).map(([key, value]) => `set "${key}=${value}"`);
  return [
    "@echo off",
    ...envLines,
    `"${target.node}" "${target.script}" run "${target.runRef}"`,
    "",
  ].join("\r\n");
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
    await execFileAsync("systemctl", ["--user", "enable", `convyio-agent-${slug}.service`]);
    // `enable --now` only starts a unit that isn't already running, so a
    // re-pair of an already-installed agent would leave the old process
    // (old installation, old code) running forever. `restart` starts it
    // either way and always picks up the rewritten unit file.
    await execFileAsync("systemctl", ["--user", "restart", `convyio-agent-${slug}.service`]);
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
  const envEntries = Object.entries(target.env ?? {});
  let command = `"${target.node}" "${target.script}" run "${target.runRef}"`;
  if (envEntries.length > 0) {
    // schtasks's /tr is parsed by schtasks itself, not a shell — inlining
    // `set X=Y&& ...` into one quoted string nests double-quotes (already
    // wrapping the node/script paths above) in a way cmd's quoting can't be
    // trusted to survive. A wrapper .cmd file sidesteps quoting entirely:
    // schtasks just launches one already-quoted path, and the file itself
    // sets the environment before exec'ing the real command.
    const wrapperPath = windowsWrapperPath(slug);
    await fs.mkdir(path.dirname(wrapperPath), { recursive: true });
    await fs.writeFile(wrapperPath, windowsWrapperScript(target), "utf8");
    command = `"${wrapperPath}"`;
  }
  // No /rl highest: that would require an administrator, and this deliberately
  // runs as the logged-in user with no elevation.
  await execFileAsync("schtasks", [
    "/create", "/f",
    "/tn", taskName,
    "/sc", "onlogon",
    "/tr", command,
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
